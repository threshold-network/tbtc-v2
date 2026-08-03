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

import "../frost-registry/api/IFrostAuthorizationSource.sol";
import "../staking/SeatAllocator.sol";
import "../staking/api/ISignerRegistry.sol";
import "../staking/api/ISlashingModule.sol";
import "../staking/api/IRewardsDistributor.sol";

/// @dev Settable authorization source used to prove registry source migration
///      and active sortition-roster synchronization.
contract StakingMigrationAuthorizationSource is IFrostAuthorizationSource {
    mapping(address => uint96) public weights;
    uint256 public prepareCalls;
    uint256 public detachCalls;
    bool public revertPreparationWithoutData;
    bool public revertOperatorInactivity;
    bool public revertExposureReconciliation;
    uint256 public operatorInactivityCalls;
    address[] public reconciledProviders;

    function isStatefulAuthorizationSource()
        external
        pure
        override
        returns (bool)
    {
        return true;
    }

    function setWeight(address stakingProvider, uint96 weight) external {
        weights[stakingProvider] = weight;
    }

    function prepareAuthorizationMigration(address[] calldata) external {
        if (revertPreparationWithoutData) {
            // solhint-disable-next-line no-inline-assembly
            assembly {
                revert(0, 0)
            }
        }
        prepareCalls += 1;
    }

    function detachAuthorizationSource(address[] calldata) external {
        detachCalls += 1;
    }

    function setRevertPreparationWithoutData(bool value) external {
        revertPreparationWithoutData = value;
    }

    function setRevertOperatorInactivity(bool value) external {
        revertOperatorInactivity = value;
    }

    function setRevertExposureReconciliation(bool value) external {
        revertExposureReconciliation = value;
    }

    function reconciledProvidersLength() external view returns (uint256) {
        return reconciledProviders.length;
    }

    function authorizedWeight(address stakingProvider, address)
        external
        view
        override
        returns (uint96)
    {
        return weights[stakingProvider];
    }

    function approveAuthorizationDecrease(address)
        external
        pure
        override
        returns (uint96)
    {
        return 0;
    }

    function rolesOf(address)
        external
        pure
        override
        returns (
            address,
            address payable,
            address
        )
    {
        return (address(0), payable(address(0)), address(0));
    }

    function reportMaliciousBehavior(
        uint96,
        uint256,
        address,
        address[] memory
    ) external pure override {}

    function onOperatorInactivity(address[] memory, uint64) external override {
        require(!revertOperatorInactivity, "operator inactivity reverted");
        operatorInactivityCalls += 1;
    }

    function onWalletExposureReconciled(address[] memory stakingProviders)
        external
        override
    {
        require(
            !revertExposureReconciliation,
            "exposure reconciliation reverted"
        );
        for (uint256 i = 0; i < stakingProviders.length; i++) {
            reconciledProviders.push(stakingProviders[i]);
        }
    }
}

/// @dev Phase-0-shaped source deliberately omitting the post-Phase-0
///      inactivity, exposure-reconcile, and migration-hook selectors.
contract LegacyMigrationAuthorizationSource {
    mapping(address => uint96) public weights;

    function isStatefulAuthorizationSource() external pure returns (bool) {
        return false;
    }

    function setWeight(address stakingProvider, uint96 weight) external {
        weights[stakingProvider] = weight;
    }

    function authorizedWeight(address stakingProvider, address)
        external
        view
        returns (uint96)
    {
        return weights[stakingProvider];
    }

    function approveAuthorizationDecrease(address stakingProvider)
        external
        view
        returns (uint96)
    {
        return weights[stakingProvider];
    }

    function rolesOf(address stakingProvider)
        external
        pure
        returns (
            address,
            address payable,
            address
        )
    {
        return (address(0), payable(stakingProvider), address(0));
    }

    function reportMaliciousBehavior(
        uint96,
        uint256,
        address,
        address[] memory
    ) external pure {}
}

