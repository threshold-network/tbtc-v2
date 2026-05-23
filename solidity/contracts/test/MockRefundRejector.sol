// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "./TestL1BTCDepositorNttWithExecutor.sol";

/// @notice Forwards a `transferTbtcWithExecutor` call to a target depositor
///         while refusing to receive ETH back. Used to exercise the
///         "ETH refund failed" path in `_transferTbtcWithExecutor`.
contract MockRefundRejector {
    TestL1BTCDepositorNttWithExecutor public immutable target;

    constructor(TestL1BTCDepositorNttWithExecutor _target) {
        target = _target;
    }

    function callTransfer(
        uint256 amount,
        bytes32 destinationChainReceiver,
        ExecutorArgs memory executorArgs,
        FeeArgs memory feeArgs,
        bytes32 nonce
    ) external payable {
        target.transferTbtcWithExecutor{value: msg.value}(
            amount,
            destinationChainReceiver,
            executorArgs,
            feeArgs,
            nonce
        );
    }

    /// @dev Accept ETH from anyone EXCEPT the depositor we're targeting.
    ///      This lets the executor-leg refund (from the mock NTT manager)
    ///      succeed while the depositor-leg refund (the overpayment refund
    ///      we want to test) reverts at `require(ok, "ETH refund failed")`.
    receive() external payable {
        require(msg.sender != address(target), "rejecting depositor refund");
    }
}
