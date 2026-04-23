// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

/// @notice Test helper that consumes more than 2300 gas in its receive()
///         handler. Any native-token transfer that forwards only the
///         `.transfer()` / `.send()` stipend (2300 gas) will out-of-gas
///         before the SSTORE below can run. Used to pin the audit fix
///         that replaced `.transfer()` with a low-level `.call{value:}`
///         in `L1BTCDepositorNtt.retrieveTokens`.
contract GreedyReceiver {
    uint256 public received;
    uint256 public lastAmount;

    // Writing to two cold storage slots costs well above 2300 gas, so
    // this call succeeds only when the sender forwards (sufficient) gas.
    receive() external payable {
        received += 1;
        lastAmount = msg.value;
    }
}
