// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

/// @title Bridge Rebate Staking Interface
/// @notice Minimal interface implemented by Bridge contracts that support
///         configuration of the rebate staking address.
interface IBridgeRebateStaking {
    /// @notice Sets the rebate staking address.
    /// @param rebateStaking Address of the rebate staking contract.
    /// @dev Requirements:
    ///      - Rebate staking address must not be already set,
    ///      - Rebate staking address must not be 0x0.
    function setRebateStaking(address rebateStaking) external;
}

