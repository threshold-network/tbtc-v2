// SPDX-License-Identifier: GPL-3.0-only

pragma solidity ^0.8.17;

import "../bridge/BitcoinTx.sol";
import "../bridge/BridgeState.sol";
import "../bridge/IRelay.sol";

contract TestBitcoinTx {
    BridgeState.Storage internal self;

    event ProofValidated(bytes32 txHash);

    constructor(address _relay) {
        self.relay = IRelay(_relay);
    }

    function validateProof(
        BitcoinTx.Info calldata txInfo,
        BitcoinTx.Proof calldata proof
    ) external {
        emit ProofValidated(BitcoinTx.validateProof(self, txInfo, proof));
    }
}
