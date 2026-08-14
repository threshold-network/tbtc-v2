# BridgeLifecycleRouter follow-up plan

**Status as of:** 2026-08-14 (canonical-mirror reconciliation)
**Owner:** Bridge contracts team
**Applies to:** canonical `threshold-network/tbtc-v2` PR #971 and
the follow-up router deployment PR.

> **Correction (2026-08-14):** the canonical mirror (PR #971)
> DOES ship `BridgeLifecycleRouter.sol` and the
> `49_deploy_bridge_lifecycle_router.ts` deployment script;
> `BridgeLifecycleRouter.test.ts` is also in the repo. The
> summary below still describes the activation requirements
> (the router must be deployed AND governance must wire both
> Bridge and `FrostWalletRegistry` to the same router address
> before any FROST wallet creation succeeds), but the historical
> claim that the router "is not shipped by PR #971" is wrong.
> The router was implemented alongside the Bridge-side hooks.

## Summary

PR #971 ships the Bridge-side FROST lifecycle hooks, storage, ABI,
and fail-closed guards; it also ships the `BridgeLifecycleRouter`
implementation contract and its deployment script. FROST wallet
creation must remain dormant until governance wires both Bridge
and `FrostWalletRegistry` to the same deployed router address.

This document is the required follow-up plan for the **activation**
of that already-shipped router: deployment, ownership transfer,
and the Bridge / `FrostWalletRegistry` wiring sequence.

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

## Required contract shape (as shipped in PR #971)

The shipped `BridgeLifecycleRouter.sol` is a stateless, non-proxy
contract with only immutable configuration:

- `bridge`: immutable Bridge address.

It implements `IBridgeLifecycleRouter`:

- `closeWallet(bytes20 walletPubKeyHash)`
- `seize(bytes20 walletPubKeyHash, uint96 amount, uint32 rewardMultiplier, address notifier, uint32[] calldata walletMembersIDs)`
- `isWalletMember(bytes20 walletPubKeyHash, uint32[] calldata walletMembersIDs, address operator, uint256 walletMemberIndex)`

The mutating entry points require `msg.sender == bridge`.
Otherwise any external caller could use the router's
`FrostWalletRegistry.lifecycleOwner` authority to close or seize FROST
wallets. The view-only membership helper may be public, but tests
should explicitly document that choice.

Each entry point rejects:

- `frostRegistry == address(0)`
- `walletID == bytes32(0)`
- `FrostWalletRegistry.lifecycleOwner() != address(this)`

The last check is defensive. Registry authorization will also reject
bad mutating calls, but checking it in the router gives a clear
configuration error and keeps view calls from silently consulting a
registry that would reject the mutating path.

## Acceptance criteria — re-run on shipped router

PR #971 ships `BridgeLifecycleRouter.sol`,
`solidity/test/bridge/BridgeLifecycleRouter.test.ts`, and
`solidity/deploy/49_deploy_bridge_lifecycle_router.ts`. Before
treating FROST activation as ready, re-run this plan's acceptance
checklist against the shipped contract (not against a hypothetical
drop-in):
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

## Acceptance criteria (as-shipped status)

The shipped router meets each row as follows:

- `BridgeLifecycleRouter.sol` implementing `IBridgeLifecycleRouter`.
  ✅ Shipped in PR #971; 163-line implementation at
  `solidity/contracts/bridge/BridgeLifecycleRouter.sol`.
- Unit tests for close, seize, and membership forwarding.
  ✅ Shipped in `solidity/test/bridge/BridgeLifecycleRouter.test.ts`.
- Negative tests for:
  - caller is not Bridge on mutating methods,
  - zero FROST registry,
  - missing walletID,
  - registry lifecycle owner mismatch.
  ✅ Covered in the shipped test file; re-verify by reading the
  test suite before sign-off.
- Deployment test/runbook showing `Bridge.lifecycleRouter` and
  `FrostWalletRegistry.lifecycleOwner` are the same router address
  before any FROST wallet creation can start.
  ✅ Deployment script `solidity/deploy/49_deploy_bridge_lifecycle_router.ts`
  is shipped; activation-runbook ownership-transfer + wiring steps
  are the operator-facing work that remains.
- At least one integration path proving a registered FROST wallet can
  reach a lifecycle operation through Bridge -> router -> registry.
  ⚠ Not yet exercised in the canonical test suite (FROST wallet
  creation requires the registry + lifecycle router wiring, which
  is gated on operator activation). Verify this in an integration
  environment before mainnet activation.

Until the integration-path row above is exercised end-to-end, FROST
wallet creation must remain disabled on production deployments.
