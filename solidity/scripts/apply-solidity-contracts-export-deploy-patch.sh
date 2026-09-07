#!/usr/bin/env bash
# Overwrite vendored deploy scripts in node_modules (including ethers v6 confirmation waits).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOLIDITY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

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
