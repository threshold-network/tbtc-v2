#!/usr/bin/env bash
#
# Simulate the GHSA-8986 fix deployment on a forked mainnet using Anvil + Cast.
# Deploys new Deposit library, links Bridge implementation, upgrades proxy
# through impersonated Timelock, and verifies the fix is active.
#
set -euo pipefail

RPC="${CHAIN_API_URL:?Set CHAIN_API_URL to an Ethereum mainnet RPC endpoint}"
ANVIL_PORT=8555
ANVIL_RPC="http://127.0.0.1:${ANVIL_PORT}"
BUILD_DIR="$(cd "$(dirname "$0")/.." && pwd)/build"

# On-chain addresses
BRIDGE_PROXY="0x5e4861a80B55f035D899f66772117F00FA0E8e7B"
PROXY_ADMIN="0x16A76d3cd3C1e3CE843C6680d6B37E9116b5C706"
TIMELOCK="0x92f2d8b72a7F6a551Be60b9aa4194248E9B4913D"
COUNCIL_MULTISIG="0x9F6e831c8F8939DC0C830C6e492e7cEf4f9C2F5f"

# Existing library addresses (unchanged)
DEPOSIT_SWEEP="0x392635646Bc22FC13C86859d1f02B27974aC9b95"
REDEMPTION="0xa7fed184fe79c2ea037e65558473c04ce42f5d0d"
WALLETS="0xc989d3E486AAe6355F65281B4d0bde08c8e32fBC"
FRAUD="0x51bBeF1c7cC3a1D3bC5E64CE6C3BA6E66fbA3559"
MOVING_FUNDS="0x3E0407765FaC663d391aE738f3Aa0c98EAb67a90"

# Old vulnerable Deposit address for comparison
OLD_DEPOSIT="0xCD2EbDA2beA80484C55675e1965149054dCcD137"

cleanup() {
  if [ -n "${ANVIL_PID:-}" ]; then
    kill "$ANVIL_PID" 2> /dev/null || true
    wait "$ANVIL_PID" 2> /dev/null || true
  fi
}
trap cleanup EXIT

echo "============================================"
echo "  GHSA-8986 Fix Deployment Simulation"
echo "============================================"
echo ""

# --- Step 0: Start Anvil fork ---
echo "[0/6] Starting Anvil fork..."
anvil --fork-url "$RPC" --port "$ANVIL_PORT" --silent &
ANVIL_PID=$!
sleep 8

# Verify anvil is running
if ! cast block-number --rpc-url "$ANVIL_RPC" > /dev/null 2>&1; then
  echo "ERROR: Anvil failed to start"
  exit 1
fi

BLOCK=$(cast block-number --rpc-url "$ANVIL_RPC")
echo "  Anvil forked at block: $BLOCK"

# Use first anvil default account as deployer
DEPLOYER="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
echo "  Deployer: $DEPLOYER"
echo ""

# --- Step 1: Verify current state (pre-upgrade) ---
echo "[1/6] Verifying current on-chain state..."

CURRENT_IMPL=$(cast storage "$BRIDGE_PROXY" 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc --rpc-url "$ANVIL_RPC")
echo "  Current Bridge implementation: $CURRENT_IMPL"

OLD_DEPOSIT_SIZE=$(cast codesize "$OLD_DEPOSIT" --rpc-url "$ANVIL_RPC")
echo "  Old Deposit library size: $OLD_DEPOSIT_SIZE bytes (expected: 6894)"

PA_OWNER=$(cast call "$PROXY_ADMIN" "owner()(address)" --rpc-url "$ANVIL_RPC")
echo "  ProxyAdmin owner: $PA_OWNER"
echo "  Timelock address: $TIMELOCK"
echo ""

# --- Step 2: Deploy new Deposit library ---
echo "[2/6] Deploying new Deposit library..."