/// @dev Test stubs for the delegated staking module's seat allocator and
///      wallet exposure ledger tests. `StakingMockWalletRegistry` records
///      the authorization callbacks the allocator drives and forwards
///      registry-only calls into the allocator (callback sequencing); the
///      remaining stubs provide settable views for the allocator's wired
///      dependencies plus minimal stateful slashing so integration tests
///      can observe a slash landing in the vault.

/// @notice Records the registry-side authorization callbacks and lets
///         tests impersonate the registry towards the allocator.
contract StakingMockWalletRegistry {
    struct AuthorizationCall {
        address stakingProvider;
        uint96 fromAmount;
        uint96 toAmount;
    }

    AuthorizationCall[] public increaseCalls;
    AuthorizationCall[] public decreaseRequestCalls;

    uint96 public lastApprovedWeight;

    address public walletExposureLedger;

    bool public revertOnAuthorizationCalls;
    mapping(address => bool) internal poolMembershipConfigured;
    mapping(address => bool) internal poolMembership;
    mapping(address => address) internal registryOperator;
    address[] public synchronizedRoster;

    /// @dev Mirrors the real FROST registry's pool-eligibility floor
    ///      (`minimumAuthorization()`). Defaults to the genesis 40,000e18 so
    ///      the allocator's equal-seat-weight setters enforce the same
    ///      invariant they do in production; settable so tests can model a
    ///      deployment with a different registry minimum.
    uint96 public minimumAuthorization = 40_000e18;

    function setRevertOnAuthorizationCalls(bool _revert) external {
        revertOnAuthorizationCalls = _revert;
    }

    function setMinimumAuthorization(uint96 _minimumAuthorization) external {
        minimumAuthorization = _minimumAuthorization;
    }

    function setWalletExposureLedger(address ledger) external {
        walletExposureLedger = ledger;
    }

    function setOperatorInPool(address operator, bool inPool) external {
        poolMembershipConfigured[operator] = true;
        poolMembership[operator] = inPool;
    }

    function setStakingProviderOperator(
        address stakingProvider,
        address operator
    ) external {
        registryOperator[stakingProvider] = operator;
    }

    function stakingProviderToOperator(address stakingProvider)
        external
        view
        returns (address)
    {
        address operator = registryOperator[stakingProvider];
        return operator == address(0) ? stakingProvider : operator;
    }

    function isOperatorInPool(address operator) external view returns (bool) {
        return !poolMembershipConfigured[operator] || poolMembership[operator];
    }

    function migrateAuthorizationSource(
        IFrostAuthorizationSource,
        bool,
        address,
        address[] calldata stakingProviders,
        bytes calldata
    ) external {
        // solhint-disable-next-line reason-string, custom-errors
        require(
            !revertOnAuthorizationCalls,
            "StakingMockWalletRegistry: forced revert"
        );
        synchronizedRoster = stakingProviders;
    }

    function synchronizedRosterLength() external view returns (uint256) {
        return synchronizedRoster.length;
    }

    function authorizationIncreased(
        address stakingProvider,
        uint96 fromAmount,
        uint96 toAmount
    ) external {
        // solhint-disable-next-line reason-string, custom-errors
        require(
            !revertOnAuthorizationCalls,
            "StakingMockWalletRegistry: forced revert"
        );
        increaseCalls.push(
            AuthorizationCall(stakingProvider, fromAmount, toAmount)
        );
    }

    function authorizationDecreaseRequested(
        address stakingProvider,
        uint96 fromAmount,
        uint96 toAmount
    ) external {
        // solhint-disable-next-line reason-string, custom-errors
        require(
            !revertOnAuthorizationCalls,
            "StakingMockWalletRegistry: forced revert"
        );
        decreaseRequestCalls.push(
            AuthorizationCall(stakingProvider, fromAmount, toAmount)
        );
    }

    function increaseCallsCount() external view returns (uint256) {
        return increaseCalls.length;
    }

    function decreaseRequestCallsCount() external view returns (uint256) {
        return decreaseRequestCalls.length;
    }

    function callApproveAuthorizationDecrease(
        IFrostAuthorizationSource authorizationSource,
        address stakingProvider
    ) external {
        lastApprovedWeight = authorizationSource.approveAuthorizationDecrease(
            stakingProvider
        );
    }

    function callReportMaliciousBehavior(
        IFrostAuthorizationSource authorizationSource,
        uint96 amount,
        uint256 rewardMultiplier,
        address notifier,
        address[] calldata stakingProviders
    ) external {
        authorizationSource.reportMaliciousBehavior(
            amount,
            rewardMultiplier,
            notifier,
            stakingProviders
        );
    }

    function callOperatorInactivity(
        IFrostAuthorizationSource authorizationSource,
        address[] calldata stakingProviders,
        uint64 ineligibleUntil
    ) external {
        authorizationSource.onOperatorInactivity(
            stakingProviders,
            ineligibleUntil
        );
    }

    function callWalletExposureReconciled(
        IFrostAuthorizationSource authorizationSource,
        address[] calldata stakingProviders
    ) external {
        authorizationSource.onWalletExposureReconciled(stakingProviders);
    }

    function callPrepareAuthorizationMigration(
        SeatAllocator allocator,
        address[] calldata stakingProviders
    ) external {
        allocator.prepareAuthorizationMigration(stakingProviders);
    }

    function callDetachAuthorizationSource(
        SeatAllocator allocator,
        address[] calldata stakingProviders
    ) external {
        allocator.detachAuthorizationSource(stakingProviders);
    }
}

