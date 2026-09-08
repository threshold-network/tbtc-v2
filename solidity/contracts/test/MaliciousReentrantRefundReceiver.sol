// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import {L1BTCDepositorNttWithExecutor, ExecutorArgs, FeeArgs} from "../cross-chain/wormhole/L1BTCDepositorNttWithExecutor.sol";

/// @title Malicious Reentrant Refund Receiver
/// @notice Attacker contract used to verify that the ETH refund
///         `L1BTCDepositorNttWithExecutor.finalizeDeposit` triggers (via the
///         underlying NttManagerWithExecutor's unused-executor-value refund)
///         cannot be used to re-enter `finalizeDeposit` and bypass the
///         checks-effects-interactions ordering (deposit-state flip and
///         staged-parameter deletion both happen before the external call
///         that can trigger this refund).
/// @dev Mirrors the fixed-destination `setExecutorParameters`/`finalizeDeposit`
///      surface: no per-call destination chain argument, since the contract
///      under test only ever transfers to its one configured destination.
contract MaliciousReentrantRefundReceiver {
    L1BTCDepositorNttWithExecutor public immutable target;

    uint256 public attackDepositKey;
    uint256 public attackValue;
    bool public shouldBubbleUpRevert;
    bool public attacking;
    bool public attackAttempted;
    bool public attackSucceeded;
    bytes public lastRevertData;

    constructor(address _target) {
        target = L1BTCDepositorNttWithExecutor(payable(_target));
    }

    receive() external payable {
        if (attacking && !attackAttempted) {
            attackAttempted = true;
            // solhint-disable-next-line avoid-low-level-calls
            (bool success, bytes memory data) = address(target).call{
                value: attackValue
            }(
                abi.encodeWithSelector(
                    target.finalizeDeposit.selector,
                    attackDepositKey
                )
            );
            attackSucceeded = success;
            lastRevertData = data;
            if (shouldBubbleUpRevert) {
                revert("Malicious reentrant call failed");
            }
        }
    }

    /// @notice Stages executor parameters with this contract as both the
    ///         staging caller and the executor refund address, so the mock
    ///         executor manager's unused-value refund lands here.
    function stageExecutorParameters(
        uint256 value,
        bytes calldata signedQuote,
        bytes calldata instructions
    ) external {
        target.setExecutorParameters(
            ExecutorArgs({
                value: value,
                refundAddress: address(this),
                signedQuote: signedQuote,
                instructions: instructions
            }),
            FeeArgs({dbps: 0, payee: address(0)})
        );
    }

    /// @param _depositKey Deposit key the reentrant call attempts to finalize.
    /// @param _value Native value forwarded with the reentrant finalizeDeposit call.
    /// @param _bubbleUp When true, the reentrant attempt's failure is
    ///        re-thrown from `receive`, causing the mock manager's refund
    ///        call (and, in turn, the top-level `finalize`) to revert.
    function setAttackConfig(
        uint256 _depositKey,
        uint256 _value,
        bool _bubbleUp
    ) external {
        attackDepositKey = _depositKey;
        attackValue = _value;
        shouldBubbleUpRevert = _bubbleUp;
    }

    /// @notice Finalizes `depositKey` through the target depositor. The ETH
    ///         refund issued mid-call is the reentrancy vector under test.
    function finalize(uint256 depositKey) external payable {
        attacking = true;
        target.finalizeDeposit{value: msg.value}(depositKey);
        attacking = false;
    }
}