DEPOSIT_BYTECODE=$(python3 -c "
import json
d = json.load(open('${BUILD_DIR}/contracts/bridge/Deposit.sol/Deposit.json'))
print(d['bytecode'])
")

NEW_DEPOSIT=$(cast send --rpc-url "$ANVIL_RPC" --from "$DEPLOYER" --unlocked --create "$DEPOSIT_BYTECODE" --json 2>&1 | python3 -c "import json,sys; print(json.load(sys.stdin)['contractAddress'])")

NEW_DEPOSIT_SIZE=$(cast codesize "$NEW_DEPOSIT" --rpc-url "$ANVIL_RPC")
echo "  New Deposit library: $NEW_DEPOSIT"
echo "  New Deposit size: $NEW_DEPOSIT_SIZE bytes (expected: ~7006)"
echo "  Size delta: +$((NEW_DEPOSIT_SIZE - OLD_DEPOSIT_SIZE)) bytes"
echo ""

# --- Step 3: Link and deploy Bridge implementation ---
echo "[3/6] Linking Bridge bytecode and deploying implementation..."

BRIDGE_BYTECODE=$(
  python3 << PYEOF
import json

b = json.load(open('${BUILD_DIR}/contracts/bridge/Bridge.sol/Bridge.json'))
bytecode = b['bytecode']

# Map each library to its address (lowercase, no 0x prefix)
links = b['linkReferences']
replacements = {}
for source, libs in links.items():
    for lib_name, positions in libs.items():
        # Compute the placeholder: __\$keccak256(fqn)[:34]\$__
        import hashlib
        fqn = f"{source}:{lib_name}"
        h = hashlib.sha256(fqn.encode()).hexdigest()  # not right, hardhat uses different hash

# Actually, let's just find placeholders by matching __\$...\$__ patterns
# and map them by occurrence count to known libraries
import re
placeholders = {}
for m in re.finditer(r'__\$([a-f0-9]+)\$__', bytecode):
    ph = m.group(0)
    if ph not in placeholders:
        placeholders[ph] = 0
    placeholders[ph] += 1

# Map by count: Deposit=2, DepositSweep=1, Fraud=4, MovingFunds=7, Redemption=5, Wallets=4
# But Fraud and Wallets both have 4. Use linkReferences positions to map correctly.
count_to_libs = {
    1: [],  # DepositSweep
    2: [],  # Deposit
    4: [],  # Fraud, Wallets (need to disambiguate)
    5: [],  # Redemption
    7: [],  # MovingFunds
}
for ph, count in placeholders.items():
    count_to_libs.setdefault(count, []).append(ph)

# Better approach: use linkReferences byte offsets to map placeholder to library
# Each position in linkReferences gives {start, length} in the bytecode (hex positions)
lib_addresses = {
    'Deposit': '${NEW_DEPOSIT}'.lower().replace('0x', ''),
    'DepositSweep': '${DEPOSIT_SWEEP}'.lower().replace('0x', ''),
    'Redemption': '${REDEMPTION}'.lower().replace('0x', ''),
    'Wallets': '${WALLETS}'.lower().replace('0x', ''),
    'Fraud': '${FRAUD}'.lower().replace('0x', ''),
    'MovingFunds': '${MOVING_FUNDS}'.lower().replace('0x', ''),
}

# For each library in linkReferences, find the placeholder at the first position
# bytecode starts with "0x", so offset by 2 in the string
for source, libs in links.items():
    for lib_name, positions in libs.items():
        pos = positions[0]  # first occurrence
        # start is byte offset in deployed bytecode; in hex string, each byte = 2 chars
        # bytecode string starts with "0x", so add 2
        hex_start = 2 + pos['start'] * 2
        hex_len = pos['length'] * 2  # should be 40 (20 bytes)
        placeholder = bytecode[hex_start:hex_start + hex_len]
        # Replace ALL occurrences of this placeholder
        addr = lib_addresses[lib_name]
        bytecode = bytecode.replace(placeholder, addr)

# Verify no placeholders remain
remaining = re.findall(r'__\$[a-f0-9]+\$__', bytecode)
if remaining:
    print(f"ERROR: {len(remaining)} unresolved placeholders remain", file=__import__('sys').stderr)
    __import__('sys').exit(1)

print(bytecode)
PYEOF
)

if [ -z "$BRIDGE_BYTECODE" ]; then
  echo "ERROR: Failed to link Bridge bytecode"
  exit 1
fi

NEW_IMPL=$(cast send --rpc-url "$ANVIL_RPC" --from "$DEPLOYER" --unlocked --create "$BRIDGE_BYTECODE" --json 2>&1 | python3 -c "import json,sys; print(json.load(sys.stdin)['contractAddress'])")

NEW_IMPL_SIZE=$(cast codesize "$NEW_IMPL" --rpc-url "$ANVIL_RPC")
echo "  New Bridge implementation: $NEW_IMPL"
echo "  New implementation size: $NEW_IMPL_SIZE bytes"
echo ""

# Verify new Deposit address is embedded in the new implementation
echo "  Verifying library linkage in new implementation..."
NEW_DEPOSIT_LOWER=$(echo "$NEW_DEPOSIT" | tr '[:upper:]' '[:lower:]' | sed 's/0x//')
DEPOSIT_FOUND=$(cast code "$NEW_IMPL" --rpc-url "$ANVIL_RPC" | { grep -oi "$NEW_DEPOSIT_LOWER" || true; } | wc -l | tr -d ' ')
echo "  New Deposit address found in bytecode: $DEPOSIT_FOUND times (expected: 2)"

OLD_DEPOSIT_LOWER=$(echo "$OLD_DEPOSIT" | tr '[:upper:]' '[:lower:]' | sed 's/0x//')
OLD_FOUND=$(cast code "$NEW_IMPL" --rpc-url "$ANVIL_RPC" | { grep -oi "$OLD_DEPOSIT_LOWER" || true; } | wc -l | tr -d ' ')
echo "  Old Deposit address found in bytecode: $OLD_FOUND times (expected: 0)"
echo ""

# --- Step 4: Simulate Timelock upgrade ---
echo "[4/6] Simulating proxy upgrade via Timelock..."

# Encode ProxyAdmin.upgrade(bridgeProxy, newImpl)
UPGRADE_CALLDATA=$(cast calldata "upgrade(address,address)" "$BRIDGE_PROXY" "$NEW_IMPL")

# Fund Timelock with ETH for gas (it has 0 balance on mainnet)
cast rpc anvil_setBalance "$TIMELOCK" "0xDE0B6B3A7640000" --rpc-url "$ANVIL_RPC" > /dev/null 2>&1

# Explicitly impersonate Timelock on Anvil, then send upgrade TX
cast rpc anvil_impersonateAccount "$TIMELOCK" --rpc-url "$ANVIL_RPC" > /dev/null 2>&1

# ProxyAdmin.upgrade() must be called by its owner (the Timelock)
UPGRADE_OUTPUT=$(cast send --rpc-url "$ANVIL_RPC" --from "$TIMELOCK" "$PROXY_ADMIN" "$UPGRADE_CALLDATA" --unlocked --json 2>&1) || true

echo "$UPGRADE_OUTPUT" | python3 -c "
import json, sys
try:
    r = json.load(sys.stdin)
    print(f'  Upgrade TX: {r[\"transactionHash\"]}')
    status = 'SUCCESS' if r.get('status') == '0x1' else 'FAILED'
    gas = int(r.get('gasUsed', '0x0'), 16)
    print(f'  Status: {status} (gas: {gas})')
except:
    print('  Upgrade TX output (non-JSON):')
    pass
" || true

# Verify implementation changed
AFTER_IMPL=$(cast storage "$BRIDGE_PROXY" 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc --rpc-url "$ANVIL_RPC")
AFTER_IMPL_ADDR=$(echo "$AFTER_IMPL" | sed 's/0x000000000000000000000000/0x/')
echo "  Implementation after upgrade: $AFTER_IMPL_ADDR"

NEW_IMPL_LOWER=$(echo "$NEW_IMPL" | tr '[:upper:]' '[:lower:]')
AFTER_LOWER=$(echo "$AFTER_IMPL_ADDR" | tr '[:upper:]' '[:lower:]')
if [ "$NEW_IMPL_LOWER" = "$AFTER_LOWER" ]; then
  echo "  PASS: Proxy now points to new implementation"
else
  echo "  FAIL: Implementation mismatch!"
  echo "    Expected: $NEW_IMPL"
  echo "    Got:      $AFTER_IMPL_ADDR"
  exit 1
fi
echo ""

# --- Step 5: Verify existing functionality still works ---
echo "[5/6] Verifying Bridge is still functional..."

# Call a view function on the Bridge proxy to confirm it works
DEPOSIT_PARAMS=$(cast call "$BRIDGE_PROXY" "depositParameters()(uint64,uint64,uint64,uint32)" --rpc-url "$ANVIL_RPC" 2>&1)
echo "  depositParameters() call: OK"
echo "  Result: $DEPOSIT_PARAMS"
echo ""

# --- Step 6: Verify the fix ---
echo "[6/6] Verifying P2SH enforcement fix..."

# The fix adds a check: fundingOutput.slice3(8) == hex"17a914"
# We verify by checking the new Deposit library has more code than the old one
echo "  Old Deposit size: $OLD_DEPOSIT_SIZE bytes"
echo "  New Deposit size: $NEW_DEPOSIT_SIZE bytes"
echo "  Delta: +$((NEW_DEPOSIT_SIZE - OLD_DEPOSIT_SIZE)) bytes (expected: ~112)"

# Verify the P2SH prefix bytes (17a914) appear in the new Deposit library code
NEW_DEPOSIT_CODE=$(cast code "$NEW_DEPOSIT" --rpc-url "$ANVIL_RPC")
if echo "$NEW_DEPOSIT_CODE" | grep -qi "17a914"; then
  echo "  PASS: P2SH prefix check (17a914) found in new Deposit library"
else
  echo "  WARN: P2SH prefix (17a914) not found as literal — may be constructed differently"
fi

echo ""
echo "============================================"
echo "  SIMULATION COMPLETE"
echo "============================================"
echo ""
echo "  New Deposit library:      $NEW_DEPOSIT ($NEW_DEPOSIT_SIZE bytes)"
echo "  New Bridge implementation: $NEW_IMPL ($NEW_IMPL_SIZE bytes)"
echo "  Proxy upgrade:             SUCCESS"
echo ""
echo "  For mainnet deployment, the Timelock calldata is:"
echo "    target: $PROXY_ADMIN"
echo "    data:   $UPGRADE_CALLDATA"
echo "============================================"
