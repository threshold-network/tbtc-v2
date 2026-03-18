#!/usr/bin/env bash
# Snapshot current Sepolia Bridge state before the MintBurnController upgrade.
#
# Reads all relevant on-chain values, validates abort conditions, and prints
# a summary that should be recorded before running the upgrade.
#
# Required env vars (set in .env or export before running):
#   RPC             — Sepolia archive RPC URL
#   PROXY_ADMIN_PK  — Private key of the ProxyAdmin owner
#
# Usage:
#   source .env && bash scripts/snapshot.sh

set -euo pipefail

# ── Constants ──────────────────────────────────────────────────────────────────
BRIDGE="0x9b1a7fE5a16A15F2f9475C5B231750598b113403"
IMPL_SLOT="0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
ADMIN_SLOT="0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"

LIBRARIES=(
  "Deposit:0xad39ED2D3aF448C14b960746F1F63451D366000c"
  "DepositSweep:0x762B5E9dE8b3cF81d71Cc6f5ea1a9a7B7Eb7b8cB"
  "Redemption:0x88BEEF1F01cD6c74063E398da1114eb4B8C985a6"
  "Wallets:0x21eB46af48705A52f122931ddb8E9df036D8F2c1"
  "Fraud:0xe60FFb5037aC31603B1AeDEf440fFad088dF0a17"
  "MovingFunds:0xbF138155D789007c43dda3cc39B75fB70991e7E3"
)

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗ ABORT: $1${NC}"; exit 1; }
warn() { echo -e "  ${YELLOW}~${NC} $1"; }

# ── Preflight ──────────────────────────────────────────────────────────────────
echo ""
echo "=== Pre-upgrade snapshot: Bridge MintBurnController ==="
echo ""

[[ -z "${RPC:-}" ]]            && fail "RPC is not set"
[[ -z "${PROXY_ADMIN_PK:-}" ]] && fail "PROXY_ADMIN_PK is not set"

# ── Implementation slot ────────────────────────────────────────────────────────
echo "[ Implementation ]"
IMPL_BEFORE=$(cast storage "$BRIDGE" "$IMPL_SLOT" --rpc-url "$RPC")
pass "Current implementation : $IMPL_BEFORE"

# ── ProxyAdmin address ─────────────────────────────────────────────────────────
echo ""
echo "[ ProxyAdmin ]"
ADMIN_SLOT_VALUE=$(cast storage "$BRIDGE" "$ADMIN_SLOT" --rpc-url "$RPC")
PROXY_ADMIN_ADDRESS=$(cast --to-checksum-address "0x${ADMIN_SLOT_VALUE: -40}")
pass "ProxyAdmin address     : $PROXY_ADMIN_ADDRESS"

PROXY_ADMIN_OWNER=$(cast call "$PROXY_ADMIN_ADDRESS" "owner()(address)" --rpc-url "$RPC")
pass "ProxyAdmin owner       : $PROXY_ADMIN_OWNER"

SIGNER_ADDRESS=$(cast wallet address --private-key "$PROXY_ADMIN_PK")
pass "Signer address (key)   : $SIGNER_ADDRESS"

if [[ "$(echo "$SIGNER_ADDRESS" | tr '[:upper:]' '[:lower:]')" != "$(echo "$PROXY_ADMIN_OWNER" | tr '[:upper:]' '[:lower:]')" ]]; then
  fail "PROXY_ADMIN_PK does not control the ProxyAdmin (got $SIGNER_ADDRESS, expected $PROXY_ADMIN_OWNER)"
fi
pass "Key matches ProxyAdmin owner"

# ── Bridge state ───────────────────────────────────────────────────────────────
echo ""
echo "[ Bridge state ]"

REBATE=$(cast call "$BRIDGE" "getRebateStaking()(address)" --rpc-url "$RPC")
if [[ "$(echo "$REBATE" | tr '[:upper:]' '[:lower:]')" != "0x0000000000000000000000000000000000000000" ]]; then
  fail "getRebateStaking() returned $REBATE — expected address(0). Do not upgrade."
fi
pass "getRebateStaking()     : $REBATE (zero — OK)"

CONTROLLER_BEFORE=$(cast call "$BRIDGE" "getMintingController()(address)" --rpc-url "$RPC" 2>/dev/null || echo "reverted")
if [[ "$CONTROLLER_BEFORE" == "reverted" ]]; then
  warn "getMintingController() reverted — current impl is PR#933 (expected)"
else
  pass "getMintingController() : $CONTROLLER_BEFORE"
fi

GOVERNANCE=$(cast call "$BRIDGE" "governance()(address)" --rpc-url "$RPC")
pass "governance()           : $GOVERNANCE"

# ── Library code checks ────────────────────────────────────────────────────────
echo ""
echo "[ Libraries ]"

for ENTRY in "${LIBRARIES[@]}"; do
  NAME="${ENTRY%%:*}"
  ADDR="${ENTRY##*:}"
  CODE=$(cast code "$ADDR" --rpc-url "$RPC")
  if [[ "$CODE" == "0x" || -z "$CODE" ]]; then
    fail "Library $NAME at $ADDR has no code on-chain"
  fi
  pass "$NAME ($ADDR) — ${#CODE} chars"
done

# ── Summary ────────────────────────────────────────────────────────────────────
echo ""
echo "=== Snapshot complete — record these values ==="
echo ""
echo "  IMPL_BEFORE          = $IMPL_BEFORE"
echo "  PROXY_ADMIN_ADDRESS  = $PROXY_ADMIN_ADDRESS"
echo "  PROXY_ADMIN_OWNER    = $PROXY_ADMIN_OWNER"
echo "  GOVERNANCE_ADDRESS   = $GOVERNANCE"
echo "  CONTROLLER_BEFORE    = $CONTROLLER_BEFORE"
echo ""
echo "All pre-flight checks passed. Safe to proceed with the upgrade."
echo ""
