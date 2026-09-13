// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../cross-chain/AbstractL1BTCDepositor.sol";
import "../integrator/IBridge.sol";

/// @title ReentrantRefundReceiver
/// @notice Test-only contract that calls `initializeDeposit` on an
///         `AbstractL1BTCDepositor` on its own behalf (so it becomes the
///         deferred gas reimbursement receiver) and, when paid that deferred
///         reimbursement by a real (non-mocked) `ReimbursementPool`, reenters
///         the depositor by calling `finalizeDeposit` again for the same
///         deposit key. Used to prove against a real `ReimbursementPool`
///         that the depositor's "already Finalized" state guard rejects the
///         reentrant call.
contract ReentrantRefundReceiver {
    AbstractL1BTCDepositor public depositor;
    uint256 public immutable depositKey;

    constructor(uint256 _depositKey) {
        depositKey = _depositKey;
    }

    receive() external payable {
        depositor.finalizeDeposit(depositKey);
    }

    function callInitializeDeposit(
        AbstractL1BTCDepositor _depositor,
        IBridgeTypes.BitcoinTxInfo calldata fundingTx,
        IBridgeTypes.DepositRevealInfo calldata reveal,
        bytes32 destinationChainDepositOwner
    ) external {
        depositor = _depositor;
        _depositor.initializeDeposit(
            fundingTx,
            reveal,
            destinationChainDepositOwner
        );
    }
}
