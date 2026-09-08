#!/usr/bin/env bash
# @openzeppelin/upgrades-core's getUnlinkedBytecode() tries to "unlink" the
# bytecode of the contract being deployed using the linkReferences of every
# other library-linked contract ever compiled in the same run (e.g.
# WalletRegistry, Bridge). Those linkReferences point at byte offsets that
# have nothing to do with an unrelated contract's bytecode, so `unlinkBytecode`
# produces garbage and the follow-up `getVersion()` throws
# "Bytecode is not a valid hex string" instead of just treating that
# candidate as a non-match and moving on to the next one. This crashes any
# `deployProxy`/`upgradeProxy` call for a non-linked contract (e.g.
# BTCDepositorWormhole, Timelock, VendingMachine) whenever a library-linked
# contract was compiled in the same hardhat run - matches upstream issue
# https://github.com/OpenZeppelin/openzeppelin-upgrades/issues/1227.
# Proposed fix in https://github.com/OpenZeppelin/openzeppelin-upgrades/pull/1246
# (still open, not yet released as of our pinned upgrades-core 1.46.0) uses
# the same try/catch approach applied here.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOLIDITY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
QUERY_JS="$SOLIDITY_ROOT/node_modules/@openzeppelin/upgrades-core/dist/validate/query.js"

if [ ! -f "$QUERY_JS" ]; then
  echo "patch-openzeppelin-upgrades-core-unlink: skip (no $QUERY_JS - run yarn install)"
  exit 0
fi

export QUERY_JS_PATH="$QUERY_JS"
node -e "
const fs = require('fs');
const path = process.env.QUERY_JS_PATH;
let s = fs.readFileSync(path, 'utf8');
const needle = \`            const unlinkedBytecode = (0, link_refs_1.unlinkBytecode)(bytecode, linkReferences);
            const version = (0, version_1.getVersion)(unlinkedBytecode);
            if (validation[name].version?.withMetadata === version.withMetadata) {
                return unlinkedBytecode;
            }\`;
const patched = \`            const unlinkedBytecode = (0, link_refs_1.unlinkBytecode)(bytecode, linkReferences);
            let version;
            try {
                version = (0, version_1.getVersion)(unlinkedBytecode);
            }
            catch (e) {
                // Unlinking with an unrelated contract's linkReferences produced
                // invalid bytecode; this candidate is not a match, keep looking.
                continue;
            }
            if (validation[name].version?.withMetadata === version.withMetadata) {
                return unlinkedBytecode;
            }\`;
if (s.includes('Unlinking with an unrelated')) process.exit(0);
if (!s.includes(needle)) {
  console.error('patch-openzeppelin-upgrades-core-unlink: pattern not found; upgrades-core version may have changed');
  process.exit(0);
}
fs.writeFileSync(path, s.replace(needle, patched));
console.log('patched @openzeppelin/upgrades-core getUnlinkedBytecode: skip unlink candidates that produce invalid bytecode instead of throwing');
"