/// @notice Settable operator status / beneficiary source implementing
///         `ISignerRegistry`.
contract StakingMockSignerRegistry is ISignerRegistry {
    mapping(address => OperatorStatus) internal statuses;
    mapping(address => address payable) internal beneficiaries;
    mapping(address => bool) internal beneficiaryConfigured;
    mapping(address => uint16) internal commissions;
    mapping(address => address) internal nodeOperators;
    mapping(address => address) internal providers;

    function setOperatorStatus(address stakingProvider, OperatorStatus status)
        external
    {
        statuses[stakingProvider] = status;
    }

    function setBeneficiary(
        address stakingProvider,
        address payable beneficiary
    ) external {
        beneficiaries[stakingProvider] = beneficiary;
        beneficiaryConfigured[stakingProvider] = true;
    }

    function setCommissionBps(address stakingProvider, uint16 commissionBps)
        external
    {
        commissions[stakingProvider] = commissionBps;
    }

    function setNodeOperator(address stakingProvider, address nodeOperator)
        external
    {
        nodeOperators[stakingProvider] = nodeOperator;
        providers[nodeOperator] = stakingProvider;
    }

    function operatorStatus(address stakingProvider)
        external
        view
        override
        returns (OperatorStatus)
    {
        return statuses[stakingProvider];
    }

    function isActive(address stakingProvider)
        external
        view
        override
        returns (bool)
    {
        return statuses[stakingProvider] == OperatorStatus.Active;
    }

    function nodeOperatorOf(address stakingProvider)
        external
        view
        override
        returns (address)
    {
        address nodeOperator = nodeOperators[stakingProvider];
        return nodeOperator == address(0) ? stakingProvider : nodeOperator;
    }

    function stakingProviderOf(address nodeOperator)
        external
        view
        override
        returns (address)
    {
        address stakingProvider = providers[nodeOperator];
        return stakingProvider == address(0) ? nodeOperator : stakingProvider;
    }

    function beneficiaryOf(address stakingProvider)
        external
        view
        override
        returns (address payable)
    {
        if (beneficiaryConfigured[stakingProvider]) {
            return beneficiaries[stakingProvider];
        }
        return payable(stakingProvider);
    }

    function commissionBpsOf(address stakingProvider)
        external
        view
        override
        returns (uint16)
    {
        return commissions[stakingProvider];
    }

    function commissionScheduleOf(address stakingProvider)
        external
        view
        override
        returns (
            uint16,
            uint16,
            uint64
        )
    {
        return (commissions[stakingProvider], 0, 0);
    }
}

