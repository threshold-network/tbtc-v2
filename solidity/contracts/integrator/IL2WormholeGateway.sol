// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

interface IL2WormholeGateway {
    function sendTbtcWithPayloadToEthereum(
        uint256 amount,
        bytes32 recipient,
        uint32 nonce,
        bytes calldata payload
    ) external payable returns (uint64);
}
