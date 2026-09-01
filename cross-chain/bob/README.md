# Threshold cross-chain - BOB

BOB CCIP support is deprecated. This package is kept for historical deployment
context and exit operations only. Do not use the deployment scripts to deploy
new BOB CCIP token-pool infrastructure.

Existing BOB liquidity should remain withdraw-only:

- keep the BOB tBTC token unpaused while exits are still possible;
- keep the BOB native OP Stack bridge path available until
  `legacyCapRemaining` reaches zero. `legacyCapRemaining` is not
  monotonically decreasing: every native-bridge deposit increases it, so it
  is only guaranteed to trend toward zero if native bridge-in deposits are
  also suppressed, not just CCIP bridge-in (see below);
- disable new BOB CCIP bridge-in routes, and new native OP Stack bridge-in
  deposits, in the frontend and any routing layer -- either path can grow
  the BOB-side balance that still needs to be drained;
- do not remove the BOB CCIP chain config while `legacyCapRemaining` is still
  above zero: while it is nonzero, only the native bridge can exit BOB to
  Ethereum (CCIP `burnFrom`-based exits revert for any non-bridge caller);
  once it reaches zero, the native bridge's own burn path reverts instead
  and CCIP becomes the only working exit -- the two exit paths are never
  both available at once, so treat "cap reached zero" as the point CCIP
  becomes required, not a signal that it is safe to remove;
- after BOB balances and in-flight messages are fully drained, governance can
  remove the BOB CCIP chain config on both pools and withdraw remaining
  Ethereum pool liquidity through the configured rebalancer. Before that
  step, confirm two preconditions this package's scripts do not establish:
  pool `owner()` on both pools has been transferred from the deployer to the
  governance council multisig (no script here performs that transfer --
  verify on-chain and complete it out of band if still outstanding), and
  `setRebalancer(<address>)` has been called on the L1
  `LockReleaseTokenPoolUpgradeable` pool (`withdrawLiquidity` reverts for any
  caller other than the configured rebalancer, which defaults unset).

The CCIP token pool contracts do not expose a way to hard-block
Ethereum-to-BOB deposits while leaving BOB-to-Ethereum exits fully unlimited,
but a real throttle is available and unused by this PR: governance can call
`setChainRateLimiterConfig` with a small enabled outbound (deposit) bucket
(e.g. `capacity: 2, rate: 1`, in wei) to revert every economically
meaningful deposit at send time on Ethereum, while leaving the inbound
(exit) bucket, and therefore exits, completely untouched -- outbound and
inbound are independent buckets on independent code paths. Removing BOB
from the Ethereum pool's chain config also causes inbound BOB-to-Ethereum
messages to fail validation, so chain removal remains a final cleanup step
only, not a substitute for the throttle above.

The native OP Stack bridge is BOB infrastructure, not a tBTC-maintained
bridge path. It also cannot be deactivated at the token-contract level. See
[`docs/tbtc-bob-upgrade-technical-document.md`](docs/tbtc-bob-upgrade-technical-document.md#deprecation-addendum-bob-ccip)
for the legacy-cap mechanics and the BOB CCIP deprecation addendum.
