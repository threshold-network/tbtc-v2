// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../cross-chain/AbstractL1BTCDepositor.sol";
import "../integrator/IBridge.sol";

/// @title ReentrantReimbursementReceiver
/// @notice Test-only contract that calls `initializeDeposit` on an
///         `AbstractL1BTCDepositor` on its own behalf (so it becomes the
///         deferred gas reimbursement receiver) and, in its `receive`
///         function -- invoked when `finalizeDeposit` later pays out that
///         deferred refund -- attempts to reenter `finalizeDeposit` for the
///         same deposit. Used to prove against a real (non-mocked)
///         `ReimbursementPool` that the checks-effects-interactions ordering
///         in `finalizeDeposit` (deposit marked `Finalized` before any
///         external call) rejects the reentrant call rather than merely
///         being assumed safe.
contract ReentrantReimbursementReceiver {
    AbstractL1BTCDepositor public depositor;
    uint256 public attackDepositKey;

    bool public attackAttempted;
    bool public attackSucceeded;
    bytes public lastRevertData;

    receive() external payable {
        if (address(depositor) == address(0)) {
            return;
        }

        attackAttempted = true;

        /* solhint-disable avoid-low-level-calls */
        // slither-disable-next-line unchecked-lowlevel,low-level-calls,reentrancy-no-eth,reentrancy-events
        (bool success, bytes memory returnData) = address(depositor).call(
            abi.encodeWithSelector(
                depositor.finalizeDeposit.selector,
                attackDepositKey
            )
        );
        /* solhint-enable avoid-low-level-calls */

        attackSucceeded = success;
        if (!success) {
            lastRevertData = returnData;
        }
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

    /// @notice Sets the deposit key to reenter `finalizeDeposit` with. Must
    ///         be called after `callInitializeDeposit`, since the deposit
    ///         key is not known until that call returns.
    function setAttackDepositKey(uint256 _attackDepositKey) external {
        attackDepositKey = _attackDepositKey;
    }
}
