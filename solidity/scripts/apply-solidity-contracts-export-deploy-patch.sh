#!/usr/bin/env bash
# Overwrite vendored deploy scripts in node_modules (including ethers v6 confirmation waits).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOLIDITY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROVENANCE_MANIFEST="$SCRIPT_DIR/deploy-patches-provenance.json"
HAVE_JQ=1
command -v jq > /dev/null 2>&1 || HAVE_JQ=0

apply_one() {
  local PATCH_SRC="$1"
  local TARGET="$2"
  if [ ! -f "$PATCH_SRC" ]; then
    echo "ERROR: missing $PATCH_SRC"
    exit 1
  fi
  if [ ! -f "$TARGET" ]; then
    echo "ERROR: $TARGET not found — run yarn install in tbtc-v2/solidity"
    exit 1
  fi

  # Warn (without failing the install) if the installed dependency has drifted from the
  # version this patch was authored against, so a silent overwrite doesn't mask a
  # dependency bump that may have made the patch stale. See deploy-patches-provenance.json.
  # Skip the check once the target already matches our own patch output (a prior run of
  # this script already applied it) — only the pristine, not-yet-patched file is meaningful
  # to compare against the recorded upstream hash.
  if [ "$HAVE_JQ" -eq 1 ]; then
    local ACTUAL_HASH
    ACTUAL_HASH="$(sha256sum "$TARGET" | cut -d' ' -f1)"
    local PATCH_HASH
    PATCH_HASH="$(sha256sum "$PATCH_SRC" | cut -d' ' -f1)"
    if [ "$ACTUAL_HASH" != "$PATCH_HASH" ]; then
      local RELATIVE_TARGET="${TARGET#"$SOLIDITY_ROOT"/}"
      local EXPECTED_HASH
      EXPECTED_HASH="$(jq -r --arg key "$RELATIVE_TARGET" '.[$key].hash // empty' "$PROVENANCE_MANIFEST")"
      if [ -n "$EXPECTED_HASH" ] && [ "$ACTUAL_HASH" != "$EXPECTED_HASH" ]; then
        echo "WARNING: $TARGET does not match the pristine upstream file this patch was authored against."
        echo "         expected sha256 $EXPECTED_HASH, found $ACTUAL_HASH — the dependency may have"
        echo "         been upgraded since the patch in deploy-patches/ was written; review the diff"
        echo "         and refresh deploy-patches-provenance.json once the patch is confirmed current."
      fi
    fi
  fi

  cp "$PATCH_SRC" "$TARGET"
  echo "Applied deploy patch: $TARGET"
}

apply_one \
  "$SOLIDITY_ROOT/deploy-patches/07_deploy_token_staking.js" \
  "$SOLIDITY_ROOT/node_modules/@threshold-network/solidity-contracts/export/deploy/07_deploy_token_staking.js"

apply_one \
  "$SOLIDITY_ROOT/deploy-patches/32_configure_tokenholder_timelock.js" \
  "$SOLIDITY_ROOT/node_modules/@threshold-network/solidity-contracts/export/deploy/32_configure_tokenholder_timelock.js"

apply_one \
  "$SOLIDITY_ROOT/deploy-patches/05_transfer_t.js" \
  "$SOLIDITY_ROOT/node_modules/@threshold-network/solidity-contracts/export/deploy/05_transfer_t.js"

apply_one \
  "$SOLIDITY_ROOT/deploy-patches/03_deploy_wallet_registry.js" \
  "$SOLIDITY_ROOT/node_modules/@keep-network/ecdsa/export/deploy/03_deploy_wallet_registry.js"

apply_one \
  "$SOLIDITY_ROOT/deploy-patches/04_deploy_random_beacon.js" \
  "$SOLIDITY_ROOT/node_modules/@keep-network/random-beacon/export/deploy/04_deploy_random_beacon.js"

apply_one \
  "$SOLIDITY_ROOT/deploy-patches/05_approve_random_beacon_in_token_staking.js" \
  "$SOLIDITY_ROOT/node_modules/@keep-network/random-beacon/export/deploy/05_approve_random_beacon_in_token_staking.js"

apply_one \
  "$SOLIDITY_ROOT/deploy-patches/08_transfer_governance.js" \
  "$SOLIDITY_ROOT/node_modules/@keep-network/random-beacon/export/deploy/08_transfer_governance.js"

apply_one \
  "$SOLIDITY_ROOT/deploy-patches/07_approve_wallet_registry.js" \
  "$SOLIDITY_ROOT/node_modules/@keep-network/ecdsa/export/deploy/07_approve_wallet_registry.js"

apply_one \
  "$SOLIDITY_ROOT/deploy-patches/09_deploy_wallet_registry_governance.js" \
  "$SOLIDITY_ROOT/node_modules/@keep-network/ecdsa/export/deploy/09_deploy_wallet_registry_governance.js"

apply_one \
  "$SOLIDITY_ROOT/deploy-patches/10_transfer_governance.js" \
  "$SOLIDITY_ROOT/node_modules/@keep-network/ecdsa/export/deploy/10_transfer_governance.js"

apply_one \
  "$SOLIDITY_ROOT/deploy-patches/13_authorize_in_random_beacon.js" \
  "$SOLIDITY_ROOT/node_modules/@keep-network/ecdsa/export/deploy/13_authorize_in_random_beacon.js"

apply_one \
  "$SOLIDITY_ROOT/deploy-patches/30_deploy_tokenholder_timelock.js" \
  "$SOLIDITY_ROOT/node_modules/@threshold-network/solidity-contracts/export/deploy/30_deploy_tokenholder_timelock.js"

for DEPLOY_SCRIPT in \
  01_deploy_reimbursement_pool.js \
  02_deploy_beacon_sortition_pool.js \
  03_deploy_beacon_dkg_validator.js \
  07_deploy_random_beacon_governance.js \
  09_deploy_random_beacon_chaosnet.js; do
  apply_one \
    "$SOLIDITY_ROOT/deploy-patches/$DEPLOY_SCRIPT" \
    "$SOLIDITY_ROOT/node_modules/@keep-network/random-beacon/export/deploy/$DEPLOY_SCRIPT"
done

# Keep support code outside export/deploy, whose files hardhat-deploy executes.
mkdir -p "$SOLIDITY_ROOT/node_modules/@keep-network/random-beacon/export/helpers"
cp \
  "$SOLIDITY_ROOT/helpers/wait-for-confirmations.js" \
  "$SOLIDITY_ROOT/node_modules/@keep-network/random-beacon/export/helpers/wait-for-confirmations.js"
