// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../libraries/GasAccounting.sol";

contract GasAccountingTest {
    function gasSpent(uint256 gasStart) external view returns (uint256) {
        return GasAccounting.gasSpent(gasStart);
    }
}
