# Cross-Chain Fee Waivers for EVM L2 Mint and Redeem

## Overview

This specification defines fee waiver support for T stakers using tBTC mint and
redeem flows that originate from EVM L2 chains. Rebate accounting remains
authoritative on Ethereum L1, where the tBTC Bridge computes deposit and
redemption treasury fees and where `RebateStaking` tracks rebate usage.

The design does not use an L2-authored "rebate consumed" message. L2-originating
flows carry beneficiary context to L1, and the L1 Bridge/RebateStaking path
applies any rebate in the same L1 transaction that creates the deposit or
redemption fee.

## Scope

Phase 1 covers EVM L2s using the existing tBTC EVM cross-chain architecture:

- Canonical L2 `L2TBTC`.
- L2 `L2WormholeGateway`.
- L2 Bitcoin depositor/redeemer contracts.
- L1 Bitcoin depositor/redeemer contracts.
- Ethereum L1 tBTC Bridge, TBTCVault, Bank, and RebateStaking.

Initial deployments should target Arbitrum and Base. The design should remain
usable by other EVM L2s that follow the same contract pattern. Non-EVM chains
and non-Wormhole transport are out of scope for this version.

## Goals

1. Let eligible T stakers receive deposit and redemption treasury fee waivers
   when minting to, or redeeming from, supported EVM L2s.
2. Keep all rebate consumption on L1, next to the existing Bridge fee
   calculation.
3. Prevent double use of rebate capacity across L1 and supported EVM L2 flows.
4. Preserve the existing direct mint and direct redeem security model.
5. Avoid L2-to-L1 rebate request messages that are more expensive than the
   rebate itself.
6. Support EOAs and contract wallets through explicit L1 beneficiary
   authorization.

## Non-Goals

- Moving T staking or rebate accounting to L2.
- Adding CCIP or non-EVM chain support.
- Creating claimable rebate balances.
- Letting L2 contracts independently decide whether a fee has been waived.
- Replacing the existing Wormhole token bridge based mint/redeem flow.

## Existing Constraints

`RebateStaking` is not a standalone balance ledger. It computes a staker's
rebate capacity from stake, subtracts fee rebates used during the rolling
window, and records a rebate only when called by the Bridge.

Current Bridge fee hooks:

- Deposits: `Deposit.revealDepositWithExtraData` computes
  `deposit.treasuryFee`, then calls
  `RebateStaking.applyForRebate(deposit.depositor, fee, Deposit)`.
- Redemptions: `Redemption.requestRedemption` computes `treasuryFee`, then
  calls `RebateStaking.applyForRebate(redeemer, fee, Redemption)`.

Current cross-chain issue:

- L2 mint deposits are revealed on L1 by the L1 Bitcoin depositor contract, so
  the Bridge sees the depositor contract as `deposit.depositor`, not the L2
  user.
- L2 redemptions are executed on L1 by the L1 Bitcoin redeemer contract. The
  Bridge needs a refund recipient for timeout handling, but rebate ownership
  belongs to the T staker beneficiary.

Therefore, the main implementation requirement is beneficiary-aware fee rebate
application on L1, with refund recipient and rebate beneficiary modeled as
independent fields.

## Design Decisions

- Deposit rebates are consumed at reveal time, matching current direct L1
  behavior.
- Redemption timeout refunds go to the L1 redeemer contract, which is
  responsible for returning tBTC to the L2 user.
- Rebate cancellation is keyed by rebate beneficiary and action ID, not by the
  redemption refund recipient.
- Cross-chain rebate records reuse the existing rolling-window accounting model
  but must carry a unique action ID to avoid same-block timestamp collisions.
- Implicit same-address authorization may be supported after audit, but it
  ships disabled on mainnet and is rejected for contract callers.
- Arbitrum and Base use separate governance caps.

## Design Summary

At a high level:

1. The user chooses an L1 rebate beneficiary address. This address is the T
   staker or the delegatee authorized under `RebateStaking`.
2. The user chooses a refund recipient for failure handling. For L2 redemptions,
   this should be the L1 redeemer contract, not the rebate beneficiary.
3. For same-address EOA cases, the L2 user may set the beneficiary to the same
   20-byte address if implicit authorization is enabled for the source chain.
