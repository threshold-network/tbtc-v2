// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

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

    function extractPubKeyHash(bytes calldata output)
        external
        view
        returns (bytes20)
    {
        return BitcoinTx.extractPubKeyHash(self, output);
    }

    function extractWalletID(bytes calldata output)
        external
        view
        returns (bytes32)
    {
        return BitcoinTx.extractWalletID(self, output);
    }

    function extractWalletPubKeyHash(bytes calldata output)
        external
        view
        returns (bytes20)
    {
        return BitcoinTx.extractWalletPubKeyHash(self, output);
    }

    function setWalletPubKeyHashForWalletID(
        bytes32 walletID,
        bytes20 walletPubKeyHash
    ) external {
        self.walletPubKeyHashByWalletID[walletID] = walletPubKeyHash;
    }

    function setWalletIDForWalletPubKeyHash(
        bytes20 walletPubKeyHash,
        bytes32 walletID
    ) external {
        self.walletIDByWalletPubKeyHash[walletPubKeyHash] = walletID;
    }

    function deriveWalletPubKeyHashFromXOnly(bytes32 xOnlyKey)
        external
        view
        returns (bytes20)
    {
        return BitcoinTx.deriveWalletPubKeyHashFromXOnly(xOnlyKey);
    }

    function makeP2TRScript(bytes32 xOnlyKey)
        external
        pure
        returns (bytes memory)
    {
        return BitcoinTx.makeP2TRScript(xOnlyKey);
    }

    function extractStandardOutputScriptPayload(bytes calldata outputScript)
        external
        pure
        returns (bytes memory)
    {
        return BitcoinTx.extractStandardOutputScriptPayload(outputScript);
    }

    function exposeDetermineRequestedDifficulty(
        bytes memory bitcoinHeaders,
        uint256 currentEpochDifficulty,
        uint256 previousEpochDifficulty
    ) external pure returns (uint256) {
        return
            BitcoinTx.determineRequestedDifficulty(
                bitcoinHeaders,
                currentEpochDifficulty,
                previousEpochDifficulty
            );
    }
}
