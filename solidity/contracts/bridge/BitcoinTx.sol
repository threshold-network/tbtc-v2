// SPDX-License-Identifier: GPL-3.0-only

// ██████████████     ▐████▌     ██████████████
// ██████████████     ▐████▌     ██████████████
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
// ██████████████     ▐████▌     ██████████████
// ██████████████     ▐████▌     ██████████████
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌

pragma solidity 0.8.17;

import {BTCUtils} from "@keep-network/bitcoin-spv-sol/contracts/BTCUtils.sol";
import {BytesLib} from "@keep-network/bitcoin-spv-sol/contracts/BytesLib.sol";
import {ValidateSPV} from "@keep-network/bitcoin-spv-sol/contracts/ValidateSPV.sol";

import "./BridgeState.sol";

/// @title Bitcoin transaction
/// @notice Allows to reference Bitcoin raw transaction in Solidity.
/// @dev See https://developer.bitcoin.org/reference/transactions.html#raw-transaction-format
///
///      Raw Bitcoin transaction data:
///
///      | Bytes  |     Name     |        BTC type        |        Description        |
///      |--------|--------------|------------------------|---------------------------|
///      | 4      | version      | int32_t (LE)           | TX version number         |
///      | varies | tx_in_count  | compactSize uint (LE)  | Number of TX inputs       |
///      | varies | tx_in        | txIn[]                 | TX inputs                 |
///      | varies | tx_out_count | compactSize uint (LE)  | Number of TX outputs      |
///      | varies | tx_out       | txOut[]                | TX outputs                |
///      | 4      | lock_time    | uint32_t (LE)          | Unix time or block number |
///
//
///      Non-coinbase transaction input (txIn):
///
///      | Bytes  |       Name       |        BTC type        |                 Description                 |
///      |--------|------------------|------------------------|---------------------------------------------|
///      | 36     | previous_output  | outpoint               | The previous outpoint being spent           |
///      | varies | script_bytes     | compactSize uint (LE)  | The number of bytes in the signature script |
///      | varies | signature_script | char[]                 | The signature script, empty for P2WSH       |
///      | 4      | sequence         | uint32_t (LE)          | Sequence number                             |
///
///
///      The reference to transaction being spent (outpoint):
///
///      | Bytes | Name  |   BTC type    |               Description                |
///      |-------|-------|---------------|------------------------------------------|
///      |    32 | hash  | char[32]      | Hash of the transaction to spend         |
///      |    4  | index | uint32_t (LE) | Index of the specific output from the TX |
///
///
///      Transaction output (txOut):
///
///      | Bytes  |      Name       |     BTC type          |             Description              |
///      |--------|-----------------|-----------------------|--------------------------------------|
///      | 8      | value           | int64_t (LE)          | Number of satoshis to spend          |
///      | 1+     | pk_script_bytes | compactSize uint (LE) | Number of bytes in the pubkey script |
///      | varies | pk_script       | char[]                | Pubkey script                        |
///
///      compactSize uint format:
///
///      |                  Value                  | Bytes |                    Format                    |
///      |-----------------------------------------|-------|----------------------------------------------|
///      | >= 0 && <= 252                          | 1     | uint8_t                                      |
///      | >= 253 && <= 0xffff                     | 3     | 0xfd followed by the number as uint16_t (LE) |
///      | >= 0x10000 && <= 0xffffffff             | 5     | 0xfe followed by the number as uint32_t (LE) |
///      | >= 0x100000000 && <= 0xffffffffffffffff | 9     | 0xff followed by the number as uint64_t (LE) |
///
///      (*) compactSize uint is often references as VarInt)
///
///      Coinbase transaction input (txIn):
///
///      | Bytes  |       Name       |        BTC type        |                 Description                 |
///      |--------|------------------|------------------------|---------------------------------------------|
///      | 32     | hash             | char[32]               | A 32-byte 0x0  null (no previous_outpoint)  |
///      | 4      | index            | uint32_t (LE)          | 0xffffffff (no previous_outpoint)           |
///      | varies | script_bytes     | compactSize uint (LE)  | The number of bytes in the coinbase script  |
///      | varies | height           | char[]                 | The block height of this block (BIP34) (*)  |
///      | varies | coinbase_script  | none                   |  Arbitrary data, max 100 bytes              |
///      | 4      | sequence         | uint32_t (LE)          | Sequence number
///
///      (*)  Uses script language: starts with a data-pushing opcode that indicates how many bytes to push to
///           the stack followed by the block height as a little-endian unsigned integer. This script must be as
///           short as possible, otherwise it may be rejected. The data-pushing opcode will be 0x03 and the total
///           size four bytes until block 16,777,216 about 300 years from now.
library BitcoinTx {
    using BTCUtils for bytes;
    using BTCUtils for uint256;
    using BytesLib for bytes;
    using ValidateSPV for bytes;
    using ValidateSPV for bytes32;

    /// @dev Bitcoin minimum-difficulty target (compact bits `0x1d00ffff`).
    /// Bitcoin testnet4 may emit minimum-difficulty headers inside an epoch; the
    /// first header(s) in an SPV chain can encode this target while later headers
    /// use the relay's current or previous epoch difficulty.
    uint256 private constant MIN_DIFFICULTY_TARGET =
        0xffff0000000000000000000000000000000000000000000000000000;

    /// @notice Represents Bitcoin transaction data.
    struct Info {
        /// @notice Bitcoin transaction version.
        /// @dev `version` from raw Bitcoin transaction data.
        ///      Encoded as 4-bytes signed integer, little endian.
        bytes4 version;
        /// @notice All Bitcoin transaction inputs, prepended by the number of
        ///         transaction inputs.
        /// @dev `tx_in_count | tx_in` from raw Bitcoin transaction data.
        ///
        ///      The number of transaction inputs encoded as compactSize
        ///      unsigned integer, little-endian.
        ///
        ///      Note that some popular block explorers reverse the order of
        ///      bytes from `outpoint`'s `hash` and display it as big-endian.
        ///      Solidity code of Bridge expects hashes in little-endian, just
        ///      like they are represented in a raw Bitcoin transaction.
        bytes inputVector;
        /// @notice All Bitcoin transaction outputs prepended by the number of
        ///         transaction outputs.
        /// @dev `tx_out_count | tx_out` from raw Bitcoin transaction data.
        ///
        ///       The number of transaction outputs encoded as a compactSize
        ///       unsigned integer, little-endian.
        bytes outputVector;
        /// @notice Bitcoin transaction locktime.
        ///
        /// @dev `lock_time` from raw Bitcoin transaction data.
        ///      Encoded as 4-bytes unsigned integer, little endian.
        bytes4 locktime;
        // This struct doesn't contain `__gap` property as the structure is not
        // stored, it is used as a function's calldata argument.
    }

    /// @notice Represents data needed to perform a Bitcoin SPV proof.
    struct Proof {
        /// @notice The merkle proof of transaction inclusion in a block.
        bytes merkleProof;
        /// @notice Transaction index in the block (0-indexed).
        uint256 txIndexInBlock;
        /// @notice Single byte-string of 80-byte bitcoin headers,
        ///         lowest height first.
        bytes bitcoinHeaders;
        /// @notice The sha256 preimage of the coinbase tx hash
        ///         i.e. the sha256 hash of the coinbase transaction.
        bytes32 coinbasePreimage;
        /// @notice The merkle proof of the coinbase transaction.
        bytes coinbaseProof;
        // This struct doesn't contain `__gap` property as the structure is not
        // stored, it is used as a function's calldata argument.
    }

    /// @notice Represents info about an unspent transaction output.
    struct UTXO {
        /// @notice Hash of the transaction the output belongs to.
        /// @dev Byte order corresponds to the Bitcoin internal byte order.
        bytes32 txHash;
        /// @notice Index of the transaction output (0-indexed).
        uint32 txOutputIndex;
        /// @notice Value of the transaction output.
        uint64 txOutputValue;
        // This struct doesn't contain `__gap` property as the structure is not
        // stored, it is used as a function's calldata argument.
    }

    /// @notice Represents Bitcoin signature in the R/S/V format.
    struct RSVSignature {
        /// @notice Signature r value.
        bytes32 r;
        /// @notice Signature s value.
        bytes32 s;
        /// @notice Signature recovery value.
        uint8 v;
        // This struct doesn't contain `__gap` property as the structure is not
        // stored, it is used as a function's calldata argument.
    }

    /// @notice Supported wallet script types for Bridge wallet outputs.
    enum WalletScriptType {
        P2PKH,
        P2WPKH,
        P2TR
    }

    /// @notice Validates the stripped Bitcoin transaction representation and
    ///         returns its internal-byte-order txid without requiring SPV.
    /// @dev Pre-signing authorization must run this exact parser before any
    ///      signature can be released. SPV proof paths reuse the same helper.
    function validateInfo(Info calldata txInfo)
        internal
        view
        returns (bytes32 txHash)
    {
        require(
            txInfo.inputVector.validateVin(),
            "Invalid input vector provided"
        );
        require(
            txInfo.outputVector.validateVout(),
            "Invalid output vector provided"
        );

        return
            abi
                .encodePacked(
                    txInfo.version,
                    txInfo.inputVector,
                    txInfo.outputVector,
                    txInfo.locktime
                )
                .hash256View();
    }

    /// @dev Memory counterpart used by the generic pre-signing dispatcher
    ///      after decoding its action payload.
    function validateInfoMemory(Info memory txInfo)
        internal
        view
        returns (bytes32 txHash)
    {
        require(
            txInfo.inputVector.validateVin(),
            "Invalid input vector provided"
        );
        require(
            txInfo.outputVector.validateVout(),
            "Invalid output vector provided"
        );

        return
            abi
                .encodePacked(
                    txInfo.version,
                    txInfo.inputVector,
                    txInfo.outputVector,
                    txInfo.locktime
                )
                .hash256View();
    }

    /// @notice Validates the SPV proof of the Bitcoin transaction.
    ///         Reverts in case the validation or proof verification fail.
    /// @param txInfo Bitcoin transaction data.
    /// @param proof Bitcoin proof data.
    /// @return txHash Proven 32-byte transaction hash.
    function validateProof(
        BridgeState.Storage storage self,
        Info calldata txInfo,
        Proof calldata proof
    ) internal view returns (bytes32 txHash) {
        txHash = validateInfo(txInfo);
        require(
            proof.merkleProof.length == proof.coinbaseProof.length,
            "Tx not on same level of merkle tree as coinbase"
        );

        bytes32 root = proof.bitcoinHeaders.extractMerkleRootLE();

        require(
            txHash.prove(root, proof.merkleProof, proof.txIndexInBlock),
            "Tx merkle proof is not valid for provided header and tx hash"
        );

        bytes32 coinbaseHash = sha256(abi.encodePacked(proof.coinbasePreimage));

        require(
            coinbaseHash.prove(root, proof.coinbaseProof, 0),
            "Coinbase merkle proof is not valid for provided header and hash"
        );

        evaluateProofDifficulty(self, proof.bitcoinHeaders);

        return txHash;
    }

    /// @notice Picks the relay epoch difficulty used as the baseline for SPV
    ///         accumulated-work checks. When both relay difficulties are above
    ///         minimum difficulty, walks past leading DIFF1 headers (Bitcoin
    ///         testnet4 BIP94) until a header matches the relay's current or
    ///         previous epoch difficulty. Reverts if every header is skipped or
    ///         the first decisive header does not match either oracle value.
    ///         When either difficulty is minimum (1), leading DIFF1 headers
    ///         are never skipped—they are matched like any other header first
    ///         (typically binding to whichever oracle side equals 1). Production
    ///         mainnet relays are not expected to report an epoch difficulty of 1.
    function determineRequestedDifficulty(
        bytes memory bitcoinHeaders,
        uint256 currentEpochDifficulty,
        uint256 previousEpochDifficulty
    ) internal pure returns (uint256 requestedDiff) {
        if (bitcoinHeaders.length == 0) {
            revert("Not at current or previous difficulty");
        }

        // Validate the structure before scanning. extractTargetAt reads a full
        // 80-byte header at each offset, so a non-multiple-of-80 input would
        // otherwise revert with a low-level out-of-bounds panic on the trailing
        // partial header instead of this explicit message.
        require(
            bitcoinHeaders.length % 80 == 0,
            "Invalid length of the headers chain"
        );

        for (uint256 at = 0; at < bitcoinHeaders.length; at += 80) {
            uint256 target = bitcoinHeaders.extractTargetAt(at);
            // Skip minimum-difficulty headers only when the relay epoch is
            // above minimum difficulty. This allows testnet4 BIP94 DIFF1
            // headers to be skipped in real epochs, while still accepting
            // proofs in test/dev setups where the relay epoch is 1.
            if (
                target == MIN_DIFFICULTY_TARGET &&
                currentEpochDifficulty > 1 &&
                previousEpochDifficulty > 1
            ) {
                continue;
            }

            uint256 headerDiff = target.calculateDifficulty();
            if (headerDiff == currentEpochDifficulty) {
                return currentEpochDifficulty;
            }
            if (headerDiff == previousEpochDifficulty) {
                return previousEpochDifficulty;
            }

            revert("Not at current or previous difficulty");
        }

        revert("Not at current or previous difficulty");
    }

    /// @notice Evaluates the given Bitcoin proof difficulty against the actual
    ///         Bitcoin chain difficulty provided by the relay oracle.
    ///         Reverts in case the evaluation fails.
    /// @param bitcoinHeaders Bitcoin headers chain being part of the SPV
    ///        proof. Used to extract the observed proof difficulty.
    function evaluateProofDifficulty(
        BridgeState.Storage storage self,
        bytes memory bitcoinHeaders
    ) internal view {
        IRelay relay = self.relay;
        uint256 currentEpochDifficulty = relay.getCurrentEpochDifficulty();
        uint256 previousEpochDifficulty = relay.getPrevEpochDifficulty();

        uint256 requestedDiff = determineRequestedDifficulty(
            bitcoinHeaders,
            currentEpochDifficulty,
            previousEpochDifficulty
        );

        uint256 observedDiff = bitcoinHeaders.validateHeaderChain();

        require(
            observedDiff != ValidateSPV.getErrBadLength(),
            "Invalid length of the headers chain"
        );
        require(
            observedDiff != ValidateSPV.getErrInvalidChain(),
            "Invalid headers chain"
        );
        require(
            observedDiff != ValidateSPV.getErrLowWork(),
            "Insufficient work in a header"
        );

        require(
            observedDiff >= requestedDiff * self.txProofDifficultyFactor,
            "Insufficient accumulated difficulty in header chain"
        );
    }

    /// @notice Extracts wallet public key hash compatibility key from the
    ///         provided output.
    /// @dev For legacy outputs, this is the 20-byte PKH directly encoded in
    ///      the script. For P2TR outputs, the x-only output key must resolve
    ///      through `walletPubKeyHashByWalletID` to the compatibility key used
    ///      by legacy Bridge state and events.
    function extractWalletPubKeyHash(
        BridgeState.Storage storage self,
        bytes memory output
    ) internal view returns (bytes20 walletPubKeyHash) {
        (
            WalletScriptType scriptType,
            bytes32 walletKey
        ) = extractWalletScriptKey(output);

        if (scriptType != WalletScriptType.P2TR) {
            walletPubKeyHash = bytes20(walletKey);
            require(
                self.walletIDByWalletPubKeyHash[walletPubKeyHash] == bytes32(0),
                "FROST wallet output must be P2TR"
            );

            return walletPubKeyHash;
        }

        walletPubKeyHash = self.walletPubKeyHashByWalletID[walletKey];
        require(walletPubKeyHash != bytes20(0), "Unknown wallet ID");
        require(
            self.registeredWallets[walletPubKeyHash].ecdsaWalletID ==
                bytes32(0),
            "ECDSA wallet output must be legacy"
        );
        require(
            self.walletIDByWalletPubKeyHash[walletPubKeyHash] == walletKey,
            "P2TR wallet ID mismatch"
        );

        return walletPubKeyHash;
    }

    /// @notice Derives a 20-byte compatibility alias from a 32-byte x-only key.
    /// @dev Alias is computed as HASH160 over a synthetic compressed key:
    ///      `HASH160(0x02 || xOnlyKey)`.
    function deriveWalletPubKeyHashFromXOnly(bytes32 xOnlyKey)
        internal
        view
        returns (bytes20)
    {
        return bytes20(abi.encodePacked(hex"02", xOnlyKey).hash160View());
    }

    /// @notice Parses wallet output script and extracts the wallet key.
    /// @dev For P2PKH/P2WPKH, the key is the 20-byte PKH in the first 20 bytes.
    ///      For P2TR, the key is the full 32-byte x-only output key.
    function extractWalletScriptKey(bytes memory output)
        internal
        pure
        returns (WalletScriptType scriptType, bytes32 walletKey)
    {
        require(output.length >= 9, "Output is too short");

        // The output consists of:
        // - 8-byte value
        // - compactSize script length (for standard wallet scripts, 1 byte)
        // - script
        uint256 scriptLen = uint8(output[8]);

        require(
            output.length == scriptLen + 9,
            "Output has invalid script length"
        );

        if (scriptLen == 25) {
            // P2PKH script body:
            // 76 a9 14 <20-byte pubKeyHash> 88 ac
            require(
                output.slice3(9) == hex"76a914" &&
                    output.slice2(32) == hex"88ac",
                "Invalid P2PKH script"
            );

            // Note: `slice32(12)` reads bytes 12..43 of a 34-byte
            // P2PKH output (10 bytes past the end). The overread is
            // deliberate and bounded by `output.length == 34`; the
            // garbage in the upper 10 bytes is then truncated to a
            // 20-byte PKH by the only in-repo caller
            // (`extractWalletPubKeyHash` -> `bytes20(walletKey)`).
            // Any new caller MUST either truncate to `bytes20` here
            // or switch to `BytesLib.slice(output, 12, 20)`; do not
            // introduce a direct reader of the upper bytes without
            // re-evaluating this contract.
            return (WalletScriptType.P2PKH, output.slice32(12));
        }

        if (scriptLen == 22) {
            // P2WPKH script body:
            // 00 14 <20-byte pubKeyHash>
            require(output.slice2(9) == hex"0014", "Invalid P2WPKH script");

            // Note: `slice32(11)` reads bytes 11..42 of a 31-byte
            // P2WPKH output (12 bytes past the end). The overread is
            // deliberate and bounded by `output.length == 31`; the
            // garbage in the upper 12 bytes is then truncated to a
            // 20-byte PKH by the only in-repo caller
            // (`extractWalletPubKeyHash` -> `bytes20(walletKey)`).
            // Any new caller MUST either truncate to `bytes20` here
            // or switch to `BytesLib.slice(output, 11, 20)`; do not
            // introduce a direct reader of the upper bytes without
            // re-evaluating this contract.
            return (WalletScriptType.P2WPKH, output.slice32(11));
        }

        if (scriptLen == 34) {
            // P2TR script body:
            // 51 20 <32-byte x-only output key>
            require(output.slice2(9) == hex"5120", "Invalid P2TR script");

            // P2TR is bounds-safe: a 43-byte output with `slice32(11)`
            // reads exactly bytes 11..42, the full 32-byte x-only key.
            return (WalletScriptType.P2TR, output.slice32(11));
        }
    }

    /// @notice Extracts the payload from a standard length-prefixed output
    ///         script.
    /// @dev Supports P2PKH, P2WPKH, P2SH, P2WSH and P2TR scripts. Returns an
    ///      empty byte array for malformed or unsupported scripts. Replaces
    ///      `BTCUtils.extractHashAt` at redemption-destination call sites so
    ///      P2TR redemption destinations are accepted, matching the wallet-
    ///      identity-compatibility manifest's claim that the redeem path
    ///      accepts the standard P2TR user destination script.
    function extractStandardOutputScriptPayload(bytes memory outputScript)
        internal
        pure
        returns (bytes memory)
    {
        // P2PKH script:
        // 19 76 a9 14 <20-byte pubKeyHash> 88 ac
        if (
            outputScript.length == 26 &&
            outputScript.slice3(0) == hex"1976a9" &&
            uint8(outputScript[3]) == 20 &&
            outputScript.slice2(24) == hex"88ac"
        ) {
            return outputScript.slice(4, 20);
        }

        // P2SH script:
        // 17 a9 14 <20-byte scriptHash> 87
        if (
            outputScript.length == 24 &&
            outputScript.slice3(0) == hex"17a914" &&
            uint8(outputScript[23]) == 0x87
        ) {
            return outputScript.slice(3, 20);
        }

        // P2WPKH script:
        // 16 00 14 <20-byte pubKeyHash>
        if (
            outputScript.length == 23 && outputScript.slice3(0) == hex"160014"
        ) {
            return outputScript.slice(3, 20);
        }

        // P2WSH script:
        // 22 00 20 <32-byte scriptHash>
        if (
            outputScript.length == 35 && outputScript.slice3(0) == hex"220020"
        ) {
            return outputScript.slice(3, 32);
        }

        // P2TR script:
        // 22 51 20 <32-byte x-only output key>
        if (
            outputScript.length == 35 && outputScript.slice3(0) == hex"225120"
        ) {
            return outputScript.slice(3, 32);
        }

        return hex"";
    }

    /// @notice Build the P2PKH script from the given public key hash.
    /// @param pubKeyHash The 20-byte public key hash.
    /// @return The P2PKH script.
    /// @dev The P2PKH script has the following byte format:
    ///      <0x1976a914> <20-byte PKH> <0x88ac>. According to
    ///      https://en.bitcoin.it/wiki/Script#Opcodes this translates to:
    ///      - 0x19: Byte length of the entire script
    ///      - 0x76: OP_DUP
    ///      - 0xa9: OP_HASH160
    ///      - 0x14: Byte length of the public key hash
    ///      - 0x88: OP_EQUALVERIFY
    ///      - 0xac: OP_CHECKSIG
    ///      which matches the P2PKH structure as per:
    ///      https://en.bitcoin.it/wiki/Transaction#Pay-to-PubkeyHash
    function makeP2PKHScript(bytes20 pubKeyHash)
        internal
        pure
        returns (bytes26)
    {
        bytes26 P2PKHScriptMask = hex"1976a914000000000000000000000000000000000000000088ac";

        return ((bytes26(pubKeyHash) >> 32) | P2PKHScriptMask);
    }

    /// @notice Build the P2WPKH script from the given public key hash.
    /// @param pubKeyHash The 20-byte public key hash.
    /// @return The P2WPKH script.
    /// @dev The P2WPKH script has the following format:
    ///      <0x160014> <20-byte PKH>. According to
    ///      https://en.bitcoin.it/wiki/Script#Opcodes this translates to:
    ///      - 0x16: Byte length of the entire script
    ///      - 0x00: OP_0
    ///      - 0x14: Byte length of the public key hash
    ///      which matches the P2WPKH structure as per:
    ///      https://github.com/bitcoin/bips/blob/master/bip-0141.mediawiki#P2WPKH
    function makeP2WPKHScript(bytes20 pubKeyHash)
        internal
        pure
        returns (bytes23)
    {
        bytes23 P2WPKHScriptMask = hex"1600140000000000000000000000000000000000000000";

        return ((bytes23(pubKeyHash) >> 24) | P2WPKHScriptMask);
    }

    /// @notice Build the P2TR script from the given x-only output key.
    /// @param xOnlyKey The 32-byte x-only Taproot output key.
    /// @return The P2TR script.
    /// @dev The P2TR script has the following format:
    ///      <0x22> <0x51> <0x20> <32-byte x-only key>. Where:
    ///      - 0x22: Byte length of the script body (34 bytes)
    ///      - 0x51: OP_1 (witness version 1)
    ///      - 0x20: Byte length of the witness program (32 bytes)
    function makeP2TRScript(bytes32 xOnlyKey)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(hex"225120", xOnlyKey);
    }
}
