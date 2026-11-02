// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../bridge/BridgeState.sol";
import "../bridge/Redemption.sol";

/// @notice Test harness for the `Redemption` library.
/// @dev `Redemption.isRebateAuthorizedForRedemption` is an internal library
///      function. Its `self.rebateStaking == address(0)` guard is unreachable
///      through `Redemption.requestRedemption`, because the caller checks
///      `self.rebateStaking != address(0)` before it ever calls the function.
///      This harness holds the library's own `BridgeState.Storage` and calls
///      the function directly, so the guard can be exercised with the rebate
///      staking contract unset.
contract TestRedemption {
    BridgeState.Storage internal state;

    /// @notice Sets the rebate staking contract the library reads.
    /// @param rebateStaking The address of the rebate staking contract, or
    ///        the zero address for the "no rebate staking" case.
    function setRebateStaking(address rebateStaking) external {
        state.rebateStaking = rebateStaking;
    }

    /// @notice Calls `Redemption.isRebateAuthorizedForRedemption`.
    /// @param balanceOwner The Bank balance owner of the redemption.
    /// @param redeemer The redeemer named as the rebate target.
    /// @return True when the redeemer may be credited with rebate accounting
    ///         against the given balance owner.
    function isRebateAuthorizedForRedemption(
        address balanceOwner,
        address redeemer
    ) external view returns (bool) {
        return
            Redemption.isRebateAuthorizedForRedemption(
                state,
                balanceOwner,
                redeemer
            );
    }
}