4. For contract wallets, different L1/L2 addresses, or delegated use, the L1
   beneficiary signs an authorization that binds beneficiary, L2 chain, L2 user,
   flow type, action ID, maximum rebate, nonce, and deadline.
5. The L2-originating mint or redeem flow carries the beneficiary and
   authorization context to the L1 depositor/redeemer.
6. The L1 depositor/redeemer calls a beneficiary-aware Bridge entry point.
7. The Bridge computes the actual treasury fee and calls
   `RebateStaking.applyForRebateFor(...)`.
8. `RebateStaking` validates beneficiary authorization if needed, consumes the
   actual rebate amount, and returns the reduced treasury fee.

No rebate capacity is reserved before L1 fee application. A failed L1 deposit
reveal or redemption request consumes no rebate.

## Identifiers

### Source Chain ID

Rebate contexts use EVM chain IDs, not Wormhole chain IDs.

The Bridge's cross-chain integrator registry owns source-chain normalization.
For Wormhole-based integrations, the L1 redeemer/depositor or Bridge registry
must translate Wormhole source chain IDs to EVM chain IDs before calling
`RebateStaking`. `RebateStaking` should never need to interpret Wormhole chain
IDs directly.

### Action ID

Each cross-chain rebate use has a non-zero action ID.

For deposits:

```solidity
actionId = bytes32(
    keccak256(abi.encodePacked(fundingTxHash, fundingOutputIndex))
);
```

This is the same identifier used by the Bridge deposit key. Deposit
authorizations must not use `bytes32(0)`.

For redemptions:

```solidity
actionId = redemptionId;
```

`redemptionId` is generated on L2 before the Wormhole token transfer and must be
included in the authenticated V2 redemption payload. A recommended derivation is:

```solidity
redemptionId = keccak256(
    abi.encode(
        block.chainid,
        address(this),
        msg.sender,
        amount,
        keccak256(redeemerOutputScript),
        nonce
    )
);
```

## Beneficiary Model

### Beneficiary

The rebate beneficiary is an L1 address whose stake determines rebate capacity.
It may be:

- The same EOA address as the L2 user.
- A T staker that delegated rebate use to another address.
- A Safe or other contract wallet, if it produces a valid EIP-1271 signature on
  L1.

`RebateTreasuryFeeMode` applies to the beneficiary, not to the L2 user.

### Refund Recipient

The refund recipient is the L1 address that receives Bank balance if an L1
redemption request times out.

For L2 redemptions, the refund recipient should be the L1 redeemer contract.
That contract must store enough context to return tBTC to the L2 user through
the configured cross-chain gateway after a timeout refund.

The refund recipient must not be overloaded as the rebate owner.

## Authorization Modes

### Signed Authorization

Signed authorization is the default Phase 1 mode. It is required when:

- The L2 user differs from the L1 beneficiary.
- The beneficiary is a contract wallet.
- Governance has disabled implicit same-address authorization for the source
  chain.

EOA beneficiaries use EIP-712 signatures. Contract beneficiaries use EIP-1271,
checked at rebate consumption time on L1.

### Implicit Same-Address Authorization

Implicit authorization may be enabled per EVM source chain after audit. It is
valid only when all of the following are true:

- `beneficiary == l2User`.
- The source chain has implicit authorization enabled.
- The flow authenticates `l2User` on L1:
  - Deposits: `destinationChainDepositOwner` is committed in the Bitcoin
    deposit script extra data and enforced during reveal.
  - Redemptions: the Wormhole VAA authenticates the L2 payload and the L1
    redeemer validates the L2 sender against its allowlist.
- The beneficiary is not a contract on L1: `beneficiary.code.length == 0`.
- The L2 caller is not a contract, enforced by the L2 depositor/redeemer when no
  signed authorization is supplied: `msg.sender.code.length == 0`.

Implicit mode must ship disabled on mainnet and be enabled per chain only after
security review.

## EIP-712 Authorization

The authorization signs a bounded right to use rebate capacity for one specific
L2-originating action.

