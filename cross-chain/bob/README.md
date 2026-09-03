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
  becomes required, not a signal that it is safe to remove.
  **Verified on-chain (2026-09-01): `legacyCapRemaining` is already 0** on
  the live `OptimismMintableUpgradableTBTC` contract on BOB, so CCIP is
  already the only working exit today, not a future state -- do not disable
  or rate-limit-to-zero the CCIP outbound (exit) path while this holds;
- after BOB balances and in-flight messages are fully drained, governance can
  remove the BOB CCIP chain config on both pools and withdraw remaining
  Ethereum pool liquidity through the configured rebalancer. Before that
  step, confirm two preconditions this package's scripts do not establish:
  pool `owner()` on both pools has been transferred from the deployer to the
  governance council multisig, and `setRebalancer(<address>)` has been
  called on the L1 `LockReleaseTokenPoolUpgradeable` pool (`withdrawLiquidity`
  reverts for any caller other than the configured rebalancer, which
  defaults unset).
  **Verified on-chain (2026-09-01):** the owner-transfer precondition is
  already satisfied on both sides -- the L1 pool
  (`0x03E342731c08FDDc34cFb43E91cB3a7e424ee0F6`) is owned by a 6-of-9 Safe
  (`0x9F6e831c8F8939DC0C830C6e492e7cEf4f9C2F5f`) and the BOB pool
  (`0x36ee23c94523A05981bAAeeAeA4bA97CDde21F6A`) is owned by a separate
  6-of-9 Safe (`0x694DeC29F197c76eb13d4Cc549cE38A1e06Cd24C`). The rebalancer
  precondition is **not** satisfied: `getRebalancer()` on the L1 pool
  currently returns the zero address, so `withdrawLiquidity`/
  `transferLiquidity` cannot be called by anyone until the L1 multisig
  calls `setRebalancer`.

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
