// SPDX-License-Identifier: GPL-3.0-only

// ██████████████     ▐████▌     ██████████████
// ██████████████     ▐████▌     ██████████████
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
// ██████████████     ▐████▌     ██████████████
// ██████████████     ▐████▌     ██████████████
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌

pragma solidity 0.8.17;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import "../GovernanceUtils.sol";
import "../frost-registry/api/IFrostAuthorizationSource.sol";
import "./api/ISeatAllocator.sol";
import "./api/ISignerRegistry.sol";
import "./api/IStakeVault.sol";
import "./api/ISlashingModule.sol";
import "./api/IRewardsDistributor.sol";
import "./api/IWalletExposureLedger.sol";

/// @notice The subset of the FROST wallet registry surface the seat
///         allocator drives when synchronizing authorization weights.
///         Mirrors the local interface idiom used by `FrostAllowlist`.
interface ISeatAllocatorWalletRegistry {
    function authorizationIncreased(
        address stakingProvider,
        uint96 fromAmount,
        uint96 toAmount
    ) external;

    function authorizationDecreaseRequested(
        address stakingProvider,
        uint96 fromAmount,
        uint96 toAmount
    ) external;

    /// @notice The registry's own pool-eligibility floor. A provider is
    ///         pool-eligible only while its synced authorization is at or
    ///         above this value, so the allocator's uniform `equalSeatWeight`
    ///         must never be set below it.
    function minimumAuthorization() external view returns (uint96);
}

/// @notice The stake vault surface the seat allocator consumes beyond the
///         shared `IStakeVault` interface: the queued-but-unfinalized
///         self-bond withdrawal (excluded from weight immediately) and the
///         vault-governed minimum self-bond.
interface ISeatAllocatorStakeVault is IStakeVault {
    function pendingSelfBondWithdrawalOf(address stakingProvider)
        external
        view
        returns (uint96);

    function minSelfBond() external view returns (uint96);
}

