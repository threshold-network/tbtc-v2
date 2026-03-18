#!/usr/bin/env bash
# Verify Sepolia Bridge state after the MintBurnController upgrade.
#
# Reads all relevant on-chain values, compares against the pre-upgrade snapshot
# recorded in Phase 1, and validates that the upgrade applied correctly.
#
# Required env vars (set in .env or export before running):
#   RPC             — Sepolia archive RPC URL
#   IMPL_BEFORE     — Implementation address recorded by snapshot.sh (Phase 1)
#   GOVERNANCE_ADDRESS — Governance address recorded by snapshot.sh (Phase 1)
#   PROXY_ADMIN_ADDRESS — ProxyAdmin address recorded by snapshot.sh (Phase 1)
#
# Usage:
#   source .env && bash scripts/verify-upgrade.sh

set -euo pipefail

# ── Constants ──────────────────────────────────────────────────────────────────
BRIDGE="0x9b1a7fE5a16A15F2f9475C5B231750598b113403"
IMPL_SLOT="0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
ADMIN_SLOT="0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"
ZERO="0x0000000000000000000000000000000000000000"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗ ABORT: $1${NC}"; exit 1; }
warn() { echo -e "  ${YELLOW}~${NC} $1"; }

lower() { echo "$1" | tr '[:upper:]' '[:lower:]'; }

# ── Preflight ──────────────────────────────────────────────────────────────────
echo ""
echo "=== Post-upgrade verification: Bridge MintBurnController ==="
echo ""

[[ -z "${RPC:-}"                ]] && fail "RPC is not set"
[[ -z "${IMPL_BEFORE:-}"        ]] && fail "IMPL_BEFORE is not set (copy from Phase 1 snapshot)"
[[ -z "${GOVERNANCE_ADDRESS:-}" ]] && fail "GOVERNANCE_ADDRESS is not set (copy from Phase 1 snapshot)"
[[ -z "${PROXY_ADMIN_ADDRESS:-}" ]] && fail "PROXY_ADMIN_ADDRESS is not set (copy from Phase 1 snapshot)"

# ── 1. Implementation changed ──────────────────────────────────────────────────
echo "[ Implementation ]"

IMPL_AFTER=$(cast storage "$BRIDGE" "$IMPL_SLOT" --rpc-url "$RPC")
pass "Implementation after upgrade : $IMPL_AFTER"

if [[ "$(lower "$IMPL_AFTER")" == "$(lower "$IMPL_BEFORE")" ]]; then
  fail "Implementation unchanged (still $IMPL_BEFORE). Upgrade did not execute."
fi
pass "Implementation changed from $IMPL_BEFORE"

# ── 2. New controller methods exist ───────────────────────────────────────────
echo ""
echo "[ MintBurnController methods ]"

CONTROLLER=$(cast call "$BRIDGE" "getMintingController()(address)" --rpc-url "$RPC" 2>/dev/null \
  || fail "getMintingController() reverted — new implementation was not applied")
pass "getMintingController()        : $CONTROLLER"

if [[ "$(lower "$CONTROLLER")" != "$(lower "$ZERO")" ]]; then
  warn "getMintingController() returned non-zero ($CONTROLLER). Expected address(0) unless set pre-upgrade."
fi

# controllerIncreaseBalance must revert with the access-control message.
REVERT_MSG=$(cast call "$BRIDGE" \
  "controllerIncreaseBalance(address,uint256)" \
  "0x0000000000000000000000000000000000000001" 1 \
  --rpc-url "$RPC" 2>&1 || true)
if echo "$REVERT_MSG" | grep -qi "Caller is not the authorized controller"; then
  pass "controllerIncreaseBalance()   : reverts with correct message"
else
  fail "controllerIncreaseBalance() did not revert with expected message. Got: $REVERT_MSG"
fi

# ── 3. PR#933 fix preserved ────────────────────────────────────────────────────
echo ""
echo "[ PR#933 rebate fix ]"

REBATE=$(cast call "$BRIDGE" "getRebateStaking()(address)" --rpc-url "$RPC")
if [[ "$(lower "$REBATE")" != "$(lower "$ZERO")" ]]; then
  fail "getRebateStaking() returned $REBATE — expected address(0). PR#933 repair was overwritten."
fi
pass "getRebateStaking()            : $REBATE (zero — OK)"

# ── 4. Governance unchanged ────────────────────────────────────────────────────
echo ""
echo "[ Governance ]"

GOVERNANCE_AFTER=$(cast call "$BRIDGE" "governance()(address)" --rpc-url "$RPC")
if [[ "$(lower "$GOVERNANCE_AFTER")" != "$(lower "$GOVERNANCE_ADDRESS")" ]]; then
  fail "governance() changed (got $GOVERNANCE_AFTER, expected $GOVERNANCE_ADDRESS)"
fi
pass "governance()                  : $GOVERNANCE_AFTER (unchanged)"

# ── 5. ProxyAdmin unchanged ────────────────────────────────────────────────────
echo ""
echo "[ ProxyAdmin ]"

ADMIN_SLOT_VALUE=$(cast storage "$BRIDGE" "$ADMIN_SLOT" --rpc-url "$RPC")
PROXY_ADMIN_AFTER=$(cast --to-checksum-address "0x${ADMIN_SLOT_VALUE: -40}")
if [[ "$(lower "$PROXY_ADMIN_AFTER")" != "$(lower "$PROXY_ADMIN_ADDRESS")" ]]; then
  fail "ProxyAdmin changed (got $PROXY_ADMIN_AFTER, expected $PROXY_ADMIN_ADDRESS)"
fi
pass "ProxyAdmin                    : $PROXY_ADMIN_AFTER (unchanged)"

# ── Summary ────────────────────────────────────────────────────────────────────
echo ""
echo "=== All post-upgrade checks passed ==="
echo ""
echo "  IMPL_BEFORE          = $IMPL_BEFORE"
echo "  IMPL_AFTER           = $IMPL_AFTER"
echo "  getMintingController = $CONTROLLER"
echo "  getRebateStaking     = $REBATE"
echo "  governance           = $GOVERNANCE_AFTER"
echo "  ProxyAdmin           = $PROXY_ADMIN_AFTER"
echo ""
