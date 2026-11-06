// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

/// @title Execution gas accounting
/// @notice Measures a non-negative execution-gas delta.
/// @dev EIP-8037 can refill normal gas during execution. State gas paid by the
///      transaction reservoir is not visible through gasleft(), so this is
///      deliberately not a measurement of the transaction's total gas cost.
library GasAccounting {
    function gasSpent(uint256 gasStart) internal view returns (uint256) {
        uint256 gasEnd = gasleft();
        return gasEnd < gasStart ? gasStart - gasEnd : 0;
    }
}