```solidity
enum RebateFlowType {
  Deposit,
  Redemption
}

struct BeneficiaryRebateAuthorization {
  address beneficiary; // L1 staker whose rebate capacity may be used.
  uint256 sourceChainId; // EVM chain ID for the L2 origin.
  address l2User; // User address on the L2 origin chain.
  RebateFlowType flowType; // Deposit or Redemption.
  bytes32 actionId; // Non-zero deposit key or redemption ID.
  uint64 maxRebateSat; // Maximum rebate allowed by this authorization.
  uint256 nonce; // Arbitrary nonce consumed through a bitmap.
  uint256 deadline; // Expiration timestamp.
}

```

Nonce consumption must use bitmap semantics, not a strictly increasing counter:

```solidity
mapping(address beneficiary => mapping(uint256 wordIndex => uint256 bitmap))
    usedAuthorizationNonceBitmap;
```

This allows parallel authorizations to land in any order while preserving
single-use guarantees.

The EIP-712 domain separator already binds `chainId` and `verifyingContract`.
If governance wants an emergency invalidation mechanism for all outstanding
authorizations, it may add an explicit `authorizationDomainVersion` and include
that version in the signed struct.

## L1 Contract Changes

### RebateStaking

Add beneficiary-aware rebate application without changing the existing
`applyForRebate` behavior for direct L1 flows.

```solidity
function applyForRebateFor(
  address beneficiary,
  uint64 treasuryFee,
  TreasuryFeeType treasuryFeeType,
  BeneficiaryRebateContext calldata context
) external onlyBridge returns (uint64 reducedTreasuryFee);

function cancelCrossChainRebate(address beneficiary, bytes32 actionId)
  external
  onlyBridge;

```

`BeneficiaryRebateContext` contains:

```solidity
struct BeneficiaryRebateContext {
  uint256 sourceChainId; // EVM source chain ID.
  address l2User; // L2 user address.
  RebateFlowType flowType; // Deposit or Redemption.
  bytes32 actionId; // Non-zero deposit key or redemption ID.
  uint64 maxRebateSat; // Caller/user-specified cap.
  bytes authorization; // Empty only for implicit same-address mode.
}

```

Validation and behavior:

- If `treasuryFee == 0`, return `0` and do not revert.
- If cross-chain rebates are paused, return `treasuryFee` unchanged and do not
  revert.
- `beneficiary != address(0)`.
- `context.actionId != bytes32(0)`.
- `context.sourceChainId` is supported.
- `context.flowType` matches `treasuryFeeType`.
- If `authorization` is empty, implicit authorization rules must pass.
- If `authorization` is non-empty, verify EIP-712 or EIP-1271 for
  `beneficiary`.
- Reject expired authorizations.
- Reject reused bitmap nonces.
- Apply `RebateTreasuryFeeMode` to the beneficiary.
- The actual rebate is:

```solidity
rebate = min(
    treasuryFee,
    context.maxRebateSat,
    maxCrossChainRebateSat[context.sourceChainId][treasuryFeeType],
    remainingStakeDerivedCapacity
);
```

Accounting requirements:

- Cross-chain rebate records must include `actionId` and beneficiary.
- Cancellation must match by beneficiary and `actionId`, not only by timestamp.
- The implementation may extend the existing `Rebate` struct using its storage
  gap or maintain a parallel mapping from `actionId` to rebate-array index.
- Same-block redemptions from the same beneficiary must cancel independently.

Recommended events:

```solidity
event CrossChainRebateApplied(
  address indexed beneficiary,
  address indexed l2User,
  bytes32 indexed actionId,
  uint256 sourceChainId,
  RebateStaking.TreasuryFeeType feeType,
  uint64 rebate,
  uint64 treasuryFeeBefore,
  uint64 treasuryFeeAfter
);

event CrossChainRebateAuthorizationUsed(
  address indexed beneficiary,
  uint256 indexed sourceChainId,
  uint256 nonce,
  bytes32 indexed actionId
);

event CrossChainRebateCanceled(
  address indexed beneficiary,
  bytes32 indexed actionId,
  uint64 rebate
);
```

### Bridge

Add beneficiary-aware paths for deposit and redemption fee calculation. Existing
public interfaces should remain supported.

Recommended shape:

