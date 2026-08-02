// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "./api/IFrostAuthorizationSource.sol";

interface IFrostAllowlistWalletRegistry {
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

/// @title FrostAllowlist
/// @notice DAO-controlled operator weight allowlist for the FROST wallet
///         registry. This contract replaces token staking for FROST operator
///         authorization following the same TIP-092/TIP-100 model used by the
///         production ECDSA wallet registry: staking tokens is no longer
///         required to operate nodes, and beta operators are selected by the
///         DAO-maintained allowlist.
contract FrostAllowlist is IFrostAuthorizationSource, Ownable2StepUpgradeable {
    struct StakingProviderInfo {
        uint96 weight;
        uint96 pendingNewWeight;
        bool decreasePending;
    }

    mapping(address => StakingProviderInfo) public stakingProviders;

    IFrostAllowlistWalletRegistry public walletRegistry;

    event StakingProviderAdded(address indexed stakingProvider, uint96 weight);
    event WeightDecreaseRequested(
        address indexed stakingProvider,
        uint96 oldWeight,
        uint96 newWeight
    );
    event WeightIncreased(
        address indexed stakingProvider,
        uint96 oldWeight,
        uint96 newWeight
    );
    event WeightDecreaseFinalized(
        address indexed stakingProvider,
        uint96 oldWeight,
        uint96 newWeight
    );
    event MaliciousBehaviorIdentified(
        address indexed notifier,
        address[] stakingProviders
    );

    error StakingProviderAlreadyAdded();
    error StakingProviderUnknown();
    error RequestedWeightNotAboveCurrentWeight();
    error RequestedWeightNotBelowCurrentWeight();
    error DecreasePending();
    error NotWalletRegistry();
    error NoDecreasePending();
    error ZeroAddress();
    error ZeroWeight();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _walletRegistry) external initializer {
        if (_walletRegistry == address(0)) {
            revert ZeroAddress();
        }

        __Ownable2Step_init();

        walletRegistry = IFrostAllowlistWalletRegistry(_walletRegistry);
    }

    /// @notice Adds a new staking provider with the given authorization weight.
    ///         The word "staking" is retained for registry compatibility; no T
    ///         tokens are staked or locked.
    function addStakingProvider(address stakingProvider, uint96 weight)
        external
        onlyOwner
    {
        if (stakingProvider == address(0)) {
            revert ZeroAddress();
        }

        if (weight == 0) {
            revert ZeroWeight();
        }

        StakingProviderInfo storage info = stakingProviders[stakingProvider];

        if (info.weight != 0) {
            revert StakingProviderAlreadyAdded();
        }

        emit StakingProviderAdded(stakingProvider, weight);

        info.weight = weight;
        walletRegistry.authorizationIncreased(stakingProvider, 0, weight);
    }

    /// @notice Increases an existing staking provider's authorization weight.
    ///         The word "staking" is retained for registry compatibility; no T
    ///         tokens are staked or locked.
    function increaseWeight(address stakingProvider, uint96 newWeight)
        external
        onlyOwner
    {
        StakingProviderInfo storage info = stakingProviders[stakingProvider];
        uint96 currentWeight = info.weight;

        if (currentWeight == 0) {
            revert StakingProviderUnknown();
        }

        if (info.decreasePending) {
            revert DecreasePending();
        }

        if (newWeight <= currentWeight) {
            revert RequestedWeightNotAboveCurrentWeight();
        }

        emit WeightIncreased(stakingProvider, currentWeight, newWeight);

        info.weight = newWeight;
        walletRegistry.authorizationIncreased(
            stakingProvider,
            currentWeight,
            newWeight
        );
    }

    /// @notice Requests a governance-controlled weight decrease. The registry
    ///         approves the actual decrease after its configured authorization
    ///         delay, preserving the legacy free-rider protection.
    function requestWeightDecrease(address stakingProvider, uint96 newWeight)
        external
        onlyOwner
    {
        StakingProviderInfo storage info = stakingProviders[stakingProvider];
        uint96 currentWeight = info.weight;

        if (currentWeight == 0) {
            revert StakingProviderUnknown();
        }

        if (newWeight >= currentWeight) {
            revert RequestedWeightNotBelowCurrentWeight();
        }

        emit WeightDecreaseRequested(stakingProvider, currentWeight, newWeight);

        info.pendingNewWeight = newWeight;
        info.decreasePending = true;
        walletRegistry.authorizationDecreaseRequested(
            stakingProvider,
            currentWeight,
            newWeight
        );
    }

    function approveAuthorizationDecrease(address stakingProvider)
        external
        override
        returns (uint96)
    {
        if (msg.sender != address(walletRegistry)) {
            revert NotWalletRegistry();
        }

        StakingProviderInfo storage info = stakingProviders[stakingProvider];
        uint96 currentWeight = info.weight;
        uint96 newWeight = info.pendingNewWeight;

        if (currentWeight == 0) {
            revert StakingProviderUnknown();
        }

        if (!info.decreasePending) {
            revert NoDecreasePending();
        }

        emit WeightDecreaseFinalized(stakingProvider, currentWeight, newWeight);

        info.weight = newWeight;
        info.pendingNewWeight = 0;
        info.decreasePending = false;
        return newWeight;
    }

    /// @notice Returns the current authorization weight of the operator
    ///         provider.
    function authorizedWeight(address stakingProvider, address)
        external
        view
        override
        returns (uint96)
    {
        return stakingProviders[stakingProvider].weight;
    }

    /// @notice Event-only malicious behavior hook. FROST authorization is
    ///         permissioned; operator enforcement is handled by DAO weight
    ///         updates rather than token seizure.
    function reportMaliciousBehavior(
        uint96,
        uint256,
        address notifier,
        address[] memory _stakingProviders
    ) external override {
        if (msg.sender != address(walletRegistry)) {
            revert NotWalletRegistry();
        }

        emit MaliciousBehaviorIdentified(notifier, _stakingProviders);
    }

    /// @notice The legacy allowlist has no TBTC reward distributor to mirror
    ///         inactivity into. Kept as a registry-only compatibility no-op.
    function onOperatorInactivity(address[] memory, uint64) external override {
        if (msg.sender != address(walletRegistry)) revert NotWalletRegistry();
    }

    /// @notice The legacy allowlist has no stake-exit exposure floor. Kept as
    ///         a registry-only compatibility no-op.
    function onWalletExposureReconciled(address[] memory) external override {
        if (msg.sender != address(walletRegistry)) revert NotWalletRegistry();
    }

    /// @notice Role lookup for registry reward withdrawal. The beneficiary is
    ///         the operator provider itself and the authorizer is unused.
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
        return (owner(), payable(stakingProvider), address(0));
    }
}
