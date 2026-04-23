// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

/// @notice Test helper whose `receive()` always reverts. Used to verify
///         that `L1BTCDepositorNtt.retrieveTokens` surfaces the
///         low-level-call failure rather than silently succeeding.
contract RevertingReceiver {
    receive() external payable {
        revert("receiver rejects");
    }
}
