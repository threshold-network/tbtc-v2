// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../cross-chain/wormhole/L1BTCDepositorNttWithExecutor.sol";

/// @notice Test harness for `L1BTCDepositorNttWithExecutor` that exposes a
///         setter for `fixedDestinationDeposits`, so tests can construct
///         legacy (pre-fixed-destination) deposit state deterministically
///         instead of relying on internal, undocumented Hardhat compiler
///         tasks to locate and mutate the mapping's storage slot directly.
/// @dev Test-only: never deployed outside the test suite. `initialize` is
///      inherited unchanged from `L1BTCDepositorNttWithExecutor`.
contract TestL1BTCDepositorNttWithExecutor is L1BTCDepositorNttWithExecutor {
    function setFixedDestinationDepositForTest(uint256 depositKey, bool value)
        external
    {
        fixedDestinationDeposits[depositKey] = value;
    }
}
