#!/usr/bin/env bash
set -euo pipefail

RPC_URL="${RPC_URL:-${ETHEREUM_MAINNET_RPC_URL:-}}"

PROXY_ADDRESS="0x5e4861A80B55F035D899F66772117f00fa0E8e7B"
OLD_IMPL="0x51768b63EF72dA2bDeD00e05C68df0920f5786Cc"
NEW_IMPL="0x8Ce2003ABEe1F37fb055E52c14A5eeea00aD1cE7"
REDEMPTION_LIB="0xA7FEd184FE79c2EA037e65558473C04ce42F5D0D"
REBATE_SELECTOR="39e823f0"
IMPLEMENTATION_SLOT="0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"

if [[ -z "$RPC_URL" ]]; then
  echo "RPC URL is required. Set RPC_URL or ETHEREUM_MAINNET_RPC_URL." >&2
  exit 1
fi

lower() { tr '[:upper:]' '[:lower:]'; }

lib_hex="$(printf "%s" "${REDEMPTION_LIB#0x}" | lower)"
selector_hex="$(printf "%s" "${REBATE_SELECTOR#0x}" | lower)"

impl_raw="$(cast storage "$PROXY_ADDRESS" "$IMPLEMENTATION_SLOT" --rpc-url "$RPC_URL")"
impl_addr="0x${impl_raw:26}"

echo "Proxy: $PROXY_ADDRESS"
echo "Implementation slot: $IMPLEMENTATION_SLOT"
echo "Current implementation: $impl_addr"
echo
echo "Notes:"
echo "  - The proxy delegates calls to the implementation set in the EIP-1967 slot."
echo "  - Library selectors (like applyForRebate) live in the library bytecode,"
echo "    while the implementation bytecode should reference the library address."
echo

check_impl() {
  local label="$1"
  local addr="$2"
  local code

  code="$(cast code "$addr" --rpc-url "$RPC_URL" | lower)"

  echo "$label: $addr"
  if echo "$code" | grep -q "$lib_hex"; then
    echo "  - contains Redemption lib ($REDEMPTION_LIB): yes"
  else
    echo "  - contains Redemption lib ($REDEMPTION_LIB): no"
  fi
  if echo "$addr" | lower | grep -q "$(printf "%s" "$impl_addr" | lower)"; then
    echo "  - matches current proxy implementation: yes"
  else
    echo "  - matches current proxy implementation: no"
  fi
  echo
}

check_impl "Before (old impl)" "$OLD_IMPL"
check_impl "After (new impl)" "$NEW_IMPL"

lib_code="$(cast code "$REDEMPTION_LIB" --rpc-url "$RPC_URL" | lower)"
echo "Redemption library: $REDEMPTION_LIB"
if echo "$lib_code" | grep -q "$selector_hex"; then
  echo "  - contains selector ($REBATE_SELECTOR): yes"
else
  echo "  - contains selector ($REBATE_SELECTOR): no"
fi
