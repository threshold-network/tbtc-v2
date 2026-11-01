// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import {BitcoinTx} from "../../../contracts/bridge/BitcoinTx.sol";
import {Deposit} from "../../../contracts/bridge/Deposit.sol";

/// @title BtcBuilder
/// @notice Pure helpers that build Bitcoin transactions, deposit scripts and
///         SPV proofs which the tBTC v2 Bridge accepts without any real
///         Bitcoin chain. Used by the fizz fuzzing handlers.
///
/// @dev Byte-order conventions (all derived from the protocol sources):
///
///      - `txHash` (and `Info`-derived hashes everywhere) is the RAW output of
///        `sha256(sha256(version | inputVector | outputVector | locktime))`,
///        i.e. Bitcoin "internal"/little-endian order, NOT the reversed hex
///        string block explorers display. Fixed by
///        contracts/bridge/BitcoinTx.sol:206-213 (validateProof, `hash256View`)
///        and contracts/bridge/Deposit.sol:341-348 ("Resulting TX hash is in
///        native Bitcoin little-endian format"). `BitcoinTx.UTXO.txHash` is
///        documented the same way (BitcoinTx.sol:161).
///      - `TxIn.prevTxHash` is written verbatim into the 32-byte outpoint hash
///        of the input vector, so it must be a value produced by `txHash`
///        (BitcoinTx.sol:119-122: "Solidity code of Bridge expects hashes in
///        little-endian, just like they are represented in a raw Bitcoin
///        transaction"). `prevOutIndex` is serialized little-endian (4 bytes).
///      - Merkle nodes are raw hash256 digests; an inner node is
///        `hash256(left | right)` over the raw 32-byte values. Fixed by
///        bitcoin-spv-sol BTCUtils.sol:801-803 (`_hash256MerkleStep`) and
///        BTCUtils.sol:866-877 (`verifyHash256Merkle`: odd index => the proof
///        node is the LEFT sibling, even index => RIGHT sibling).
///      - The block header merkle root is the raw root placed at header bytes
///        36..67, read by `extractMerkleRootLE` (BTCUtils.sol:717-719;
///        BitcoinTx.sol:215 reads it from the FIRST header only).
///      - Header `prevHash` (bytes 4..35) must equal the raw hash256 digest of
///        the previous 80-byte header (ValidateSPV.sol:136-148, :97-102).
///
///      Proof difficulty (why the constants hold):
///
///      - `HEADER_BITS = 0x207fffff` is serialized in the header as the 4 LE
///        bytes `ff ff 7f 20` (bytes 72..75; BTCUtils.sol:734-741). The
///        extracted target is `0x7fffff * 256^29 ~= 2^255`.
///      - `calculateDifficulty(target) = DIFF1_TARGET / target`
///        (BTCUtils.sol:748-751), `DIFF1_TARGET ~= 2^224`, hence it is
///        integer-divided to 0.
///      - `BitcoinTx.determineRequestedDifficulty` (BitcoinTx.sol:244-288):
///        the target differs from `MIN_DIFFICULTY_TARGET` (0x1d00ffff target),
///        so the header's difficulty (0) is compared with the relay's current
///        and previous epoch difficulty; Base configures both as
///        `RELAY_EPOCH_DIFFICULTY = 0`, so it returns 0.
///      - `validateHeaderChain` (ValidateSPV.sol:85-116) requires, per header,
///        `reverse(uint256(hash256(header))) <= target` (else ERR_LOW_WORK) and
///        returns the sum of per-header difficulties (0 here), which is not an
///        error code (error codes are 2^256-1..3).
///      - `evaluateProofDifficulty` (BitcoinTx.sol:324-327) then requires
///        `observedDiff (0) >= requestedDiff (0) * txProofDifficultyFactor`,
///        which holds for any factor. `TX_PROOF_DIFFICULTY_FACTOR = 1` is
///        passed to Bridge.initialize; a non-zero factor is required there but
///        has no further effect on the check.
///      - Mining: the digest's LAST raw byte becomes the MOST significant byte
///        after `reverseUint256`, so `uint8(digest[31]) < 0x7f` is a cheap
///        sufficient condition for `reversed <= target` (~50% per nonce).
///
///      Merkle / coinbase shape: the block is `[coinbase, tx]`. The tx merkle
///      proof is `[coinbaseHash]` at index 1; the coinbase proof is `[txHash]`
///      at index 0 (BitcoinTx.sol:217-227). Both have length 32, satisfying
///      the "same level" rule (BitcoinTx.sol:201-204). The Bridge computes
///      `coinbaseHash = sha256(coinbasePreimage)` (BitcoinTx.sol:222), so the
///      preimage is `sha256(coinbaseSerialization)`, making
///      `coinbaseHash == hash256(coinbaseSerialization)`.
///
///      Deposit scripts mirror contracts/bridge/Deposit.sol:255-317 byte for
///      byte. P2SH outputs commit to `ripemd160(sha256(script))` behind the
///      `17 a9 14` prefix (Deposit.sol:328-341); P2WSH outputs commit to
///      `sha256(script)` (Deposit.sol:343-348). The script embeds the
///      `msg.sender` of the reveal call, which is why `depositor` is a
///      parameter.
library BtcBuilder {
    /// @notice Regtest max-target compact bits (`0x207fffff`).
    uint32 internal constant HEADER_BITS = 0x207fffff;

    /// @notice Relay current AND previous epoch difficulty that makes proofs
    ///         built by `prove` valid (see contract-level NatSpec).
    uint256 internal constant RELAY_EPOCH_DIFFICULTY = 0;

    /// @notice `txProofDifficultyFactor` to initialize the Bridge with.
    uint96 internal constant TX_PROOF_DIFFICULTY_FACTOR = 1;

    /// @dev Upper bound for nonce grinding per header. Each nonce succeeds with
    ///      probability ~1/2, so exceeding it is astronomically unlikely.
    uint256 private constant MAX_NONCE_TRIES = 256;

    /// @dev Upper bound for the deposit funding output index, keeps the number
    ///      of filler outputs (and memory use) small.
    uint32 private constant MAX_FUNDING_OUTPUT_INDEX = 255;

    /// @dev Base header timestamp (2023-11-14) and per-header increment.
    uint32 private constant BASE_TIMESTAMP = 1700000000;
    uint32 private constant TIMESTAMP_STEP = 600;

    struct TxIn {
        // Raw hash256 digest of the previous transaction (Bitcoin internal
        // byte order), exactly as the Bridge stores UTXO.txHash.
        bytes32 prevTxHash;
        uint32 prevOutIndex;
    }

    struct TxOut {
        uint64 value;
        // Raw locking script WITHOUT the compactSize length prefix.
        bytes script;
    }

    /* ------------------------------------------------------------------ */
    /* Transactions                                                        */
    /* ------------------------------------------------------------------ */

    /// @notice Builds a `BitcoinTx.Info` with version 1, empty scriptSigs,
    ///         `0xffffffff` sequences and locktime 0.
    function buildTx(
        TxIn[] memory ins,
        TxOut[] memory outs
    ) internal pure returns (BitcoinTx.Info memory info) {
        require(ins.length > 0, "BtcBuilder: no inputs");
        require(outs.length > 0, "BtcBuilder: no outputs");

        bytes memory inputVector = _compactSize(ins.length);
        for (uint256 i = 0; i < ins.length; i++) {
            inputVector = bytes.concat(
                inputVector,
                ins[i].prevTxHash,
                _le32(ins[i].prevOutIndex),
                hex"00", // empty scriptSig (witness data is not part of Info)
                hex"ffffffff" // sequence
            );
        }

        bytes memory outputVector = _compactSize(outs.length);
        for (uint256 i = 0; i < outs.length; i++) {
            outputVector = bytes.concat(
                outputVector,
                _le64(outs[i].value),
                _compactSize(outs[i].script.length),
                outs[i].script
            );
        }

        info.version = hex"01000000";
        info.inputVector = inputVector;
        info.outputVector = outputVector;
        info.locktime = hex"00000000";
    }

    /// @notice Transaction hash exactly as the Bridge computes it
    ///         (`hash256(version | inputVector | outputVector | locktime)`,
    ///         raw digest, Bitcoin internal byte order).
    function txHash(
        BitcoinTx.Info memory info
    ) internal pure returns (bytes32) {
        return _hash256(_serialize(info));
    }

    /* ------------------------------------------------------------------ */
    /* Scripts                                                             */
    /* ------------------------------------------------------------------ */

    /// @notice `OP_DUP OP_HASH160 <pkh> OP_EQUALVERIFY OP_CHECKSIG`
    function p2pkh(bytes20 pkh) internal pure returns (bytes memory) {
        return bytes.concat(hex"76a914", pkh, hex"88ac");
    }

    /// @notice `OP_0 <pkh>`
    function p2wpkh(bytes20 pkh) internal pure returns (bytes memory) {
        return bytes.concat(hex"0014", pkh);
    }

    /// @notice `OP_HASH160 <scriptHash> OP_EQUAL`
    function p2sh(bytes20 scriptHash) internal pure returns (bytes memory) {
        return bytes.concat(hex"a914", scriptHash, hex"87");
    }

    /// @notice `OP_0 <scriptHash>`
    function p2wsh(bytes32 scriptHash) internal pure returns (bytes memory) {
        return bytes.concat(hex"0020", scriptHash);
    }

    /// @notice 33-byte compressed public key; prefix 0x02 for even y, 0x03 for
    ///         odd y.
    function compressedPubKey(
        bytes32 x,
        bytes32 y
    ) internal pure returns (bytes memory) {
        return
            bytes.concat(
                (uint256(y) & 1) == 0 ? bytes1(0x02) : bytes1(0x03),
                x
            );
    }

    /// @notice HASH160 (`ripemd160(sha256(compressed pubkey))`) of the public
    ///         key, matching the Bridge's `walletPubKeyHash`.
    function pubKeyHash(bytes32 x, bytes32 y) internal pure returns (bytes20) {
        return _hash160(compressedPubKey(x, y));
    }

    /* ------------------------------------------------------------------ */
    /* Deposits                                                            */
    /* ------------------------------------------------------------------ */

    /// @notice Deposit script exactly as built in Deposit.sol:255-317.
    /// @param reveal Reveal info; uses `blindingFactor`, `walletPubKeyHash`,
    ///        `refundPubKeyHash` and `refundLocktime` (`fundingOutputIndex` and
    ///        `vault` do not enter the script).
    /// @param depositor The `msg.sender` of the reveal call.
    /// @param extraData 32-byte extra data; only used if `withExtraData`.
    /// @param withExtraData If true the extra-data variant is produced
    ///        literally, even for `extraData == 0` (the Bridge itself rejects
    ///        a zero `extraData` in `revealDepositWithExtraData`, and a
    ///        regular `revealDeposit` uses the variant without extra data).
    function depositScript(
        Deposit.DepositRevealInfo memory reveal,
        address depositor,
        bytes32 extraData,
        bool withExtraData
    ) internal pure returns (bytes memory) {
        bytes memory head =
            withExtraData
                ? bytes.concat(
                    hex"14", // Byte length of depositor Ethereum address.
                    bytes20(depositor),
                    hex"75", // OP_DROP
                    hex"20", // Byte length of extra data.
                    extraData,
                    hex"75" // OP_DROP
                )
                : bytes.concat(
                    hex"14", // Byte length of depositor Ethereum address.
                    bytes20(depositor),
                    hex"75" // OP_DROP
                );

        return
            bytes.concat(
                head,
                hex"08", // Byte length of blinding factor value.
                reveal.blindingFactor,
                hex"75", // OP_DROP
                hex"76a914", // OP_DUP OP_HASH160 <push 20>
                reveal.walletPubKeyHash,
                hex"87", // OP_EQUAL
                hex"63ac67", // OP_IF OP_CHECKSIG OP_ELSE
                hex"76a914", // OP_DUP OP_HASH160 <push 20>
                reveal.refundPubKeyHash,
                _depositScriptTail(reveal.refundLocktime)
            );
    }

    /// @dev `OP_EQUALVERIFY <push 4> <refundLocktime> OP_CHECKLOCKTIMEVERIFY
    ///      OP_DROP OP_CHECKSIG OP_ENDIF`
    function _depositScriptTail(
        bytes4 refundLocktime
    ) private pure returns (bytes memory) {
        return bytes.concat(hex"8804", refundLocktime, hex"b175ac68");
    }

    /// @notice Builds a deposit funding transaction with one dummy input
    ///         (derived from `entropy`) whose output at
    ///         `reveal.fundingOutputIndex` pays the deposit script (P2WSH if
    ///         `witness`, P2SH otherwise) `amountSat`. Outputs before that index
    ///         are zero-valued P2PKH fillers. `entropy` makes funding tx hashes
    ///         unique.
    /// @return fundingTx The funding transaction.
    /// @return outputIndex `reveal.fundingOutputIndex`.
    function depositFundingTx(
        Deposit.DepositRevealInfo memory reveal,
        address depositor,
        bytes32 extraData,
        bool withExtraData,
        bool witness,
        uint64 amountSat,
        bytes32 entropy
    )
        internal
        pure
        returns (BitcoinTx.Info memory fundingTx, uint32 outputIndex)
    {
        outputIndex = reveal.fundingOutputIndex;
        fundingTx = _fundingTx(
            outputIndex,
            _depositOutputScript(
                reveal,
                depositor,
                extraData,
                withExtraData,
                witness
            ),
            amountSat,
            entropy
        );
    }

    /* ------------------------------------------------------------------ */
    /* SPV proof                                                           */
    /* ------------------------------------------------------------------ */

    /// @notice Builds an SPV proof for `info` that the Bridge accepts when the
    ///         relay reports `RELAY_EPOCH_DIFFICULTY` and the Bridge uses
    ///         `TX_PROOF_DIFFICULTY_FACTOR`. The block contains
    ///         `[coinbase, tx]`; `info` sits at index 1.
    /// @param headerCount Number of chained headers; at least
    ///        `TX_PROOF_DIFFICULTY_FACTOR` headers are always emitted.
    function prove(
        BitcoinTx.Info memory info,
        uint256 headerCount
    ) internal pure returns (BitcoinTx.Proof memory proof) {
        bytes32 hash = txHash(info);

        bytes memory coinbase = _coinbase(hash);

        bytes32 coinbasePreimage = sha256(coinbase);
        bytes32 coinbaseHash = sha256(abi.encodePacked(coinbasePreimage));
        bytes32 merkleRoot = _hash256(abi.encodePacked(coinbaseHash, hash));

        proof.merkleProof = abi.encodePacked(coinbaseHash);
        proof.txIndexInBlock = 1;
        proof.coinbasePreimage = coinbasePreimage;
        proof.coinbaseProof = abi.encodePacked(hash);
        proof.bitcoinHeaders = _headerChain(
            merkleRoot,
            headerCount < TX_PROOF_DIFFICULTY_FACTOR
                ? TX_PROOF_DIFFICULTY_FACTOR
                : headerCount
        );
    }

    /* ------------------------------------------------------------------ */
    /* Internals                                                           */
    /* ------------------------------------------------------------------ */

    /// @dev Locking script paying the deposit script: P2WSH (sha256) if
    ///      `witness`, else P2SH (hash160).
    function _depositOutputScript(
        Deposit.DepositRevealInfo memory reveal,
        address depositor,
        bytes32 extraData,
        bool withExtraData,
        bool witness
    ) private pure returns (bytes memory) {
        bytes memory script = depositScript(
            reveal,
            depositor,
            extraData,
            withExtraData
        );
        return witness ? p2wsh(sha256(script)) : p2sh(_hash160(script));
    }

    /// @dev One dummy input derived from `entropy`; zero-valued P2PKH fillers
    ///      before `outputIndex`, then the paying output at `outputIndex`.
    function _fundingTx(
        uint32 outputIndex,
        bytes memory outputScript,
        uint64 amountSat,
        bytes32 entropy
    ) private pure returns (BitcoinTx.Info memory) {
        require(
            outputIndex <= MAX_FUNDING_OUTPUT_INDEX,
            "BtcBuilder: funding output index too large"
        );

        TxIn[] memory ins = new TxIn[](1);
        ins[0] = TxIn({
            prevTxHash: keccak256(
                abi.encodePacked("BtcBuilder.input", entropy)
            ),
            prevOutIndex: uint32(uint256(entropy))
        });

        TxOut[] memory outs = new TxOut[](uint256(outputIndex) + 1);
        for (uint256 i = 0; i < outputIndex; i++) {
            outs[i] = TxOut({
                value: 0,
                script: p2pkh(
                    bytes20(
                        keccak256(
                            abi.encodePacked("BtcBuilder.filler", entropy, i)
                        )
                    )
                )
            });
        }
        outs[outputIndex] = TxOut({value: amountSat, script: outputScript});

        return buildTx(ins, outs);
    }

    /// @dev Coinbase serialization: version 1, a single null-outpoint input
    ///      with a BIP34-shaped scriptSig (0x03 + 3-byte height) salted with
    ///      `salt` so each block's coinbase differs, one zero-value OP_RETURN
    ///      output, locktime 0.
    function _coinbase(bytes32 salt) private pure returns (bytes memory) {
        bytes memory vin = bytes.concat(
            hex"01", // input count
            bytes32(0), // null outpoint hash
            hex"ffffffff", // null outpoint index
            hex"0b", // scriptSig length: 4 (height) + 7 (salt)
            hex"03a08601", // BIP34 height push (100000)
            bytes7(salt),
            hex"ffffffff" // sequence
        );
        bytes memory vout = bytes.concat(
            hex"01", // output count
            hex"0000000000000000", // value 0
            hex"0a", // script length: OP_RETURN + push-8 + 8 bytes
            hex"6a08",
            bytes8(salt)
        );
        return bytes.concat(hex"01000000", vin, vout, hex"00000000");
    }

    /// @dev Chain of `count` 80-byte headers. Only the first header carries
    ///      the merkle root (the Bridge reads it from there); the rest commit
    ///      to a zero root.
    function _headerChain(
        bytes32 merkleRoot,
        uint256 count
    ) private pure returns (bytes memory headers) {
        bytes32 prevHash = keccak256(
            abi.encodePacked("BtcBuilder.prev", merkleRoot)
        );
        bytes memory chain;

        for (uint256 i = 0; i < count; i++) {
            bytes memory prefix = bytes.concat(
                hex"00000020", // version 0x20000000 (LE)
                prevHash,
                i == 0 ? merkleRoot : bytes32(0),
                _le32(BASE_TIMESTAMP + uint32(i) * TIMESTAMP_STEP),
                _le32(HEADER_BITS)
            );

            bytes memory header;
            bytes32 digest;
            bool mined = false;
            for (uint256 nonce = 0; nonce < MAX_NONCE_TRIES; nonce++) {
                header = bytes.concat(prefix, _le32(uint32(nonce)));
                digest = _hash256(header);
                // Raw digest's last byte is the most significant byte of the
                // byte-reversed work value compared against the target
                // (~2^255) by ValidateSPV.validateHeaderChain.
                if (uint8(digest[31]) < 0x7f) {
                    mined = true;
                    break;
                }
            }
            require(mined, "BtcBuilder: header nonce search exhausted");

            chain = bytes.concat(chain, header);
            prevHash = digest;
        }

        headers = chain;
    }

    function _serialize(
        BitcoinTx.Info memory info
    ) private pure returns (bytes memory) {
        return
            abi.encodePacked(
                info.version,
                info.inputVector,
                info.outputVector,
                info.locktime
            );
    }

    function _hash256(bytes memory b) private pure returns (bytes32) {
        return sha256(abi.encodePacked(sha256(b)));
    }

    function _hash160(bytes memory b) private pure returns (bytes20) {
        return ripemd160(abi.encodePacked(sha256(b)));
    }

    /// @dev Bitcoin compactSize (varint) encoding.
    function _compactSize(uint256 n) private pure returns (bytes memory) {
        if (n <= 252) {
            return abi.encodePacked(uint8(n));
        } else if (n <= 0xffff) {
            return abi.encodePacked(hex"fd", uint8(n), uint8(n >> 8));
        } else if (n <= 0xffffffff) {
            return abi.encodePacked(hex"fe", _le32(uint32(n)));
        }
        return abi.encodePacked(hex"ff", _le64(uint64(n)));
    }

    function _le32(uint32 v) private pure returns (bytes4) {
        return
            bytes4(
                (v << 24) |
                    ((v & 0xff00) << 8) |
                    ((v >> 8) & 0xff00) |
                    (v >> 24)
            );
    }

    function _le64(uint64 v) private pure returns (bytes8) {
        return
            bytes8(
                (uint64(uint32(_le32(uint32(v)))) << 32) |
                    uint64(uint32(_le32(uint32(v >> 32))))
            );
    }
}
