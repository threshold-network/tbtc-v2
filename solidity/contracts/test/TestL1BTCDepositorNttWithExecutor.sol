// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../cross-chain/wormhole/L1BTCDepositorNttWithExecutor.sol";

contract TestL1BTCDepositorNttWithExecutor is L1BTCDepositorNttWithExecutor {
    function transferTbtcWithExecutor(
        uint256 amount,
        bytes32 destinationChainReceiver,
        ExecutorArgs memory executorArgs,
        FeeArgs memory feeArgs,
        bytes32 nonce
    ) external payable {
        _transferTbtcWithExecutor(
            amount,
            destinationChainReceiver,
            executorArgs,
            feeArgs,
            nonce
        );
    }
}