/// @notice Settable stake vault views implementing the allocator-facing
///         vault surface, with a first-loss `applySlash` so tests can
///         observe slashes landing in the vault.
contract StakingMockStakeVault is ISeatAllocatorStakeVault {
    mapping(address => uint96) internal selfBonds;
    mapping(address => uint96) internal delegated;
    mapping(address => uint96) internal pendingUndelegations;
    mapping(address => uint96) internal pendingSelfBondWithdrawals;
    uint96 internal minSelfBondValue;

    uint96 public totalSeized;
    uint256 public applySlashCallCount;
    address public lastSlashedProvider;
    uint96 public lastSlashRequestedAmount;

    function setSelfBond(address stakingProvider, uint96 amount) external {
        selfBonds[stakingProvider] = amount;
    }

    function setDelegatedAssets(address stakingProvider, uint96 amount)
        external
    {
        delegated[stakingProvider] = amount;
    }

    function setPendingUndelegationAssets(
        address stakingProvider,
        uint96 amount
    ) external {
        pendingUndelegations[stakingProvider] = amount;
    }

    function setPendingSelfBondWithdrawal(
        address stakingProvider,
        uint96 amount
    ) external {
        pendingSelfBondWithdrawals[stakingProvider] = amount;
    }

    function setMinSelfBond(uint96 amount) external {
        minSelfBondValue = amount;
    }

    function synchronizeAuthorizationRoster(
        SeatAllocator allocator,
        address[] calldata stakingProviders
    ) external {
        allocator.synchronizeAuthorizationRoster(stakingProviders);
    }

    function selfBondOf(address stakingProvider)
        external
        view
        override
        returns (uint96)
    {
        return selfBonds[stakingProvider];
    }

    function delegatedAssetsOf(address stakingProvider)
        external
        view
        override
        returns (uint96)
    {
        return delegated[stakingProvider];
    }

    function pendingUndelegationAssetsOf(address stakingProvider)
        external
        view
        override
        returns (uint96)
    {
        return pendingUndelegations[stakingProvider];
    }

    function pendingSelfBondWithdrawalOf(address stakingProvider)
        external
        view
        override
        returns (uint96)
    {
        return pendingSelfBondWithdrawals[stakingProvider];
    }

    function minSelfBond() external view override returns (uint96) {
        return minSelfBondValue;
    }

    function sharesOf(address, address)
        external
        pure
        override
        returns (uint256)
    {
        return 0;
    }

    /// @dev First-loss semantics mirroring the spec: self-bond down to
    ///      zero first, then delegated assets; capped at available; never
    ///      reverts.
    function applySlash(address stakingProvider, uint96 amount)
        external
        override
        returns (uint96 seized)
    {
        applySlashCallCount++;
        lastSlashedProvider = stakingProvider;
        lastSlashRequestedAmount = amount;

        uint96 fromSelfBond = amount <= selfBonds[stakingProvider]
            ? amount
            : selfBonds[stakingProvider];
        selfBonds[stakingProvider] -= fromSelfBond;

        uint96 remainder = amount - fromSelfBond;
        uint96 fromDelegated = remainder <= delegated[stakingProvider]
            ? remainder
            : delegated[stakingProvider];
        delegated[stakingProvider] -= fromDelegated;

        seized = fromSelfBond + fromDelegated;
        totalSeized += seized;
    }

    function payoutSeized(address, uint96 amount) external override {
        totalSeized -= amount;
    }

    function creditReward(address, uint256) external override {
        // no-op
    }
}