/// @title SeatAllocator
/// @notice Curation-derived authorization source for the FROST wallet
///         registry. Replaces `FrostAllowlist` behind the same
///         `IFrostAuthorizationSource` interface, but seat/signing weight is
///         UNIFORM (Option B): every allowlisted, active operator whose
///         effective self-bond clears the vault's minimum self-bond receives
///         the SAME `equalSeatWeight`, independent of how much stake is
///         delegated to it. Signing power — the decentralization vector that
///         protects custody — therefore comes purely from DAO allowlist
///         curation, not from delegated capital. Delegation drives ONLY
///         fee-reward distribution ({rewardWeight}, Model B) and slashing
///         exposure, never seat weight. This removes the delegation-factor
///         (λ) and maximum-operator-weight machinery and eliminates the
///         delegation-concentration failure mode where a whale delegation
///         could brick wallet formation. An operator's self-bond still gates
///         eligibility (skin-in-the-game floor) but does not scale seat
///         weight.
/// @dev Weight synchronization to the registry is permissionless
///      (`refreshAuthorization`) and follows the registry's two-step
///      decrease machinery: increases apply immediately, decreases are
///      requested and only recorded as synced once the registry approves
///      them after its authorization decrease delay. Because seat weight is
///      flat, the only events that move it are (de)activation in the signer
///      registry and a self-bond withdrawal that crosses `minSelfBond` — a
///      pure delegation change never files an authorization decrease.
///      Malicious behavior reports are forwarded to the slashing module on a
///      path that never reverts — the Bridge lifecycle depends on it.
contract SeatAllocator is
    Initializable,
    OwnableUpgradeable,
    IFrostAuthorizationSource,
    ISeatAllocator
{
    ISeatAllocatorWalletRegistry public frostWalletRegistry;
    ISignerRegistry public signerRegistry;
    ISeatAllocatorStakeVault public stakeVault;
    ISlashingModule public slashingModule;
    IWalletExposureLedger public walletExposureLedger;
    IRewardsDistributor public rewardsDistributor;

    /// @notice Governance delay applied to every two-step parameter update.
    uint64 public governanceDelay;

    /// @notice The uniform seat/signing weight assigned to EVERY eligible
    ///         operator — one that is allowlisted, `Active` in the signer
    ///         registry, and whose effective self-bond clears the vault's
    ///         minimum self-bond. Seat weight does NOT scale with delegation,
    ///         so this single value is what `currentWeight` returns for every
    ///         eligible operator and 0 for everyone else.
    /// @dev CRITICAL INVARIANT: `equalSeatWeight` MUST be >= the FROST
    ///      registry's own `minimumAuthorization` (40,000e18 at genesis).
    ///      The registry treats a provider as pool-eligible only while its
    ///      `eligibleStake >= minimumAuthorization`; since the allocator
    ///      files exactly `equalSeatWeight` as every eligible operator's
    ///      authorization, a value below the registry minimum would push
    ///      EVERY eligible operator below the registry's pool-eligibility
    ///      floor and brick wallet formation. Because the value is identical
    ///      for all operators, its absolute magnitude does not affect
    ///      selection (selection is uniform by curation); it only has to clear
    ///      the registry floor and fit in a uint96. This invariant is now
    ///      machine-enforced: both steps of the two-step setter reject a zero
    ///      value (`ZeroEqualSeatWeight`) and any value below
    ///      `frostWalletRegistry.minimumAuthorization()`
    ///      (`EqualSeatWeightBelowRegistryMinimum`). Finalize re-reads the
    ///      registry minimum because it can rise during the governance delay.
    uint96 public equalSeatWeight;
    uint96 public newEqualSeatWeight;
    uint256 public equalSeatWeightChangeInitiated;

    /// @notice The weight the registry currently knows for each staking
    ///         provider. `authorizedWeight` returns this value — NOT the
    ///         live computation — to keep pool and registry consistent.
    mapping(address => uint96) public lastSyncedWeight;

    /// @notice Target weight of a requested-but-unapproved authorization
    ///         decrease per staking provider.
    mapping(address => uint96) public pendingDecreaseTarget;

    /// @notice True if an authorization decrease has been requested at the
    ///         registry and not yet approved.
    mapping(address => bool) public decreasePending;

    /// @notice Set when a malicious behavior report touched the provider's
    ///         stake; signals that `refreshAuthorization` should be called.
    ///         Cleared on refresh.
    mapping(address => bool) public weightDirty;

    /// @notice Exposure epoch floor captured for a staking provider when the
    ///         registry approves one of its authorization decreases. A
    ///         decrease can only be approved after the sortition pool has
    ///         been re-synced to the reduced weight — the registry lifts the
    ///         decrease clock off `type(uint64).max` only inside the pool
    ///         sync — so any wallet that a still-stale pool leaf could have
    ///         been selected into was registered at an exposure epoch at or
    ///         below this floor. `canFinalizeUndelegate` gates on the floor
    ///         as well as the request epoch, closing the window where an exit
    ///         requested while the pool leaf was still stale could finalize
    ///         while a wallet its weight influenced during the pre-sync
    ///         window is still live.
    /// @dev Honest disclosure of an accepted residual on the undelegation
    ///      route (this documents behavior; it does NOT change the exit
    ///      gate). Under equal seat weight a delegator undelegation does not
    ///      move `currentWeight`, so `refreshAuthorization` files no
    ///      authorization decrease and the exposure floor is not advanced;
    ///      the exit gate therefore reduces to the plain epoch gate (finalize
    ///      once wallets with epoch <= epochAtRequest close). Consequence: a
    ///      delegator's still-pending capital that backs a wallet FORMED
    ///      AFTER the undelegation request (Model-B slashing draws on the
    ///      delegated pool of every wallet the operator is selected into) is
    ///      NOT lifecycle-coupled on the undelegation route — it can be
    ///      withdrawn, after the epoch-gated delay, while such a post-request
    ///      wallet is still live. The GUARANTEED slashing collateral for any
    ///      live wallet is its seats' self-bond first-loss tranche, which IS
    ///      lifecycle-coupled (a self-bond withdrawal crossing `minSelfBond`
    ///      drives `currentWeight` -> 0, the decrease two-step, and the floor
    ///      advance). This is an accepted residual: given per-seat slash
    ///      amounts are far below per-seat self-bond, self-bond first-loss
    ///      over-covers realistic slashes regardless of delegated collateral.
    mapping(address => uint64) public exposureFloorEpoch;

    // Reserved storage space in case we need to add more variables.
    // The convention from OpenZeppelin suggests the storage space should
    // add up to 50 slots. Removing the delegation-factor and
    // maximum-operator-weight parameters (Option B: flat seat weight) freed
    // slots, so the gap is widened to keep the reserve at 50 slots.
    // See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
    // slither-disable-next-line unused-state
    uint256[37] private __gap;

    event WeightIncreased(
        address indexed stakingProvider,
        uint96 oldWeight,
        uint96 newWeight
    );
    event WeightDecreaseRequested(
        address indexed stakingProvider,
        uint96 oldWeight,
        uint96 newWeight
    );
    event WeightDecreaseFinalized(
        address indexed stakingProvider,
        uint96 oldWeight,
        uint96 newWeight
    );
    event ExposureFloorAdvanced(
        address indexed stakingProvider,
        uint64 floorEpoch
    );
    event MaliciousBehaviorReported(
        address indexed notifier,
        uint96 perSeatAmount,
        uint256 rewardMultiplier,
        address[] stakingProviders
    );
    event SlashReportFailed(
        address indexed notifier,
        address[] stakingProviders
    );
    event AuthorizationSyncFailed(address indexed stakingProvider);
    event EqualSeatWeightUpdateStarted(
        uint96 newEqualSeatWeight,
        uint256 timestamp
    );
    event EqualSeatWeightUpdated(uint96 equalSeatWeight);

    error ZeroAddress();
    error NotWalletRegistry();
    error NoDecreasePending();
    error ZeroEqualSeatWeight();
    error EqualSeatWeightBelowRegistryMinimum();

    modifier onlyWalletRegistry() {
        if (msg.sender != address(frostWalletRegistry)) {
            revert NotWalletRegistry();
        }
        _;
    }

    modifier onlyAfterGovernanceDelay(uint256 changeInitiatedTimestamp) {
        GovernanceUtils.onlyAfterGovernanceDelay(
            changeInitiatedTimestamp,
            governanceDelay
        );
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @dev Initializes upgradable contract on deployment.
    /// @param _frostWalletRegistry Address of the FROST wallet registry.
    /// @param _signerRegistry Address of the signer registry.
    /// @param _stakeVault Address of the stake vault.
    /// @param _slashingModule Address of the slashing module.
    /// @param _walletExposureLedger Address of the wallet exposure ledger.
    /// @param _rewardsDistributor Address of the rewards distributor.
    /// @param _governanceDelay Governance delay for two-step parameter
    ///        updates, in seconds.
    function initialize(
        address _frostWalletRegistry,
        address _signerRegistry,
        address _stakeVault,
        address _slashingModule,
        address _walletExposureLedger,
        address _rewardsDistributor,
        uint64 _governanceDelay
    ) external initializer {
        if (
            _frostWalletRegistry == address(0) ||
            _signerRegistry == address(0) ||
            _stakeVault == address(0) ||
            _slashingModule == address(0) ||
            _walletExposureLedger == address(0) ||
            _rewardsDistributor == address(0)
        ) {
            revert ZeroAddress();
        }

        __Ownable_init();

        frostWalletRegistry = ISeatAllocatorWalletRegistry(
            _frostWalletRegistry
        );
        signerRegistry = ISignerRegistry(_signerRegistry);
        stakeVault = ISeatAllocatorStakeVault(_stakeVault);
        slashingModule = ISlashingModule(_slashingModule);
        walletExposureLedger = IWalletExposureLedger(_walletExposureLedger);
        rewardsDistributor = IRewardsDistributor(_rewardsDistributor);
        governanceDelay = _governanceDelay;

        // Default equals the FROST registry's genesis minimumAuthorization
        // (40,000e18); see the storage-var invariant. Uniform across all
        // eligible operators, so its magnitude does not affect selection.
        equalSeatWeight = 40_000e18;
    }

    /// @notice Begins the equal seat weight update process.
    /// @param _newEqualSeatWeight New uniform seat weight assigned to every
    ///        eligible active operator.
    /// @dev Reverts on a zero value (`ZeroEqualSeatWeight`) and, for fast
    ///      feedback, on any value below the FROST registry's own
    ///      `minimumAuthorization()` (`EqualSeatWeightBelowRegistryMinimum`):
    ///      `_newEqualSeatWeight` MUST be >= the registry minimum, or every
    ///      eligible operator's synced authorization would fall below the
    ///      registry's pool-eligibility floor and no wallet could form. The
    ///      binding enforcement is at {finalizeEqualSeatWeightUpdate} (the
    ///      registry minimum can rise during the governance delay); this
    ///      begin-time check only surfaces an obviously-invalid target early.
    ///      The value's absolute magnitude is otherwise immaterial to
    ///      selection — it is identical for all operators.
    function beginEqualSeatWeightUpdate(uint96 _newEqualSeatWeight)
        external
        onlyOwner
    {
        if (_newEqualSeatWeight == 0) {
            revert ZeroEqualSeatWeight();
        }
        if (_newEqualSeatWeight < frostWalletRegistry.minimumAuthorization()) {
            revert EqualSeatWeightBelowRegistryMinimum();
        }
        newEqualSeatWeight = _newEqualSeatWeight;
        /* solhint-disable not-rely-on-time */
        equalSeatWeightChangeInitiated = block.timestamp;
        emit EqualSeatWeightUpdateStarted(_newEqualSeatWeight, block.timestamp);
        /* solhint-enable not-rely-on-time */
    }

    /// @notice Finalizes the equal seat weight update process.
    /// @dev Can be called only after the governance delay elapsed. Re-checks
    ///      the registry-minimum invariant here — this is the binding
    ///      enforcement point — because the FROST registry's own
    ///      `minimumAuthorization()` can rise during the governance delay: a
    ///      pending target that cleared the floor at begin time but now sits
    ///      below it is rejected (`EqualSeatWeightBelowRegistryMinimum`) so a
    ///      finalize can never push every eligible operator under the
    ///      registry floor and brick wallet formation.
    function finalizeEqualSeatWeightUpdate()
        external
        onlyOwner
        onlyAfterGovernanceDelay(equalSeatWeightChangeInitiated)
    {
        if (newEqualSeatWeight < frostWalletRegistry.minimumAuthorization()) {
            revert EqualSeatWeightBelowRegistryMinimum();
        }
        equalSeatWeight = newEqualSeatWeight;
        emit EqualSeatWeightUpdated(newEqualSeatWeight);
        equalSeatWeightChangeInitiated = 0;
        newEqualSeatWeight = 0;
    }

    /// @notice See {ISeatAllocator-currentWeight}. The uniform seat weight:
    ///         ```
    ///         if (!isActive(p))            return 0;
    ///         selfBond = selfBondOf(p) - pendingSelfBondWithdrawalOf(p);
    ///         if (selfBond < minSelfBond)  return 0;
    ///         return equalSeatWeight;
    ///         ```
    ///         Every allowlisted, active operator whose effective self-bond
    ///         clears the vault's minimum self-bond receives the SAME
    ///         `equalSeatWeight`; everyone else receives 0. Delegated stake,
    ///         pending undelegations, and the removed delegation-factor (λ) /
    ///         maximum-operator-weight caps have NO effect on seat weight —
    ///         signing power is uniform-by-curation. Delegation drives fee
    ///         rewards ({rewardWeight}) and slashing exposure only.
    /// @dev The self-bond subtraction is clamped at zero so a transiently
    ///      inconsistent vault view can never make this function revert — it
    ///      sits on permissionless refresh paths the vault itself calls into.
    ///      The effective-self-bond floor is the sole skin-in-the-game gate;
    ///      it is deliberately NOT scaled into the returned weight.
    function currentWeight(address stakingProvider)
        public
        view
        override
        returns (uint96)
    {
        if (!signerRegistry.isActive(stakingProvider)) {
            return 0;
        }

        uint256 selfBondTotal = stakeVault.selfBondOf(stakingProvider);
        uint256 pendingSelfBondWithdrawal = stakeVault
            .pendingSelfBondWithdrawalOf(stakingProvider);
        uint256 selfBond = selfBondTotal > pendingSelfBondWithdrawal
            ? selfBondTotal - pendingSelfBondWithdrawal
            : 0;

        if (selfBond < stakeVault.minSelfBond()) {
            return 0;
        }

        return equalSeatWeight;
    }

    /// @notice The staking provider's UNCAPPED reward weight: the total
    ///         delegated capital backing the provider
    ///         (`selfBondOf + delegatedAssetsOf`), used solely to apportion
    ///         fee-reward revenue across operators.
    /// @dev This is deliberately NOT the same quantity as {currentWeight}.
    ///      Seat/signing weight ({currentWeight}) is UNIFORM — every eligible
    ///      operator gets the same `equalSeatWeight` — because the
    ///      decentralization vector that matters (how many signing seats an
    ///      operator can win) is set purely by DAO allowlist curation, not by
    ///      delegated capital. Revenue is a different axis: if an operator
    ///      attracts more delegated capital it is fair the pool earns
    ///      proportionally more, so the reward weight tracks the operator's
    ///      full uncapped capital while seat weight stays flat. Delegation
    ///      therefore never buys signing power, only a proportional share of
    ///      rewards (and matching slashing exposure).
    ///
    ///      The eligibility gate is shared with {currentWeight}: this returns
    ///      0 whenever `currentWeight == 0`, so a provider that is not an
    ///      active, allowlisted, sufficiently self-bonded operator
    ///      signer earns nothing — rewards are never paid to a non-signer.
    ///      Otherwise it returns the raw uncapped sum clamped to
    ///      `type(uint96).max` (the total T supply fits in a uint96, but the
    ///      clamp is kept as defense in depth). The sum deliberately does NOT
    ///      subtract pending undelegations or queued self-bond withdrawals:
    ///      per design §6 pending-exit capital stays slashable AND
    ///      reward-earning until finalization, and `selfBondOf` /
    ///      `delegatedAssetsOf` already include it.
    ///
    ///      Boundary case — the self-bond floor: a pending self-bond
    ///      withdrawal that drops effective self-bond below `minSelfBond`
    ///      zeroes reward weight for the whole pool (currentWeight becomes 0),
    ///      overriding the pending-exit-keeps-earning rule — the operator has
    ///      ceased to be a qualified signer. This is the same wind-down state
    ///      as deactivation, reached via the self-bond path. It differs from a
    ///      pending *undelegation*, which keeps earning: `currentWeight`
    ///      subtracts the queued self-bond withdrawal BEFORE its `minSelfBond`
    ///      check, so only the self-bond path can cross the eligibility floor.
    function rewardWeight(address stakingProvider)
        public
        view
        returns (uint96)
    {
        if (currentWeight(stakingProvider) == 0) {
            return 0;
        }

        uint256 raw = uint256(stakeVault.selfBondOf(stakingProvider)) +
            uint256(stakeVault.delegatedAssetsOf(stakingProvider));

        if (raw > type(uint96).max) {
            return type(uint96).max;
        }
        return uint96(raw);
    }

    /// @notice See {ISeatAllocator-refreshAuthorization}. Permissionless.
    ///         Computes the current weight and synchronizes it to the
    ///         registry: an increase is filed immediately
    ///         (`authorizationIncreased`) and recorded as synced; a
    ///         decrease is requested (`authorizationDecreaseRequested`) and
    ///         recorded as the pending target, to be finalized when the
    ///         registry calls `approveAuthorizationDecrease` after its
    ///         authorization decrease delay. Always forwards the provider's
    ///         UNCAPPED reward weight ({rewardWeight}) — not the flat, uniform
    ///         seat weight — to the rewards distributor so revenue tracks the
    ///         operator's delegated capital (Model B). Pending-exit capital
    ///         keeps earning until finalization because {rewardWeight} does
    ///         not subtract it; only losing eligibility (weight to 0) or a
    ///         drop in actual capital changes the reward weight.
    /// @dev While a decrease is pending at the registry the request can
    ///      only be re-pointed further down (or to a different lower
    ///      target); a recovery to or above the synced weight has to wait
    ///      until the registry approves the pending decrease — the next
    ///      refresh after approval files the increase. Re-requesting the
    ///      same target is skipped so permissionless refreshes cannot
    ///      needlessly restart the registry-side decrease clock.
    ///
    ///      The registry sync and rewards distributor calls are guarded:
    ///      this function sits on paths that must not be blocked by a
    ///      misbehaving registry or distributor (`StakeVault` exit
    ///      finalization, `SignerRegistry.ejectOperator`). On failure the
    ///      local bookkeeping is left untouched, the provider is marked
    ///      dirty, and `AuthorizationSyncFailed` is emitted — a later
    ///      permissionless `refreshAuthorization` completes the sync.
    function refreshAuthorization(address stakingProvider) external override {
        uint96 newWeight = currentWeight(stakingProvider);
        uint96 syncedWeight = lastSyncedWeight[stakingProvider];

        weightDirty[stakingProvider] = false;

        if (decreasePending[stakingProvider]) {
            if (
                newWeight < syncedWeight &&
                newWeight != pendingDecreaseTarget[stakingProvider]
            ) {
                try
                    frostWalletRegistry.authorizationDecreaseRequested(
                        stakingProvider,
                        syncedWeight,
                        newWeight
                    )
                {
                    pendingDecreaseTarget[stakingProvider] = newWeight;
                    emit WeightDecreaseRequested(
                        stakingProvider,
                        syncedWeight,
                        newWeight
                    );
                } catch {
                    weightDirty[stakingProvider] = true;
                    emit AuthorizationSyncFailed(stakingProvider);
                    return;
                }
            }
        } else if (newWeight > syncedWeight) {
            try
                frostWalletRegistry.authorizationIncreased(
                    stakingProvider,
                    syncedWeight,
                    newWeight
                )
            {
                lastSyncedWeight[stakingProvider] = newWeight;
                emit WeightIncreased(stakingProvider, syncedWeight, newWeight);
            } catch {
                weightDirty[stakingProvider] = true;
                emit AuthorizationSyncFailed(stakingProvider);
                return;
            }
        } else if (newWeight < syncedWeight) {
            try
                frostWalletRegistry.authorizationDecreaseRequested(
                    stakingProvider,
                    syncedWeight,
                    newWeight
                )
            {
                decreasePending[stakingProvider] = true;
                pendingDecreaseTarget[stakingProvider] = newWeight;
                emit WeightDecreaseRequested(
                    stakingProvider,
                    syncedWeight,
                    newWeight
                );
            } catch {
                weightDirty[stakingProvider] = true;
                emit AuthorizationSyncFailed(stakingProvider);
                return;
            }
        }

        // Reward accrual tracks the UNCAPPED reward weight (Model B), while
        // the registry-sync calls above use the flat, uniform seat weight.
        // dev: the try/catch guards only the onWeightChanged call, NOT the
        // evaluation of the rewardWeight(p) argument — but that is safe:
        // rewardWeight cannot revert (non-reverting views plus a
        // non-overflowing uint96 add-and-clamp), and currentWeight(p) is
        // already evaluated unprotected earlier on this path, so wiring the
        // uncapped weight in here introduces no new revert surface.
        try
            rewardsDistributor.onWeightChanged(
                stakingProvider,
                rewardWeight(stakingProvider)
            )
        {} catch {
            weightDirty[stakingProvider] = true;
            emit AuthorizationSyncFailed(stakingProvider);
        }
    }

    /// @notice Returns the authorization weight the registry currently
    ///         knows for the staking provider — the last synced value, not
    ///         the live computation. Mirrors `FrostAllowlist` semantics so
    ///         pool and registry stay consistent between refreshes.
    function authorizedWeight(address stakingProvider, address)
        external
        view
        override
        returns (uint96)
    {
        return lastSyncedWeight[stakingProvider];
    }

    /// @notice Finalizes a previously requested authorization decrease.
    ///         Called by the registry once its authorization decrease delay
    ///         elapsed. Captures the provider's current exposure epoch as the
    ///         exposure floor: the decrease's approval is proof the sortition
    ///         pool has already been re-synced to the reduced weight, so every
    ///         wallet a still-stale pool leaf could have been selected into is
    ///         registered at an epoch at or below this floor and the exit gate
    ///         can no longer be escaped by such a wallet.
    /// @dev Can only be called by the FROST wallet registry. Reverting here
    ///      is safe — this sits on an exit path, not on the Bridge
    ///      lifecycle path. The exposure epoch counter is monotonic, so the
    ///      captured floor never decreases across successive approvals.
    /// @return The new (decreased) authorization weight.
    function approveAuthorizationDecrease(address stakingProvider)
        external
        override
        onlyWalletRegistry
        returns (uint96)
    {
        if (!decreasePending[stakingProvider]) {
            revert NoDecreasePending();
        }

        uint96 oldWeight = lastSyncedWeight[stakingProvider];
        uint96 newWeight = pendingDecreaseTarget[stakingProvider];

        lastSyncedWeight[stakingProvider] = newWeight;
        decreasePending[stakingProvider] = false;
        delete pendingDecreaseTarget[stakingProvider];

        uint64 floorEpoch = walletExposureLedger.currentEpoch(stakingProvider);
        exposureFloorEpoch[stakingProvider] = floorEpoch;

        emit WeightDecreaseFinalized(stakingProvider, oldWeight, newWeight);
        emit ExposureFloorAdvanced(stakingProvider, floorEpoch);
        return newWeight;
    }

    /// @notice Role lookup for registry reward withdrawal. The owner is the
    ///         allocator's governance, the beneficiary comes from the
    ///         signer registry, and the authorizer is unused.
    function rolesOf(address stakingProvider)
        external
        view
        override
        returns (
            address stakeOwner,
            address payable beneficiary,
            address authorizer
        )
    {
        return (
            owner(),
            signerRegistry.beneficiaryOf(stakingProvider),
            address(0)
        );
    }

    /// @notice Books a malicious behavior report against the listed staking
    ///         providers (one entry per offending seat): forwards the
    ///         per-seat slash to the slashing module — which applies the
    ///         economic haircut atomically — and marks each provider's
    ///         weight dirty so anyone can subsequently call
    ///         `refreshAuthorization` to sync the reduced weight. No
    ///         registry callbacks are made here.
    /// @dev Can only be called by the FROST wallet registry. Past the
    ///      caller check this function MUST NOT revert — the Bridge
    ///      lifecycle (`seize` on timeout/fraud paths) depends on it. The
    ///      slashing module call is wrapped in try/catch and guarded on
    ///      code presence as defense in depth; a failure only emits
    ///      `SlashReportFailed`.
    function reportMaliciousBehavior(
        uint96 amount,
        uint256 rewardMultiplier,
        address notifier,
        address[] memory stakingProviders
    ) external override onlyWalletRegistry {
        for (uint256 i = 0; i < stakingProviders.length; i++) {
            weightDirty[stakingProviders[i]] = true;
        }

        emit MaliciousBehaviorReported(
            notifier,
            amount,
            rewardMultiplier,
            stakingProviders
        );

        if (address(slashingModule).code.length == 0) {
            emit SlashReportFailed(notifier, stakingProviders);
            return;
        }

        try
            slashingModule.report(
                stakingProviders,
                amount,
                rewardMultiplier,
                notifier
            )
        {} catch {
            emit SlashReportFailed(notifier, stakingProviders);
        }
    }

    /// @notice See {ISeatAllocator-canFinalizeUndelegate}. True only if the
    ///         staking provider has no live wallet whose exposure epoch is at
    ///         or before `max(epochAtRequest, exposureFloorEpoch)` AND no
    ///         authorization decrease is still awaiting registry approval —
    ///         i.e. every wallet the exiting stake could have influenced,
    ///         including any selected during the pre-sync window on a stale
    ///         pool leaf, is closed or terminated.
    /// @dev Two load-bearing gates close the phantom-weight window:
    ///      - `decreasePending == false`: a requested-but-unapproved decrease
    ///        means the sortition pool may not yet reflect the reduced weight,
    ///        so a wallet could still be selecting this provider at a stale
    ///        leaf. The exit is held until the registry approves the decrease
    ///        — approval guarantees the pool was re-synced first and captures
    ///        the exposure floor. (`decreasePending` clears only via
    ///        `approveAuthorizationDecrease`, which the registry permits only
    ///        after the pool sync, so this can never lock an exit
    ///        permanently: a permissionless refresh + registry approval always
    ///        clears it.)
    ///      - `exposureFloorEpoch`: any wallet selected during the pre-sync
    ///        window was registered before the approval that captured the
    ///        floor, so its epoch is at or below the floor. Gating on
    ///        `max(epochAtRequest, exposureFloorEpoch)` forces the exit to
    ///        wait for such a wallet to close.
    function canFinalizeUndelegate(
        address stakingProvider,
        uint64 epochAtRequest
    ) external view override returns (bool) {
        if (decreasePending[stakingProvider]) {
            return false;
        }

        uint64 floorEpoch = exposureFloorEpoch[stakingProvider];
        uint64 gateEpoch = epochAtRequest > floorEpoch
            ? epochAtRequest
            : floorEpoch;

        return
            !walletExposureLedger.hasLiveExposureAtOrBefore(
                stakingProvider,
                gateEpoch
            );
    }
}