```solidity
function revealDepositWithExtraDataAndRebate(
  IBridgeTypes.BitcoinTxInfo calldata fundingTx,
  IBridgeTypes.DepositRevealInfo calldata reveal,
  bytes32 extraData,
  address rebateBeneficiary,
  BeneficiaryRebateContext calldata rebateContext
) external;

function requestRedemptionWithRebate(
  bytes20 walletPubKeyHash,
  BitcoinTx.UTXO calldata mainUtxo,
  address balanceOwner,
  address refundRecipient,
  bytes calldata redeemerOutputScript,
  uint64 amount,
  address rebateBeneficiary,
  BeneficiaryRebateContext calldata rebateContext
) external;

```

Access control:

- Bridge maintains `authorizedCrossChainIntegrators[address]`.
- The integrator registry records each integrator's EVM source chain ID and, if
  applicable, its Wormhole chain ID.
- Only authorized integrators may call beneficiary-aware entry points.

Bridge behavior:

- The Bridge remains the only caller of `RebateStaking`.
- The cross-chain integrator never directly consumes or cancels a rebate.
- Deposit reveal computes the deposit action ID and rejects a context whose
  action ID does not match.
- Redemption request stores cross-chain rebate metadata keyed by
  `redemptionKey`, at minimum `rebateBeneficiary` and `actionId`.
- Redemption timeout calls
  `RebateStaking.cancelCrossChainRebate(rebateBeneficiary, actionId)` when a
  cross-chain rebate was applied.
- Redemption timeout refunds Bank balance to `refundRecipient`.

### L1 EVM Bitcoin Depositor

Extend the L1 depositor initializer so the relayer can pass rebate context when
revealing a deposit:

```solidity
function initializeDeposit(
  IBridgeTypes.BitcoinTxInfo calldata fundingTx,
  IBridgeTypes.DepositRevealInfo calldata reveal,
  bytes32 destinationChainDepositOwner,
  address rebateBeneficiary,
  BeneficiaryRebateContext calldata rebateContext
) external;

```

Rules:

- `rebateContext.sourceChainId` must match this depositor's configured EVM L2
  chain ID.
- `rebateContext.l2User` must match `destinationChainDepositOwner` when the
  owner is an EVM address encoded as bytes32.
- `rebateContext.actionId` must equal the Bridge deposit key computed from
  `fundingTxHash` and `fundingOutputIndex`.
- The Bridge computes the deposit treasury fee and applies any rebate at reveal
  time.
- Finalization stays unchanged except for event/indexing additions.

Recommended event:

```solidity
event DepositInitializedWithRebate(
  uint256 indexed depositKey,
  bytes32 indexed destinationChainDepositOwner,
  address indexed rebateBeneficiary,
  uint64 maxRebateSat
);
```

### L1 EVM Bitcoin Redeemer

Keep the existing `requestRedemption` function as the legacy no-rebate path.
Add a separate V2 entry point for rebate-aware redemptions. Do not sniff V1/V2
payloads inside one function.

```solidity
function requestRedemptionWithRebate(
  bytes20 walletPubKeyHash,
  BitcoinTx.UTXO calldata mainUtxo,
  bytes calldata encodedVm
) external;

```

V2 payload:

```solidity
struct L2RedemptionPayloadV2 {
  bytes redeemerOutputScript;
  address l2User;
  address rebateBeneficiary;
  uint64 maxRebateSat;
  bytes rebateAuthorization;
  bytes32 redemptionId;
}

```

The L1 redeemer:

- Completes the Wormhole token transfer.
- Validates the transfer source against `allowedSenders`.
- Decodes `L2RedemptionPayloadV2`.
- Builds `BeneficiaryRebateContext`.
- Calls Bridge redemption with:
  - `refundRecipient = address(this)`.
  - `rebateBeneficiary = payload.rebateBeneficiary`.
  - `actionId = payload.redemptionId`.
- Stores pending timeout-refund context keyed by `redemptionKey`, including L2
  user, source chain, and amount.

Timeout refund path:

- After Bridge timeout handling refunds Bank balance to the L1 redeemer, anyone
  can call a redeemer function that converts the refunded Bank balance back to
  tBTC and sends it to the L2 user through the configured cross-chain gateway.
- The exact function name and batching behavior are implementation details, but
  the invariant is that timeout funds return to the L2 user, not to the rebate
  beneficiary.

Recommended event:

```solidity
event RedemptionRequestedWithRebate(
  uint256 indexed redemptionKey,
  bytes32 indexed redemptionId,
  address indexed rebateBeneficiary,
  address l2User,
  uint64 maxRebateSat
);

event TimedOutRedemptionRefundSentToL2(
  uint256 indexed redemptionKey,
  address indexed l2User,
  uint256 amount
);
```

