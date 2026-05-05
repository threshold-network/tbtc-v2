// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../integrator/IL2WormholeGateway.sol";

contract MockL2WormholeGateway is IL2WormholeGateway {
    uint64 public nextSequence = 1;
    uint16 public lastRecipientChain;
    bytes32 public lastRecipient;

    function sendTbtcWithPayloadToNativeChain(
        uint256,
        uint16 recipientChain,
        bytes32 recipient,
        uint32,
        bytes calldata
    ) external payable returns (uint64) {
        lastRecipientChain = recipientChain;
        lastRecipient = recipient;

        return nextSequence++;
    }
}
