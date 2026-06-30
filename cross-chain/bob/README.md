# Threshold cross-chain - BOB

BOB CCIP support is deprecated. This package is kept for historical deployment
context and exit operations only. Do not use the deployment scripts to deploy
new BOB CCIP token-pool infrastructure.

Existing BOB liquidity should remain withdraw-only:

- keep the BOB tBTC token unpaused while exits are still possible;
- keep the BOB native OP Stack bridge path available until
  `legacyCapRemaining` reaches zero;
- disable new BOB CCIP bridge-in routes in the frontend and any routing layer;
- do not remove the BOB CCIP chain config while BOB-to-Ethereum exits or
  in-flight CCIP messages remain;
- after BOB balances and in-flight messages are fully drained, governance can
  remove the BOB CCIP chain config on both pools and withdraw remaining
  Ethereum pool liquidity through the configured rebalancer.

The CCIP token pool contracts do not expose a safe one-way switch that blocks
Ethereum-to-BOB deposits while preserving BOB-to-Ethereum exits. Removing BOB
from the Ethereum pool also causes inbound BOB-to-Ethereum messages to fail
validation, so chain removal is a final cleanup step only.

The native OP Stack bridge is BOB infrastructure, not a tBTC-maintained bridge
path. It also cannot be deactivated at the token-contract level. The existing
`legacyCapRemaining` mechanism naturally drains as users exit via the native
bridge. See
[`docs/tbtc-bob-upgrade-technical-document.md`](docs/tbtc-bob-upgrade-technical-document.md)
for details.
