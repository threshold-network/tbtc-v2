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
/// @notice Stake-derived authorization source for the FROST wallet registry.
///         Replaces `FrostAllowlist` behind the same
///         `IFrostAuthorizationSource` interface: instead of DAO-assigned
///         weight constants, an operator's authorization weight is computed
///         from the operator's self-bond and delegated stake held by the
///         stake vault, capped by the delegation factor and the maximum
///         operator weight, and gated on the signer registry operator
///         status.
/// @dev Weight synchronization to the registry is permissionless
///      (`refreshAuthorization`) and follows the registry's two-step
///      decrease machinery: increases apply immediately, decreases are
///      requested and only recorded as synced once the registry approves
///      them after its authorization decrease delay. Malicious behavior
///      reports are forwarded to the slashing module on a path that never
///      reverts — the Bridge lifecycle depends on it.
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

    /// @notice Delegation factor λ: delegated capacity counted towards the
    ///         weight is capped at `selfBond * delegationFactor`.
    uint16 public delegationFactor;
    uint16 public newDelegationFactor;
    uint256 public delegationFactorChangeInitiated;

    /// @notice Absolute cap on a single operator's authorization weight.
    uint96 public maxOperatorWeight;
    uint96 public newMaxOperatorWeight;
    uint256 public maxOperatorWeightChangeInitiated;

    /// @notice Minimum authorization weight. Weights computing below this
    ///         value resolve to zero. Kept as the allocator's own copy of
    ///         the registry-side parameter so the weight function can
    ///         resolve to a registry-acceptable value (0 or >= minimum).
    uint96 public minimumAuthorization;
    uint96 public newMinimumAuthorization;
    uint256 public minimumAuthorizationChangeInitiated;

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

    // Reserved storage space in case we need to add more variables.
    // The convention from OpenZeppelin suggests the storage space should
    // add up to 50 slots.
    // See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
    // slither-disable-next-line unused-state
    uint256[47] private __gap;

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
    event DelegationFactorUpdateStarted(
        uint16 newDelegationFactor,
        uint256 timestamp
    );
    event DelegationFactorUpdated(uint16 delegationFactor);
    event MaxOperatorWeightUpdateStarted(
        uint96 newMaxOperatorWeight,
        uint256 timestamp
    );
    event MaxOperatorWeightUpdated(uint96 maxOperatorWeight);
    event MinimumAuthorizationUpdateStarted(
        uint96 newMinimumAuthorization,
        uint256 timestamp
    );
    event MinimumAuthorizationUpdated(uint96 minimumAuthorization);

    error ZeroAddress();
    error NotWalletRegistry();
    error NoDecreasePending();
    error ZeroDelegationFactor();
    error ZeroMaxOperatorWeight();

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

        delegationFactor = 4;
        maxOperatorWeight = 2_000_000e18;
        minimumAuthorization = 40_000e18;
    }

    /// @notice Begins the delegation factor update process.
    /// @param _newDelegationFactor New delegation factor λ.
    function beginDelegationFactorUpdate(uint16 _newDelegationFactor)
        external
        onlyOwner
    {
        if (_newDelegationFactor == 0) {
            revert ZeroDelegationFactor();
        }
        newDelegationFactor = _newDelegationFactor;
        /* solhint-disable not-rely-on-time */
        delegationFactorChangeInitiated = block.timestamp;
        emit DelegationFactorUpdateStarted(
            _newDelegationFactor,
            block.timestamp
        );
        /* solhint-enable not-rely-on-time */
    }

    /// @notice Finalizes the delegation factor update process.
    /// @dev Can be called only after the governance delay elapsed.
    function finalizeDelegationFactorUpdate()
        external
        onlyOwner
        onlyAfterGovernanceDelay(delegationFactorChangeInitiated)
    {
        delegationFactor = newDelegationFactor;
        emit DelegationFactorUpdated(newDelegationFactor);
        delegationFactorChangeInitiated = 0;
        newDelegationFactor = 0;
    }

    /// @notice Begins the maximum operator weight update process.
    /// @param _newMaxOperatorWeight New maximum operator weight.
    function beginMaxOperatorWeightUpdate(uint96 _newMaxOperatorWeight)
        external
        onlyOwner
    {
        if (_newMaxOperatorWeight == 0) {
            revert ZeroMaxOperatorWeight();
        }
        newMaxOperatorWeight = _newMaxOperatorWeight;
        /* solhint-disable not-rely-on-time */
        maxOperatorWeightChangeInitiated = block.timestamp;
        emit MaxOperatorWeightUpdateStarted(
            _newMaxOperatorWeight,
            block.timestamp
        );
        /* solhint-enable not-rely-on-time */
    }

    /// @notice Finalizes the maximum operator weight update process.
    /// @dev Can be called only after the governance delay elapsed.
    function finalizeMaxOperatorWeightUpdate()
        external
        onlyOwner
        onlyAfterGovernanceDelay(maxOperatorWeightChangeInitiated)
    {
        maxOperatorWeight = newMaxOperatorWeight;
        emit MaxOperatorWeightUpdated(newMaxOperatorWeight);
        maxOperatorWeightChangeInitiated = 0;
        newMaxOperatorWeight = 0;
    }

    /// @notice Begins the minimum authorization update process.
    /// @param _newMinimumAuthorization New minimum authorization weight.
    function beginMinimumAuthorizationUpdate(uint96 _newMinimumAuthorization)
        external
        onlyOwner
    {
        newMinimumAuthorization = _newMinimumAuthorization;
        /* solhint-disable not-rely-on-time */
        minimumAuthorizationChangeInitiated = block.timestamp;
        emit MinimumAuthorizationUpdateStarted(
            _newMinimumAuthorization,
            block.timestamp
        );
        /* solhint-enable not-rely-on-time */
    }

    /// @notice Finalizes the minimum authorization update process.
    /// @dev Can be called only after the governance delay elapsed.
    function finalizeMinimumAuthorizationUpdate()
        external
        onlyOwner
        onlyAfterGovernanceDelay(minimumAuthorizationChangeInitiated)
    {
        minimumAuthorization = newMinimumAuthorization;
        emit MinimumAuthorizationUpdated(newMinimumAuthorization);
        minimumAuthorizationChangeInitiated = 0;
        newMinimumAuthorization = 0;
    }

    /// @notice See {ISeatAllocator-currentWeight}. The live stake-derived
    ///         weight:
    ///         ```
    ///         selfBond = selfBondOf(p) - pendingSelfBondWithdrawalOf(p)
    ///         raw = selfBond
    ///             + delegatedAssetsOf(p) - pendingUndelegationAssetsOf(p)
    ///         w = min(raw, selfBond * delegationFactor, maxOperatorWeight)
    ///         ```
    ///         and zero if the operator is not `Active`, the effective
    ///         self-bond is below the vault's minimum self-bond, or `w`
    ///         falls below the minimum authorization.
    /// @dev Subtractions are clamped at zero so a transiently inconsistent
    ///      vault view can never make this function revert — it sits on
    ///      permissionless refresh paths the vault itself calls into.
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

        uint256 delegated = stakeVault.delegatedAssetsOf(stakingProvider);
        uint256 pendingUndelegation = stakeVault.pendingUndelegationAssetsOf(
            stakingProvider
        );
        uint256 netDelegated = delegated > pendingUndelegation
            ? delegated - pendingUndelegation
            : 0;

        uint256 weight = selfBond + netDelegated;

        uint256 leverageCap = selfBond * delegationFactor;
        if (weight > leverageCap) {
            weight = leverageCap;
        }
        if (weight > maxOperatorWeight) {
            weight = maxOperatorWeight;
        }

        if (
            selfBond < stakeVault.minSelfBond() || weight < minimumAuthorization
        ) {
            return 0;
        }

        return uint96(weight);
    }

    /// @notice See {ISeatAllocator-refreshAuthorization}. Permissionless.
    ///         Computes the current weight and synchronizes it to the
    ///         registry: an increase is filed immediately
    ///         (`authorizationIncreased`) and recorded as synced; a
    ///         decrease is requested (`authorizationDecreaseRequested`) and
    ///         recorded as the pending target, to be finalized when the
    ///         registry calls `approveAuthorizationDecrease` after its
    ///         authorization decrease delay. Always forwards the live
    ///         weight to the rewards distributor so reward accrual tracks
    ///         weight changes (pending exits stop earning weight-based
    ///         rewards immediately).
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

        try
            rewardsDistributor.onWeightChanged(stakingProvider, newWeight)
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
    ///         elapsed.
    /// @dev Can only be called by the FROST wallet registry. Reverting here
    ///      is safe — this sits on an exit path, not on the Bridge
    ///      lifecycle path.
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

        emit WeightDecreaseFinalized(stakingProvider, oldWeight, newWeight);
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

    /// @notice See {ISeatAllocator-canFinalizeUndelegate}. True if the
    ///         staking provider has no live wallet whose exposure epoch is
    ///         at or before `epochAtRequest` — i.e. every wallet the exited
    ///         stake could have backed is closed or terminated.
    function canFinalizeUndelegate(
        address stakingProvider,
        uint64 epochAtRequest
    ) external view override returns (bool) {
        return
            !walletExposureLedger.hasLiveExposureAtOrBefore(
                stakingProvider,
                epochAtRequest
            );
    }
}