/// @notice Recording slashing module implementing `ISlashingModule`. Can
///         be configured to revert (to prove the allocator's report path
///         never reverts) and forwards aggregated per-provider totals to a
///         wired vault so integration tests observe the haircut.
contract StakingMockSlashingModule is ISlashingModule {
    StakingMockStakeVault public vault;
    bool public revertOnReport;
    bool public override economicSlashingEnabled;

    uint256 public reportCallCount;
    uint96 public lastPerSeatAmount;
    uint256 public lastRewardMultiplier;
    address public lastNotifier;
    address[] public lastStakingProviders;

    mapping(address => uint256) internal pendingSlashes;

    function setVault(StakingMockStakeVault _vault) external {
        vault = _vault;
    }

    function setRevertOnReport(bool _revertOnReport) external {
        revertOnReport = _revertOnReport;
    }

    function setEconomicSlashingEnabled(bool enabled) external {
        economicSlashingEnabled = enabled;
    }

    function setPendingSlashCount(address stakingProvider, uint256 count)
        external
    {
        pendingSlashes[stakingProvider] = count;
    }

    function lastStakingProvidersCount() external view returns (uint256) {
        return lastStakingProviders.length;
    }

    function report(
        address[] calldata stakingProviders,
        uint96 perSeatAmount,
        uint256 rewardMultiplier,
        address notifier,
        bool requireEconomicSlashing
    ) external override {
        // solhint-disable-next-line reason-string, custom-errors
        require(!revertOnReport, "StakingMockSlashingModule: forced revert");
        require(
            !requireEconomicSlashing || economicSlashingEnabled,
            "StakingMockSlashingModule: economic slashing disabled"
        );

        reportCallCount++;
        lastPerSeatAmount = perSeatAmount;
        lastRewardMultiplier = rewardMultiplier;
        lastNotifier = notifier;
        lastStakingProviders = stakingProviders;

        if (address(vault) == address(0)) {
            return;
        }

        // Aggregate duplicate providers in-memory (per-seat semantics)
        // and apply one slash per unique provider, as the production
        // slashing module is specified to do.
        address[] memory uniqueProviders = new address[](
            stakingProviders.length
        );
        uint96[] memory totals = new uint96[](stakingProviders.length);
        uint256 uniqueCount = 0;
        for (uint256 i = 0; i < stakingProviders.length; i++) {
            bool found = false;
            for (uint256 j = 0; j < uniqueCount; j++) {
                if (uniqueProviders[j] == stakingProviders[i]) {
                    totals[j] += perSeatAmount;
                    found = true;
                    break;
                }
            }
            if (!found) {
                uniqueProviders[uniqueCount] = stakingProviders[i];
                totals[uniqueCount] = perSeatAmount;
                uniqueCount++;
            }
        }

        for (uint256 i = 0; i < uniqueCount; i++) {
            vault.applySlash(uniqueProviders[i], totals[i]);
            pendingSlashes[uniqueProviders[i]]++;
        }
    }

    function pendingSlashCount(address stakingProvider)
        external
        view
        override
        returns (uint256)
    {
        return pendingSlashes[stakingProvider];
    }
}

/// @notice Recording rewards distributor implementing
///         `IRewardsDistributor`.
contract StakingMockRewardsDistributor is IRewardsDistributor {
    uint256 public onWeightChangedCallCount;
    address public lastStakingProvider;
    uint96 public lastWeight;

    bool public revertOnWeightChanged;

    function setRevertOnWeightChanged(bool _revert) external {
        revertOnWeightChanged = _revert;
    }

    function onWeightChanged(address stakingProvider, uint96 newWeight)
        external
        override
    {
        // solhint-disable-next-line reason-string, custom-errors
        require(
            !revertOnWeightChanged,
            "StakingMockRewardsDistributor: forced revert"
        );
        onWeightChangedCallCount++;
        lastStakingProvider = stakingProvider;
        lastWeight = newWeight;
    }

    function notifyReward(uint256) external override {
        // no-op
    }

    function recoverUndistributedRewards(address)
        external
        pure
        override
        returns (uint256)
    {
        return 0;
    }

    function settleOperator(address) external override {}
}
