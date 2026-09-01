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
        uint16 stageChain = _getDefaultSupportedChain();
        uint256 requiredPayment = nttManagerWithExecutor.quoteDeliveryPrice(
            underlyingNttManager,
            stageChain,
            "",
            executorArgs,
            feeArgs
        );
        _transferTbtcWithExecutor(
            amount,
            destinationChainReceiver,
            ExecutorParameterSet({
                executorArgs: executorArgs,
                feeArgs: feeArgs,
                user: msg.sender,
                timestamp: block.timestamp, // solhint-disable-line not-rely-on-time
                cachedRequiredPayment: requiredPayment,
                cachedDestinationChain: stageChain,
                exists: true
            }),
            nonce
        );
    }
}
