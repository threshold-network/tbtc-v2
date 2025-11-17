// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

/// @title Mock Bridge with Rebate Staking hook
/// @notice Minimal mock used to verify BridgeGovernance#setRebateStaking
///         forwards the call to the underlying Bridge implementation.
contract MockBridgeWithRebateStaking {
    address public rebateStaking;

    event RebateStakingSet(address rebateStaking);

    function setRebateStaking(address _rebateStaking) external {
        require(rebateStaking == address(0), "Rebate staking already set");
        require(
            _rebateStaking != address(0),
            "Rebate staking address must not be 0x0"
        );
        rebateStaking = _rebateStaking;
        emit RebateStakingSet(_rebateStaking);
    }
}
