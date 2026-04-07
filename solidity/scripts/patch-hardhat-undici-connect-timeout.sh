#!/usr/bin/env bash
# Hardhat HttpProvider uses `new Pool(url.origin)` with undici's default connectTimeout (10s).
# Slow Sepolia RPCs often hit ConnectTimeoutError before headersTimeout. We align connectTimeout
# with the same _timeout passed from networks.*.timeout (see hardhat.config.ts CHAIN_HTTP_TIMEOUT_MS).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOLIDITY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HTTP_JS="$SOLIDITY_ROOT/node_modules/hardhat/internal/core/providers/http.js"

if [ ! -f "$HTTP_JS" ]; then
  echo "patch-hardhat-undici-connect-timeout: skip (no $HTTP_JS — run yarn install)"
  exit 0
fi

export HTTP_JS_PATH="$HTTP_JS"
node -e "
const fs = require('fs');
const path = process.env.HTTP_JS_PATH;
let s = fs.readFileSync(path, 'utf8');
const needle = 'this._dispatcher = client ?? new Pool(url.origin);';
const patched = 'this._dispatcher = client ?? new Pool(url.origin, { connectTimeout: this._timeout });';
if (s.includes('connectTimeout: this._timeout')) process.exit(0);
if (!s.includes(needle)) {
  console.error('patch-hardhat-undici-connect-timeout: pattern not found; Hardhat version may have changed');
  process.exit(0);
}
fs.writeFileSync(path, s.replace(needle, patched));
console.log('patched Hardhat HttpProvider: undici Pool connectTimeout = networks.*.timeout');
"
