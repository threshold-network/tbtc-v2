# BridgeLifecycleRouter follow-up plan

**Status as of:** 2026-05-27
**Owner:** Bridge contracts team
**Applies to:** canonical `threshold-network/tbtc-v2` PR #971 and
the follow-up router deployment PR.

## Summary

PR #971 ships the Bridge-side FROST lifecycle hooks, storage, ABI,
and fail-closed guards, but it does **not** ship the
`BridgeLifecycleRouter` implementation contract. This is intentional:
FROST wallet creation must remain dormant until the router contract is
deployed and governance wires both Bridge and `FrostWalletRegistry` to
the same router address.

This document is the required follow-up plan for that missing
deployable contract.

## Why the router is required

FROST wallets are represented in Bridge by a legacy-compatible
`walletPubKeyHash`, but their canonical lifecycle identity is the
32-byte x-only output key (`walletID`). Existing lifecycle call sites
such as close, seize, and membership checks still start from the
20-byte Bridge wallet alias. The router performs the scheme-aware
translation:

1. Bridge calls the router with `walletPubKeyHash`.
2. Router reads `(frostRegistry, walletID)` from
   `Bridge.frostLifecycleContext(walletPubKeyHash)`.
3. Router forwards the lifecycle operation to the configured
   `FrostWalletRegistry` with the canonical `walletID`.

ECDSA wallets do not use the router. They continue calling the legacy
ECDSA registry directly while any ECDSA lifecycle surface remains.

## Required contract shape

The router should be a stateless, non-proxy contract with only immutable
configuration:

- `bridge`: immutable Bridge address.

It must implement `IBridgeLifecycleRouter`:

- `closeWallet(bytes20 walletPubKeyHash)`
- `seize(bytes20 walletPubKeyHash, uint96 amount, uint32 rewardMultiplier, address notifier, uint32[] calldata walletMembersIDs)`
- `isWalletMember(bytes20 walletPubKeyHash, uint32[] calldata walletMembersIDs, address operator, uint256 walletMemberIndex)`

The mutating entry points must require `msg.sender == bridge`.
Otherwise any external caller could use the router's
`FrostWalletRegistry.lifecycleOwner` authority to close or seize FROST
wallets. The view-only membership helper may be public, but tests
should explicitly document that choice.

Each entry point must reject:

- `frostRegistry == address(0)`
- `walletID == bytes32(0)`
- `FrostWalletRegistry.lifecycleOwner() != address(this)`

The last check is defensive. Registry authorization will also reject
bad mutating calls, but checking it in the router gives a clear
configuration error and keeps view calls from silently consulting a
registry that would reject the mutating path.

## Deployment ordering

The deployment must be treated as one activation unit:

1. Deploy `BridgeLifecycleRouter(bridge)`.
2. Verify the router's immutable `bridge` value.
3. Governance calls `Bridge.setLifecycleRouter(router)`.
4. Governance calls `FrostWalletRegistry.updateLifecycleOwner(router)`.
5. Verify:
   - `Bridge.lifecycleRouter() == router`
   - `FrostWalletRegistry.lifecycleOwner() == router`
   - `Bridge.frostWalletRegistry() == FrostWalletRegistry`

Steps 3 and 4 should be batched in the same governance action where
possible. If they cannot be batched, the system remains safe because
`Bridge.requestNewWallet` and `Bridge.__frostWalletCreatedCallback`
both fail closed until the two addresses match.

Do **not** use `Bridge.address` as a placeholder lifecycle owner and
do **not** set `Bridge.lifecycleRouter = Bridge.address`. That wiring
can allow registration or local testing to appear unblocked while the
actual FROST lifecycle calls remain unauthorized or unimplemented.

## Acceptance criteria

The router follow-up PR is complete only when it includes:

- `BridgeLifecycleRouter.sol` implementing `IBridgeLifecycleRouter`.
- Unit tests for close, seize, and membership forwarding.
- Negative tests for:
  - caller is not Bridge on mutating methods,
  - zero FROST registry,
  - missing walletID,
  - registry lifecycle owner mismatch.
- Deployment test/runbook showing `Bridge.lifecycleRouter` and
  `FrostWalletRegistry.lifecycleOwner` are the same router address
  before any FROST wallet creation can start.
- At least one integration path proving a registered FROST wallet can
  reach a lifecycle operation through Bridge -> router -> registry.

Until those criteria are met, FROST wallet creation must remain
disabled on production deployments.
