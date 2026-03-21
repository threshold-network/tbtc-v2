#!/usr/bin/env bash
# Verification tests for deploy script deprecation (quarantine).
# Validates that three deploy scripts have been renamed with _DEPRECATED
# suffix and contain appropriate warning headers.

set -euo pipefail

# Resolve deploy directory relative to this script's location so the
# test is portable across machines and CI environments.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$SCRIPT_DIR/../deploy"

PASS=0
FAIL=0
TOTAL=0

# ---------------------------------------------------------------------------
# Assertion helpers
# ---------------------------------------------------------------------------

assert_file_not_exists() {
  TOTAL=$((TOTAL + 1))
  local file="$1"
  local label="$2"
  if [ -f "$file" ]; then
    echo "FAIL: $label -- file should not exist: $file"
    FAIL=$((FAIL + 1))
    return 1
  else
    echo "PASS: $label"
    PASS=$((PASS + 1))
  fi
}

assert_file_exists() {
  TOTAL=$((TOTAL + 1))
  local file="$1"
  local label="$2"
  if [ -f "$file" ]; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label -- file not found: $file"
    FAIL=$((FAIL + 1))
    return 1
  fi
}

assert_file_contains_in_header() {
  TOTAL=$((TOTAL + 1))
  local file="$1"
  local pattern="$2"
  local label="$3"
  if head -n 15 "$file" | grep -qi "$pattern"; then
    echo "PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label -- pattern '$pattern' not found in first 15 lines of $file"
    FAIL=$((FAIL + 1))
    return 1
  fi
}

# Combines file-existence guard with header content assertion. If the
# file does not exist the test is recorded as a failure without calling
# head/grep on a missing file.
assert_header_if_exists() {
  local file="$1"
  local pattern="$2"
  local label="$3"
  if [ -f "$file" ]; then
    assert_file_contains_in_header "$file" "$pattern" "$label" || true
  else
    TOTAL=$((TOTAL + 1))
    FAIL=$((FAIL + 1))
    echo "FAIL: $label -- file does not exist"
  fi
}

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

echo "=========================================="
echo "Deploy Script Deprecation Verification"
echo "=========================================="
echo ""

# Test 1-3: Original filenames should NOT exist
echo "--- Original files should be removed ---"
assert_file_not_exists "$DEPLOY_DIR/80_upgrade_bridge_v2.ts" \
  "Original 80_upgrade_bridge_v2.ts should not exist" || true

assert_file_not_exists "$DEPLOY_DIR/82_deploy_rebate_and_prepare_txs.ts" \
  "Original 82_deploy_rebate_and_prepare_txs.ts should not exist" || true

assert_file_not_exists "$DEPLOY_DIR/84_upgrade_bridge_repair_rebate_staking.ts" \
  "Original 84_upgrade_bridge_repair_rebate_staking.ts should not exist" || true

echo ""

# Test 4-6: Deprecated filenames SHOULD exist
echo "--- Deprecated files should exist ---"
assert_file_exists "$DEPLOY_DIR/80_upgrade_bridge_v2_DEPRECATED.ts" \
  "Renamed 80_upgrade_bridge_v2_DEPRECATED.ts should exist" || true

assert_file_exists "$DEPLOY_DIR/82_deploy_rebate_and_prepare_txs_DEPRECATED.ts" \
  "Renamed 82_deploy_rebate_and_prepare_txs_DEPRECATED.ts should exist" || true

assert_file_exists "$DEPLOY_DIR/84_upgrade_bridge_repair_rebate_staking_DEPRECATED.ts" \
  "Renamed 84_upgrade_bridge_repair_rebate_staking_DEPRECATED.ts should exist" || true

echo ""

# Test 7-9: Each deprecated file has DEPRECATED in header
echo "--- Warning headers should contain DEPRECATED ---"
assert_header_if_exists "$DEPLOY_DIR/80_upgrade_bridge_v2_DEPRECATED.ts" \
  "DEPRECATED" "Script 80 header contains DEPRECATED keyword"

assert_header_if_exists "$DEPLOY_DIR/82_deploy_rebate_and_prepare_txs_DEPRECATED.ts" \
  "DEPRECATED" "Script 82 header contains DEPRECATED keyword"

assert_header_if_exists "$DEPLOY_DIR/84_upgrade_bridge_repair_rebate_staking_DEPRECATED.ts" \
  "DEPRECATED" "Script 84 header contains DEPRECATED keyword"

echo ""

# Test 10-12: Each warning header has script-specific content
echo "--- Warning headers should have script-specific content ---"
assert_header_if_exists "$DEPLOY_DIR/80_upgrade_bridge_v2_DEPRECATED.ts" \
  "upgradeAndCall" "Script 80 warning mentions upgradeAndCall issue"

assert_header_if_exists "$DEPLOY_DIR/82_deploy_rebate_and_prepare_txs_DEPRECATED.ts" \
  "setRebateStaking\|onlyOwner\|governance" \
  "Script 82 warning mentions governance/onlyOwner issue"

assert_header_if_exists "$DEPLOY_DIR/84_upgrade_bridge_repair_rebate_staking_DEPRECATED.ts" \
  "ProxyAdmin\|deployer.*owner\|mainnet" \
  "Script 84 warning mentions ProxyAdmin ownership issue"

echo ""

# Test 13-14: Suitability guidance in warnings
echo "--- Warning headers should mention local/testnet suitability ---"
assert_header_if_exists "$DEPLOY_DIR/80_upgrade_bridge_v2_DEPRECATED.ts" \
  "local\|testnet" "Script 80 warning mentions local/testnet suitability"

assert_header_if_exists "$DEPLOY_DIR/84_upgrade_bridge_repair_rebate_staking_DEPRECATED.ts" \
  "local\|testnet" "Script 84 warning mentions local/testnet suitability"

echo ""
echo "=========================================="
echo "RESULTS: $PASS passed, $FAIL failed, $TOTAL total"
echo "=========================================="

if [ "$FAIL" -gt 0 ]; then
  exit 1
else
  exit 0
fi
