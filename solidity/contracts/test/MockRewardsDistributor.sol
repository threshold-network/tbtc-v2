// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../staking/api/IRewardsDistributor.sol";
import "../staking/api/IStakeVault.sol";

/// @dev Test helper implementing `IRewardsDistributor`. Records calls and
///      forwards reward credits to a stake vault (which accepts
///      `creditReward` only from its wired rewards distributor).
contract MockRewardsDistributor is IRewardsDistributor {
    address public lastWeightChangedProvider;
    uint96 public lastWeight;
    uint256 public onWeightChangedCalls;
    uint256 public notifiedRewards;
    address public settlementVault;
    mapping(address => uint256) public pendingSettlement;

    function recoverUndistributedRewards(address)
        external
        pure
        override
        returns (uint256)
    {
        return 0;
    }

    function onWeightChanged(address stakingProvider, uint96 newWeight)
        external
        override
    {
        lastWeightChangedProvider = stakingProvider;
        lastWeight = newWeight;
        onWeightChangedCalls += 1;
    }

    function notifyReward(uint256 tbtcAmount) external override {
        notifiedRewards += tbtcAmount;
    }

    function configureSettlement(
        address stakeVault,
        address stakingProvider,
        uint256 amount
    ) external {
        settlementVault = stakeVault;
        pendingSettlement[stakingProvider] = amount;
    }

    function settleOperator(address stakingProvider) external override {
        uint256 amount = pendingSettlement[stakingProvider];
        if (amount == 0) return;
        pendingSettlement[stakingProvider] = 0;
        IStakeVault(settlementVault).creditReward(stakingProvider, amount);
    }

    /// @dev Forwards a reward credit to the given vault. The vault only
    ///      accepts credits from its wired rewards distributor, so tests
    ///      drive credits through this helper. The TBTC must already have
    ///      been transferred to the vault.
    function creditRewardViaVault(
        address stakeVault,
        address stakingProvider,
        uint256 tbtcAmount
    ) external {
        IStakeVault(stakeVault).creditReward(stakingProvider, tbtcAmount);
    }
}
