#!/usr/bin/env bash
# `getUnlinkedBytecode` (called on every `deployProxy`/`upgradeProxy`) walks
# every externally-linked contract found anywhere in the whole project's
# compiled build-info and splices each one's library placeholder into the
# bytecode of the contract actually being deployed, just to test whether the
# resulting hash matches a known version. For contracts with no relation to
# each other, that speculative splice can corrupt the target bytecode (e.g.
# by landing on its real CBOR metadata boundary), and the un-guarded
# `getVersion()` call then throws "Bytecode is not a valid hex string" for a
# contract that never used any linked library itself, instead of just
# skipping that candidate.
#
# This is a real upstream bug. A fix has been proposed upstream but is not
# yet merged or released as of writing, so it isn't available in the
# `@openzeppelin/hardhat-upgrades@1.28.0` / `@openzeppelin/upgrades-core@1.46.0`
# versions this project is pinned to:
#   https://github.com/OpenZeppelin/openzeppelin-upgrades/issues/1227
#   https://github.com/OpenZeppelin/openzeppelin-upgrades/pull/1246
# This patch applies the same fix: wrap the per-candidate `getVersion()` call
# in try/catch and skip to the next candidate on failure, instead of letting
# the exception abort the whole scan.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOLIDITY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
QUERY_JS="$SOLIDITY_ROOT/node_modules/@openzeppelin/upgrades-core/dist/validate/query.js"

if [ ! -f "$QUERY_JS" ]; then
  echo "patch-upgrades-core-unlinked-bytecode: skip (no $QUERY_JS — run yarn install)"
  exit 0
fi

export QUERY_JS_PATH="$QUERY_JS"
node -e "
const fs = require('fs');
const path = process.env.QUERY_JS_PATH;
let s = fs.readFileSync(path, 'utf8');
const needle = \"const unlinkedBytecode = (0, link_refs_1.unlinkBytecode)(bytecode, linkReferences);\n            const version = (0, version_1.getVersion)(unlinkedBytecode);\n            if (validation[name].version?.withMetadata === version.withMetadata) {\";
const patched = \"const unlinkedBytecode = (0, link_refs_1.unlinkBytecode)(bytecode, linkReferences);\n            // A candidate's link references can corrupt unrelated bytecode into\n            // an invalid hex string (see scripts/patch-upgrades-core-unlinked-bytecode.sh).\n            // Skip this candidate instead of letting getVersion's exception abort\n            // the whole scan, matching upstream's fix for the same bug.\n            let version;\n            try {\n                version = (0, version_1.getVersion)(unlinkedBytecode);\n            }\n            catch (e) {\n                continue;\n            }\n            if (validation[name].version?.withMetadata === version.withMetadata) {\";
if (s.includes('Skip this candidate instead of letting getVersion')) process.exit(0);
if (!s.includes(needle)) {
  console.error('patch-upgrades-core-unlinked-bytecode: pattern not found; upgrades-core version may have changed');
  process.exit(0);
}
fs.writeFileSync(path, s.replace(needle, patched));
console.log('patched @openzeppelin/upgrades-core getUnlinkedBytecode: skip candidates that corrupt unrelated bytecode');
"
