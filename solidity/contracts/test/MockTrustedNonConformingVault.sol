// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../vault/IVault.sol";

contract MockTrustedNonConformingVault is IVault {
    function receiveBalanceIncrease(address[] calldata, uint256[] calldata)
        external
        override
    {}

    function receiveBalanceApproval(
        address,
        uint256,
        bytes calldata
    ) external override {}
}
