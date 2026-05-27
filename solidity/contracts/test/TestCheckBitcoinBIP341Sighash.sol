// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../bridge/CheckBitcoinBIP341Sighash.sol";

contract TestCheckBitcoinBIP341Sighash {
    function computeKeyPathSighash(
        uint32 version,
        uint32 locktime,
        CheckBitcoinBIP341Sighash.TransactionInput[] calldata inputs,
        CheckBitcoinBIP341Sighash.InputPrevout[] calldata prevouts,
        CheckBitcoinBIP341Sighash.TransactionOutput[] calldata outputs,
        uint32 signedInputIndex,
        uint8 sighashType
    ) external pure returns (bytes32) {
        return
            CheckBitcoinBIP341Sighash.computeKeyPathSighash(
                version,
                locktime,
                inputs,
                prevouts,
                outputs,
                signedInputIndex,
                sighashType
            );
    }
}
