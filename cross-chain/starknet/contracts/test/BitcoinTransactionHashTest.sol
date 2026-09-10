// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.17;

import "../integrator/AbstractBTCDepositor.sol";

contract BitcoinTransactionHashTest is AbstractBTCDepositor {
    function calculateHash(
        IBridgeTypes.BitcoinTxInfo memory txInfo
    ) external view returns (bytes32) {
        return _calculateBitcoinTxHash(txInfo);
    }
}
