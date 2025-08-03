// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.19;

/// @notice Interface for contracts that can provide and remove liquidity.
interface ILiquidityContainer {
    /// @notice Emitted when liquidity is added to the pool
    event LiquidityAdded(address indexed provider, uint256 amount);

    /// @notice Emitted when liquidity is removed from the pool
    event LiquidityRemoved(address indexed provider, uint256 amount);

    /// @notice Gets rebalancer, can be address(0) if none is configured.
    /// @return The current liquidity manager.
    function getRebalancer() external view returns (address);

    /// @notice Sets the rebalancer address.
    /// @dev Only callable by the owner.
    function setRebalancer(address rebalancer) external;

    /// @notice Checks if the pool can accept liquidity.
    /// @return true if the pool can accept liquidity, false otherwise.
    function canAcceptLiquidity() external view returns (bool);

    /// @notice Adds liquidity to the pool. The tokens should be approved first.
    /// @param amount The amount of liquidity to provide.
    function provideLiquidity(uint256 amount) external;

    /// @notice Removes liquidity from the pool. The tokens will be sent to msg.sender.
    /// @param amount The amount of liquidity to remove.
    function withdrawLiquidity(uint256 amount) external;
}
