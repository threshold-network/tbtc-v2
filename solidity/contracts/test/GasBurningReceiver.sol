// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../cross-chain/AbstractL1BTCDepositor.sol";
import "../integrator/IBridge.sol";

/// @title GasBurningReceiver
/// @notice Test-only contract that calls `initializeDeposit` on an
///         `AbstractL1BTCDepositor` on its own behalf (so it becomes the
///         deferred gas reimbursement receiver) and burns a configurable,
///         non-trivial amount of gas in its `receive` function. Used to
///         prove against a real (non-mocked) `ReimbursementPool` that the
///         finalizer's own reimbursement is unaffected by however much gas
///         this contract burns when it is later paid its deferred refund.
contract GasBurningReceiver {
    uint256 public burnIterations;
    mapping(uint256 => uint256) private sink;

    constructor(uint256 _burnIterations) {
        burnIterations = _burnIterations;
    }

    receive() external payable {
        for (uint256 i = 0; i < burnIterations; i++) {
            // Cold SSTOREs are expensive; this reliably burns tens of
            // thousands of gas per call regardless of EVM/solc tuning.
            sink[i] = block.number + i;
        }
    }

    function callInitializeDeposit(
        AbstractL1BTCDepositor depositor,
        IBridgeTypes.BitcoinTxInfo calldata fundingTx,
        IBridgeTypes.DepositRevealInfo calldata reveal,
        bytes32 destinationChainDepositOwner
    ) external {
        depositor.initializeDeposit(
            fundingTx,
            reveal,
            destinationChainDepositOwner
        );
    }
}
