// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../staking/api/ISeatAllocator.sol";
import "../staking/api/ISlashingModule.sol";

/// @dev Test helper implementing `ISeatAllocator` with directly settable
///      state. Records `refreshAuthorization` calls, mimics the ledger-based
///      exit gate with a settable oldest-live-epoch, and forwards slash
///      reports to a slashing module (which accepts calls only from its
///      wired seat allocator).
contract MockSeatAllocator is ISeatAllocator {
    mapping(address => uint256) public refreshCount;
    address public lastRefreshedProvider;
    bool public revertOnRefresh;

    mapping(address => uint96) public weights;
    mapping(address => uint256) public override queuedSlashCount;

    // Mimics the wallet exposure ledger view backing the exit gate:
    // exposure exists at or before `epoch` if `hasExposure` and
    // `oldestLiveEpoch <= epoch`.
    mapping(address => bool) public hasExposure;
    mapping(address => uint64) public oldestLiveEpoch;

    function setRevertOnRefresh(bool _revertOnRefresh) external {
        revertOnRefresh = _revertOnRefresh;
    }

    function setWeight(address stakingProvider, uint96 weight) external {
        weights[stakingProvider] = weight;
    }

    function setQueuedSlashCount(address stakingProvider, uint256 count)
        external
    {
        queuedSlashCount[stakingProvider] = count;
    }

    function setExposure(
        address stakingProvider,
        bool _hasExposure,
        uint64 _oldestLiveEpoch
    ) external {
        hasExposure[stakingProvider] = _hasExposure;
        oldestLiveEpoch[stakingProvider] = _oldestLiveEpoch;
    }

    /// @dev Forwards a slash report to the given slashing module. The module
    ///      only accepts reports from its wired seat allocator, so tests
    ///      drive reports through this helper.
    function reportViaModule(
        address slashingModule,
        address[] calldata stakingProviders,
        uint96 perSeatAmount,
        uint256 rewardMultiplier,
        address notifier
    ) external {
        ISlashingModule(slashingModule).report(
            stakingProviders,
            perSeatAmount,
            rewardMultiplier,
            notifier,
            false
        );
    }

    function reportViaModuleWithEnforcement(
        address slashingModule,
        address[] calldata stakingProviders,
        uint96 perSeatAmount,
        uint256 rewardMultiplier,
        address notifier,
        bool requireEconomicSlashing
    ) external {
        ISlashingModule(slashingModule).report(
            stakingProviders,
            perSeatAmount,
            rewardMultiplier,
            notifier,
            requireEconomicSlashing
        );
    }

    function refreshAuthorization(address stakingProvider) external override {
        if (revertOnRefresh) {
            revert("MockSeatAllocator: refresh reverted");
        }
        refreshCount[stakingProvider] += 1;
        lastRefreshedProvider = stakingProvider;
    }

    function checkpointRewards(address) external override {}

    function syncRewardWeightAfterSlash(address) external override {}

    function currentWeight(address stakingProvider)
        external
        view
        override
        returns (uint96)
    {
        return weights[stakingProvider];
    }

    function canFinalizeUndelegate(
        address stakingProvider,
        uint64 epochAtRequest
    ) external view override returns (bool) {
        return
            !(hasExposure[stakingProvider] &&
                oldestLiveEpoch[stakingProvider] <= epochAtRequest);
    }
}