## L2 Contract Changes

### L2 Bitcoin Depositor

For the current event-based deposit initialization, the L2 depositor should emit
rebate context for relayers:

```solidity
function initializeDepositWithRebate(
  IBridgeTypes.BitcoinTxInfo calldata fundingTx,
  IBridgeTypes.DepositRevealInfo calldata reveal,
  address l2DepositOwner,
  address rebateBeneficiary,
  uint64 maxRebateSat,
  bytes calldata rebateAuthorization
) external;

event DepositInitializedWithRebate(
  IBridgeTypes.BitcoinTxInfo fundingTx,
  IBridgeTypes.DepositRevealInfo reveal,
  address indexed l2DepositOwner,
  address indexed l2Sender,
  bytes32 indexed actionId,
  address rebateBeneficiary,
  uint64 maxRebateSat,
  bytes rebateAuthorization
);
```

Rules:

- If `rebateAuthorization` is empty, require `msg.sender.code.length == 0` and
  `rebateBeneficiary == l2DepositOwner`.
- The event must include the deposit action ID.
- The existing `DepositInitialized` event remains supported for no-rebate
  deposits.

No L2-to-L1 Wormhole rebate message is required. The relayer passes the event
payload to the L1 depositor when initializing the deposit.

### L2 Bitcoin Redeemer

Add a versioned redemption call:

```solidity
function requestRedemptionWithRebate(
  uint256 amount,
  uint16 recipientChain,
  bytes calldata redeemerOutputScript,
  address rebateBeneficiary,
  uint64 maxRebateSat,
  bytes calldata rebateAuthorization,
  uint32 nonce
) external payable returns (uint64 sequence);

```

This function should:

- Validate the Bitcoin output script as the current `requestRedemption` does.
- Normalize `amount` exactly as the current flow does.
- If `rebateAuthorization` is empty, require `msg.sender.code.length == 0` and
  `rebateBeneficiary == msg.sender`.
- Generate `redemptionId`.
- Transfer L2 tBTC from `msg.sender`.
- Encode `L2RedemptionPayloadV2`.
- Burn/send L2 tBTC through `L2WormholeGateway.sendTbtcWithPayloadToNativeChain`.

The existing `requestRedemption` remains the no-rebate path and continues to
encode the legacy raw `redeemerOutputScript` payload.

## Flows

### Mint to EVM L2 with Rebate

1. User prepares a Bitcoin deposit whose depositor is the L1 EVM Bitcoin
   depositor and whose extra data points to the L2 deposit owner.
2. User computes the deposit action ID.
3. User selects a rebate beneficiary and, if needed, obtains a signed
   authorization from that beneficiary.
4. User or relayer emits/submits deposit initialization data on L2 with rebate
   context.
5. Relayer calls
   `L1BitcoinDepositor.initializeDeposit(..., rebateBeneficiary, rebateContext)`.
6. L1 depositor validates chain/user/action binding and calls
   `Bridge.revealDepositWithExtraDataAndRebate`.
7. Bridge computes the deposit treasury fee.
8. Bridge calls `RebateStaking.applyForRebateFor(..., TreasuryFeeType.Deposit, ...)`.
9. RebateStaking verifies authorization, consumes actual rebate capacity, and
   returns the reduced fee.
10. Bridge stores the reduced deposit treasury fee.
11. Deposit finalization proceeds through the existing L1 to L2 tBTC transfer
    path.

If the deposit is revealed but never swept or optimistically minted, the rebate
capacity remains consumed, matching current direct L1 deposit behavior where the
rebate is applied at reveal time.

### Redeem from EVM L2 with Rebate

1. User calls `L2BTCRedeemer.requestRedemptionWithRebate`.
2. L2 redeemer validates input, takes custody of canonical L2 tBTC, and sends
   tBTC with `L2RedemptionPayloadV2` to the L1 redeemer.
3. Relayer calls `L1BTCRedeemer.requestRedemptionWithRebate`.
4. L1 redeemer completes the Wormhole token transfer and validates the L2 sender.
5. L1 redeemer decodes the V2 payload and calls Bridge redemption with rebate
   context.
