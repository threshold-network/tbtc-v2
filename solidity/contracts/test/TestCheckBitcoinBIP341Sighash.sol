// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../bridge/CheckBitcoinBIP341Sighash.sol";

contract TestCheckBitcoinBIP341Sighash {
    // `memory` (not `calldata`) for the dynamic arguments: the enlarged
    // multi-mode sighash inlined behind four dynamic arguments overflows the
    // legacy code generator's stack by one slot when they are decoded as
    // `calldata`. The `memory` decoder is shallower and compiles without the IR
    // pipeline. Test-harness detail only.
    function computeKeyPathSighash(
        uint32 version,
        uint32 locktime,
        CheckBitcoinBIP341Sighash.TransactionInput[] memory inputs,
        CheckBitcoinBIP341Sighash.InputPrevout[] memory prevouts,
        CheckBitcoinBIP341Sighash.TransactionOutput[] memory outputs,
        uint32 signedInputIndex,
        uint8 sighashType,
        bytes memory annex
    ) external pure returns (bytes32) {
        return
            CheckBitcoinBIP341Sighash.computeKeyPathSighash(
                version,
                locktime,
                inputs,
                prevouts,
                outputs,
                signedInputIndex,
                sighashType,
                annex
            );
    }
}