6. Bridge computes the redemption treasury fee.
7. Bridge calls
   `RebateStaking.applyForRebateFor(..., TreasuryFeeType.Redemption, ...)`.
8. RebateStaking verifies authorization, consumes actual rebate capacity, and
   returns the reduced fee.
9. Bridge creates the pending redemption with the reduced treasury fee and stores
   rebate timeout metadata.
10. Bitcoin redemption proof handling remains unchanged.
11. If the redemption times out, Bridge cancels the rebate by beneficiary/action
    ID and refunds Bank balance to the L1 redeemer. The L1 redeemer sends tBTC
    back to the L2 user.

## Replay Protection

Replay protection is handled on L1.

- For signed authorizations, each beneficiary nonce bit can be consumed only
  once.
- All cross-chain rebate uses require `actionId != bytes32(0)`.
- For implicit same-address use, RebateStaking records
  `keccak256(sourceChainId, l2User, flowType, actionId)` and rejects duplicates.
- Wormhole token transfer VAAs are single-use at the Token Bridge level, but
  rebate accounting must not rely only on Wormhole replay protection because
  deposits may be event/relayer based.
- Governance can require signed authorizations for any source chain.

## Failure Handling

### Deposit Failure

If deposit reveal reverts, no rebate is consumed.

If deposit reveal succeeds but the Bitcoin deposit is never swept or
optimistically minted, the existing deposit lifecycle applies. The deposit
treasury fee was set at reveal time and the rebate has already been consumed,
matching current direct L1 behavior.

### Redemption Failure or Timeout

If the L1 redemption request reverts, no rebate is consumed.

If the redemption request is created and later times out:

1. Bridge calls
   `RebateStaking.cancelCrossChainRebate(rebateBeneficiary, actionId)`.
2. Bridge refunds Bank balance to the stored refund recipient.
3. For L2 redemptions, the refund recipient is the L1 redeemer contract.
4. The L1 redeemer sends equivalent tBTC back to the original L2 user.

The implementation must include tests proving timeout cancellation restores
cross-chain redemption rebate capacity and timeout funds return to the L2 user.

## Security Requirements

- Only the Bridge can consume or cancel rebate records.
- Only governance-authorized L1 cross-chain depositor/redeemer contracts can
  pass rebate context into Bridge beneficiary-aware entry points.
- RebateStaking verifies L1 beneficiary consent for all non-implicit uses.
- EIP-1271 contract signatures are checked at consumption time, not at
  signature collection time.
- Source chain identifiers in RebateStaking are EVM chain IDs.
- Wormhole-to-EVM chain ID mapping is owned by the Bridge cross-chain
  integrator registry.
- L2 contract addresses are pinned in L1 depositor/redeemer configuration.
- `maxRebateSat` and governance per-chain caps both cap the actual rebate.
- Governance pause of cross-chain rebates returns the original treasury fee
  unchanged instead of reverting, so in-flight L2 deposits and redemptions keep
  working without a rebate.
- The no-rebate mint and redeem paths keep working during and after rollout.
- Cross-chain rebate use should have a governance minimum rebate threshold to
  reduce uneconomical use and rebate-capacity griefing.
- Authorization deadlines must account for Wormhole VAA generation, L2 finality,
  relayer latency, and congestion.

## Configuration

Recommended governance-controlled parameters:

- `crossChainRebatesEnabled`.
- `implicitSameAddressEnabled[sourceChainId]`.
- `authorizedCrossChainIntegrator[address]`.
- `supportedSourceChain[sourceChainId]`.
- `wormholeToEvmChainId[wormholeChainId]`, owned by the Bridge/integrator
  registry.
- `maxCrossChainRebateSat[sourceChainId][feeType]`.
- `minCrossChainRebateSat[sourceChainId][feeType]`.
- Optional `authorizationDomainVersion` for emergency invalidation of all
  outstanding signed authorizations.

No lock expiry duration is needed because this design does not reserve rebate
capacity before L1 fee application.

## Cost Model

This design intentionally avoids a separate L2-to-L1 lock request, L1-to-L2
confirmation, and L2-to-L1 consume message. Incremental cost is limited to:

- Larger calldata or event payloads carrying the rebate beneficiary and
  authorization.
- Additional L1 gas in Bridge/RebateStaking for authorization verification and
  rebate accounting.
- Additional L2 gas for payload encoding on redemption and event emission on
  deposit initialization.

The frontend should compare estimated fee savings against these incremental
costs, not against a three-message cross-chain lock protocol. For small rebate
amounts, applying a rebate may be net-negative after L1 signature verification
and relayer costs.

## UX Requirements

The frontend should:

- Show available rebate from L1 `RebateStaking`.
- Estimate savings using current Bridge fee divisors, but label estimates as
  estimates until L1 execution.
- Ask for an L1 beneficiary signature when the L2 account is not the beneficiary
  or when implicit same-address mode is disabled.
- Default `maxRebateSat` to the estimated treasury fee plus a small
  governance-defined tolerance.
- Use authorization deadlines long enough to account for L2 finality, Wormhole
  VAA generation, and relayer delay.
- Warn users when estimated rebate savings are below incremental execution cost.
- Clearly state that deposit rebate capacity is consumed at reveal time even if
  the deposit is never swept later.
- Display no extra "waiting for rebate lock" step.
- Keep no-rebate mint/redeem as a fallback.

## Deployment Plan

1. Add and test beneficiary-aware `RebateStaking` APIs and action-ID-based
   cancellation.
2. Add and test beneficiary-aware Bridge entry points and timeout metadata.
3. Add L1 redeemer timeout-refund-to-L2 support.
4. Upgrade L1 EVM depositor/redeemer implementations for Arbitrum and Base.
5. Upgrade L2 EVM depositor/redeemer implementations for Arbitrum and Base.
6. Enable signed-authorization mode first; keep implicit same-address mode
   disabled until audit.
7. Run end-to-end testnet flows for:
   - L2 mint with rebate.
   - L2 redeem with rebate.
   - No-rebate mint and redeem backward compatibility.
   - Redemption timeout rebate cancellation and L2 refund.
   - Authorization replay rejection.
8. Deploy mainnet with low per-chain caps and minimum rebate thresholds.
9. Raise caps after monitoring.

## Tests

Contract tests must cover:

- Direct L1 rebate behavior is unchanged.
- L2 mint applies deposit rebate to the intended L1 beneficiary, not the L1
  depositor contract.
- L2 redeem applies redemption rebate to the intended L1 beneficiary, not the L1
  redeemer contract.
- Deposit `actionId` must equal `keccak256(fundingTxHash, fundingOutputIndex)`.
- Same-address implicit authorization works only when enabled.
- Implicit authorization is rejected for L1 contract beneficiaries and L2
  contract callers.
- EIP-712 EOA authorization works.
- EIP-1271 contract authorization works.
- EIP-1271 is re-evaluated at consumption time.
- Authorization deadline, bitmap nonce, chain ID, flow type, action ID, and max
  rebate are enforced.
- Reuse of an authorization fails.
- Wrong L2 user fails.
- Wrong source chain fails.
- Relayer cannot fake `l2User` for deposits by changing
  `destinationChainDepositOwner`.
- Relayer cannot fake `l2User` for redemptions by modifying the authenticated
  Wormhole payload.
- Legacy redemption payload remains supported through the legacy L1 entry point.
- V2 redemption payload is accepted only by the V2 L1 entry point.
- Governance pause of cross-chain rebates leaves direct L1 rebates functional
  and in-flight L2 flows succeeding without rebates.
- `maxCrossChainRebateSat[chain][feeType]` is applied even when signed
  `maxRebateSat` is higher.
- `minCrossChainRebateSat[chain][feeType]` rejects or skips uneconomical rebate
  use according to the implementation decision.
- Rebate capacity cannot be double-spent across L1 direct, L2 mint, and L2
  redeem flows.
- Two redemptions in the same block from the same beneficiary both cancel
  correctly.
- Redemption timeout cancellation restores rebate capacity to the beneficiary.
- Redemption timeout refund reaches the L2 user.

## Remaining Implementation Details

The following details should be decided during implementation:

1. Whether `minCrossChainRebateSat` should skip rebate application or reject the
   rebate-aware path.
2. Whether L1 redeemer timeout refunds should be one-at-a-time or batchable.
3. Whether `authorizationDomainVersion` is needed for emergency invalidation or
   can be omitted.
