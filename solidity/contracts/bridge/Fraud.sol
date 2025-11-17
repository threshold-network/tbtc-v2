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

import {BytesLib} from "@keep-network/bitcoin-spv-sol/contracts/BytesLib.sol";
import {BTCUtils} from "@keep-network/bitcoin-spv-sol/contracts/BTCUtils.sol";
import {CheckBitcoinSigs} from "@keep-network/bitcoin-spv-sol/contracts/CheckBitcoinSigs.sol";

import "./BitcoinTx.sol";
import "./EcdsaLib.sol";
import "./BridgeState.sol";
import "./Heartbeat.sol";
import "./MovingFunds.sol";
import "./Wallets.sol";

/// @title Bridge fraud
/// @notice The library handles the logic for challenging Bridge wallets that
///         committed fraud.
/// @dev Anyone can submit a fraud challenge indicating that a UTXO being under
///      the wallet control was unlocked by the wallet but was not used
///      according to the protocol rules. That means the wallet signed
///      a transaction input pointing to that UTXO and there is a unique
///      sighash and signature pair associated with that input.
///
///      In order to defeat the challenge, the same wallet public key and
///      signature must be provided as were used to calculate the sighash during
///      the challenge. The wallet provides the preimage which produces sighash
///      used to generate the ECDSA signature that is the subject of the fraud
///      claim.
///
///      The fraud challenge defeat attempt will succeed if the inputs in the
///      preimage are considered honestly spent by the wallet. Therefore the
///      transaction spending the UTXO must be proven in the Bridge before
///      a challenge defeat is called.
///
///      Another option is when a malicious wallet member used a signed heartbeat
///      message periodically produced by the wallet off-chain to challenge the
///      wallet for a fraud. Anyone from the wallet can defeat the challenge by
///      proving the sighash and signature were produced for a heartbeat message
///      following a strict format.
library Fraud {
    using Wallets for BridgeState.Storage;

    using BytesLib for bytes;
    using BTCUtils for bytes;
    using BTCUtils for uint32;
    using EcdsaLib for bytes;

    struct FraudChallenge {
        // The address of the party challenging the wallet.
        address challenger;
        // The amount of ETH the challenger deposited.
        uint256 depositAmount;
        // The timestamp the challenge was submitted at.
        // XXX: Unsigned 32-bit int unix seconds, will break February 7th 2106.
        uint32 reportedAt;
        // The flag indicating whether the challenge has been resolved.
        bool resolved;
        // This struct doesn't contain `__gap` property as the structure is stored
        // in a mapping, mappings store values in different slots and they are
        // not contiguous with other values.
    }

    event FraudChallengeSubmitted(
        bytes20 indexed walletPubKeyHash,
        bytes32 sighash,
        uint8 v,
        bytes32 r,
        bytes32 s
    );

    event FraudChallengeDefeated(
        bytes20 indexed walletPubKeyHash,
        bytes32 sighash
    );

    event FraudChallengeDefeatTimedOut(
        bytes20 indexed walletPubKeyHash,
        // Sighash calculated as a Bitcoin's hash256 (double sha2) of:
        // - a preimage of a transaction spending UTXO according to the protocol
        //   rules OR
        // - a valid heartbeat message produced by the wallet off-chain.
        bytes32 sighash
    );

    /// @notice Submits a fraud challenge indicating that a UTXO being under
    ///         wallet control was unlocked by the wallet but was not used
    ///         according to the protocol rules. That means the wallet signed
    ///         a transaction input pointing to that UTXO and there is a unique
    ///         sighash and signature pair associated with that input. This
    ///         function uses those parameters to create a fraud accusation that
    ///         proves a given transaction input unlocking the given UTXO was
    ///         actually signed by the wallet. This function cannot determine
    ///         whether the transaction was actually broadcast and the input was
    ///         consumed in a fraudulent way so it just opens a challenge period
    ///         during which the wallet can defeat the challenge by submitting
    ///         proof of a transaction that consumes the given input according
    ///         to protocol rules. To prevent spurious allegations, the caller
    ///         must deposit ETH that is returned back upon justified fraud
    ///         challenge or confiscated otherwise.
    /// @param walletPublicKey The public key of the wallet in the uncompressed
    ///        and unprefixed format (64 bytes).
    /// @param preimageSha256 The hash that was generated by applying SHA-256
    ///        one time over the preimage used during input signing. The preimage
    ///        is a serialized subset of the transaction and its structure
    ///        depends on the transaction input (see BIP-143 for reference).
    ///        Notice that applying SHA-256 over the `preimageSha256` results
    ///        in `sighash`.  The path from `preimage` to `sighash` looks like
    ///        this:
    ///        preimage -> (SHA-256) -> preimageSha256 -> (SHA-256) -> sighash.
    /// @param signature Bitcoin signature in the R/S/V format
    /// @dev Requirements:
    ///      - Wallet behind `walletPublicKey` must be in Live or MovingFunds
    ///        or Closing state,
    ///      - The challenger must send appropriate amount of ETH used as
    ///        fraud challenge deposit,
    ///      - The signature (represented by r, s and v) must be generated by
    ///        the wallet behind `walletPubKey` during signing of `sighash`
    ///        which was calculated from `preimageSha256`,
    ///      - Wallet can be challenged for the given signature only once.
    function submitFraudChallenge(
        BridgeState.Storage storage self,
        bytes calldata walletPublicKey,
        bytes memory preimageSha256,
        BitcoinTx.RSVSignature calldata signature
    ) external {
        require(
            msg.value >= self.fraudChallengeDepositAmount,
            "The amount of ETH deposited is too low"
        );

        // To prevent ECDSA signature forgery `sighash` must be calculated
        // inside the function and not passed as a function parameter.
        // Signature forgery could result in a wrongful fraud accusation
        // against a wallet.
        bytes32 sighash = sha256(preimageSha256);

        require(
            CheckBitcoinSigs.checkSig(
                walletPublicKey,
                sighash,
                signature.v,
                signature.r,
                signature.s
            ),
            "Signature verification failure"
        );

        bytes memory compressedWalletPublicKey = EcdsaLib.compressPublicKey(
            walletPublicKey.slice32(0),
            walletPublicKey.slice32(32)
        );
        bytes20 walletPubKeyHash = compressedWalletPublicKey.hash160View();

        Wallets.Wallet storage wallet = self.registeredWallets[
            walletPubKeyHash
        ];

        require(
            wallet.state == Wallets.WalletState.Live ||
                wallet.state == Wallets.WalletState.MovingFunds ||
                wallet.state == Wallets.WalletState.Closing,
            "Wallet must be in Live or MovingFunds or Closing state"
        );

        uint256 challengeKey = uint256(
            keccak256(abi.encodePacked(walletPublicKey, sighash))
        );

        FraudChallenge storage challenge = self.fraudChallenges[challengeKey];
        require(challenge.reportedAt == 0, "Fraud challenge already exists");

        challenge.challenger = msg.sender;
        challenge.depositAmount = msg.value;
        /* solhint-disable-next-line not-rely-on-time */
        challenge.reportedAt = uint32(block.timestamp);
        challenge.resolved = false;
        // slither-disable-next-line reentrancy-events
        emit FraudChallengeSubmitted(
            walletPubKeyHash,
            sighash,
            signature.v,
            signature.r,
            signature.s
        );
    }

    /// @notice Allows to defeat a pending fraud challenge against a wallet if
    ///         the transaction that spends the UTXO follows the protocol rules.
    ///         In order to defeat the challenge the same `walletPublicKey` and
    ///         signature (represented by `r`, `s` and `v`) must be provided as
    ///         were used to calculate the sighash during input signing.
    ///         The fraud challenge defeat attempt will only succeed if the
    ///         inputs in the preimage are considered honestly spent by the
    ///         wallet. Therefore the transaction spending the UTXO must be
    ///         proven in the Bridge before a challenge defeat is called.
    ///         If successfully defeated, the fraud challenge is marked as
    ///         resolved and the amount of ether deposited by the challenger is
    ///         sent to the treasury.
    /// @param walletPublicKey The public key of the wallet in the uncompressed
    ///        and unprefixed format (64 bytes).
    /// @param preimage The preimage which produces sighash used to generate the
    ///        ECDSA signature that is the subject of the fraud claim. It is a
    ///        serialized subset of the transaction. The exact subset used as
    ///        the preimage depends on the transaction input the signature is
    ///        produced for. See BIP-143 for reference.
    /// @param witness Flag indicating whether the preimage was produced for a
    ///        witness input. True for witness, false for non-witness input.
    /// @dev Requirements:
    ///      - `walletPublicKey` and `sighash` calculated as `hash256(preimage)`
    ///        must identify an open fraud challenge,
    ///      - the preimage must be a valid preimage of a transaction generated
    ///        according to the protocol rules and already proved in the Bridge,
    ///      - before a defeat attempt is made the transaction that spends the
    ///        given UTXO must be proven in the Bridge.
    function defeatFraudChallenge(
        BridgeState.Storage storage self,
        bytes calldata walletPublicKey,
        bytes calldata preimage,
        bool witness
    ) external {
        bytes32 sighash = preimage.hash256();

        uint256 challengeKey = uint256(
            keccak256(abi.encodePacked(walletPublicKey, sighash))
        );

        FraudChallenge storage challenge = self.fraudChallenges[challengeKey];

        require(challenge.reportedAt > 0, "Fraud challenge does not exist");
        require(
            !challenge.resolved,
            "Fraud challenge has already been resolved"
        );

        // Ensure SIGHASH_ALL type was used during signing, which is represented
        // by type value `1`.
        require(extractSighashType(preimage) == 1, "Wrong sighash type");

        uint256 utxoKey = witness
            ? extractUtxoKeyFromWitnessPreimage(preimage)
            : extractUtxoKeyFromNonWitnessPreimage(preimage);

        // Check that the UTXO key identifies a correctly spent UTXO.
        require(
            self.deposits[utxoKey].sweptAt > 0 ||
                self.spentMainUTXOs[utxoKey] ||
                self.movedFundsSweepRequests[utxoKey].state ==
                MovingFunds.MovedFundsSweepRequestState.Processed,
            "Spent UTXO not found among correctly spent UTXOs"
        );

        resolveFraudChallenge(self, walletPublicKey, challenge, sighash);
    }

    /// @notice Allows to defeat a pending fraud challenge against a wallet by
    ///         proving the sighash and signature were produced for an off-chain
    ///         wallet heartbeat message following a strict format.
    ///         In order to defeat the challenge the same `walletPublicKey` and
    ///         signature (represented by `r`, `s` and `v`) must be provided as
    ///         were used to calculate the sighash during heartbeat message
    ///         signing. The fraud challenge defeat attempt will only succeed if
    ///         the signed message follows a strict format required for
    ///         heartbeat messages. If successfully defeated, the fraud
    ///         challenge is marked as resolved and the amount of ether
    ///         deposited by the challenger is sent to the treasury.
    /// @param walletPublicKey The public key of the wallet in the uncompressed
    ///        and unprefixed format (64 bytes),
    /// @param heartbeatMessage Off-chain heartbeat message meeting the heartbeat
    ///        message format requirements which produces sighash used to
    ///        generate the ECDSA signature that is the subject of the fraud
    ///        claim.
    /// @dev Requirements:
    ///      - `walletPublicKey` and `sighash` calculated as
    ///        `hash256(heartbeatMessage)` must identify an open fraud challenge,
    ///      - `heartbeatMessage` must follow a strict format of heartbeat
    ///        messages.
    function defeatFraudChallengeWithHeartbeat(
        BridgeState.Storage storage self,
        bytes calldata walletPublicKey,
        bytes calldata heartbeatMessage
    ) external {
        bytes32 sighash = heartbeatMessage.hash256();

        uint256 challengeKey = uint256(
            keccak256(abi.encodePacked(walletPublicKey, sighash))
        );

        FraudChallenge storage challenge = self.fraudChallenges[challengeKey];

        require(challenge.reportedAt > 0, "Fraud challenge does not exist");
        require(
            !challenge.resolved,
            "Fraud challenge has already been resolved"
        );

        require(
            Heartbeat.isValidHeartbeatMessage(heartbeatMessage),
            "Not a valid heartbeat message"
        );

        resolveFraudChallenge(self, walletPublicKey, challenge, sighash);
    }

    /// @notice Called only for successfully defeated fraud challenges.
    ///         The fraud challenge is marked as resolved and the amount of
    ///         ether deposited by the challenger is sent to the treasury.
    /// @dev Requirements:
    ///      - Must be called only for successfully defeated fraud challenges.
    function resolveFraudChallenge(
        BridgeState.Storage storage self,
        bytes calldata walletPublicKey,
        FraudChallenge storage challenge,
        bytes32 sighash
    ) internal {
        // Mark the challenge as resolved as it was successfully defeated
        challenge.resolved = true;

        // Send the ether deposited by the challenger to the treasury
        /* solhint-disable avoid-low-level-calls */
        // slither-disable-next-line low-level-calls,unchecked-lowlevel,arbitrary-send
        self.treasury.call{gas: 100000, value: challenge.depositAmount}("");
        /* solhint-enable avoid-low-level-calls */

        bytes memory compressedWalletPublicKey = EcdsaLib.compressPublicKey(
            walletPublicKey.slice32(0),
            walletPublicKey.slice32(32)
        );
        bytes20 walletPubKeyHash = compressedWalletPublicKey.hash160View();

        // slither-disable-next-line reentrancy-events
        emit FraudChallengeDefeated(walletPubKeyHash, sighash);
    }

    /// @notice Notifies about defeat timeout for the given fraud challenge.
    ///         Can be called only if there was a fraud challenge identified by
    ///         the provided `walletPublicKey` and `sighash` and it was not
    ///         defeated on time. The amount of time that needs to pass after
    ///         a fraud challenge is reported is indicated by the
    ///         `challengeDefeatTimeout`. After a successful fraud challenge
    ///         defeat timeout notification the fraud challenge is marked as
    ///         resolved, the stake of each operator is slashed, the ether
    ///         deposited is returned to the challenger and the challenger is
    ///         rewarded.
    /// @param walletPublicKey The public key of the wallet in the uncompressed
    ///        and unprefixed format (64 bytes).
    /// @param walletMembersIDs Identifiers of the wallet signing group members.
    /// @param preimageSha256 The hash that was generated by applying SHA-256
    ///        one time over the preimage used during input signing. The preimage
    ///        is a serialized subset of the transaction and its structure
    ///        depends on the transaction input (see BIP-143 for reference).
    ///        Notice that applying SHA-256 over the `preimageSha256` results
    ///        in `sighash`.  The path from `preimage` to `sighash` looks like
    ///        this:
    ///        preimage -> (SHA-256) -> preimageSha256 -> (SHA-256) -> sighash.
    /// @dev Requirements:
    ///      - The wallet must be in the Live or MovingFunds or Closing or
    ///        Terminated state,
    ///      - The `walletPublicKey` and `sighash` calculated from
    ///        `preimageSha256` must identify an open fraud challenge,
    ///      - The expression `keccak256(abi.encode(walletMembersIDs))` must
    ///        be exactly the same as the hash stored under `membersIdsHash`
    ///        for the given `walletID`. Those IDs are not directly stored
    ///        in the contract for gas efficiency purposes but they can be
    ///        read from appropriate `DkgResultSubmitted` and `DkgResultApproved`
    ///        events of the `WalletRegistry` contract,
    ///      - The amount of time indicated by `challengeDefeatTimeout` must pass
    ///        after the challenge was reported.
    function notifyFraudChallengeDefeatTimeout(
        BridgeState.Storage storage self,
        bytes calldata walletPublicKey,
        uint32[] calldata walletMembersIDs,
        bytes memory preimageSha256
    ) external {
        // Wallet state is validated in `notifyWalletFraudChallengeDefeatTimeout`.

        bytes32 sighash = sha256(preimageSha256);

        uint256 challengeKey = uint256(
            keccak256(abi.encodePacked(walletPublicKey, sighash))
        );

        FraudChallenge storage challenge = self.fraudChallenges[challengeKey];

        require(challenge.reportedAt > 0, "Fraud challenge does not exist");

        require(
            !challenge.resolved,
            "Fraud challenge has already been resolved"
        );

        require(
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp >=
                challenge.reportedAt + self.fraudChallengeDefeatTimeout,
            "Fraud challenge defeat period did not time out yet"
        );

        challenge.resolved = true;
        // Return the ether deposited by the challenger
        /* solhint-disable avoid-low-level-calls */
        // slither-disable-next-line low-level-calls,unchecked-lowlevel
        challenge.challenger.call{gas: 100000, value: challenge.depositAmount}(
            ""
        );
        /* solhint-enable avoid-low-level-calls */

        bytes memory compressedWalletPublicKey = EcdsaLib.compressPublicKey(
            walletPublicKey.slice32(0),
            walletPublicKey.slice32(32)
        );
        bytes20 walletPubKeyHash = compressedWalletPublicKey.hash160View();

        self.notifyWalletFraudChallengeDefeatTimeout(
            walletPubKeyHash,
            walletMembersIDs,
            challenge.challenger
        );

        // slither-disable-next-line reentrancy-events
        emit FraudChallengeDefeatTimedOut(walletPubKeyHash, sighash);
    }

    /// @notice Extracts the UTXO keys from the given preimage used during
    ///         signing of a witness input.
    /// @param preimage The preimage which produces sighash used to generate the
    ///        ECDSA signature that is the subject of the fraud claim. It is a
    ///        serialized subset of the transaction. The exact subset used as
    ///        the preimage depends on the transaction input the signature is
    ///        produced for. See BIP-143 for reference
    /// @return utxoKey UTXO key that identifies spent input.
    function extractUtxoKeyFromWitnessPreimage(bytes calldata preimage)
        internal
        pure
        returns (uint256 utxoKey)
    {
        // The expected structure of the preimage created during signing of a
        // witness input:
        // - transaction version (4 bytes)
        // - hash of previous outpoints of all inputs (32 bytes)
        // - hash of sequences of all inputs (32 bytes)
        // - outpoint (hash + index) of the input being signed (36 bytes)
        // - the unlocking script of the input (variable length)
        // - value of the outpoint (8 bytes)
        // - sequence of the input being signed (4 bytes)
        // - hash of all outputs (32 bytes)
        // - transaction locktime (4 bytes)
        // - sighash type (4 bytes)

        // See Bitcoin's BIP-143 for reference:
        // https://github.com/bitcoin/bips/blob/master/bip-0143.mediawiki.

        // The outpoint (hash and index) is located at the constant offset of
        // 68 (4 + 32 + 32).
        bytes32 outpointTxHash = preimage.extractInputTxIdLeAt(68);
        uint32 outpointIndex = BTCUtils.reverseUint32(
            uint32(preimage.extractTxIndexLeAt(68))
        );

        return
            uint256(keccak256(abi.encodePacked(outpointTxHash, outpointIndex)));
    }

    /// @notice Extracts the UTXO key from the given preimage used during
    ///         signing of a non-witness input.
    /// @param preimage The preimage which produces sighash used to generate the
    ///        ECDSA signature that is the subject of the fraud claim. It is a
    ///        serialized subset of the transaction. The exact subset used as
    ///        the preimage depends on the transaction input the signature is
    ///        produced for. See BIP-143 for reference.
    /// @return utxoKey UTXO key that identifies spent input.
    function extractUtxoKeyFromNonWitnessPreimage(bytes calldata preimage)
        internal
        pure
        returns (uint256 utxoKey)
    {
        // The expected structure of the preimage created during signing of a
        // non-witness input:
        // - transaction version (4 bytes)
        // - number of inputs written as compactSize uint (1 byte, 3 bytes,
        //   5 bytes or 9 bytes)
        // - for each input
        //   - outpoint (hash and index) (36 bytes)
        //   - unlocking script for the input being signed (variable length)
        //     or `00` for all other inputs (1 byte)
        //   - input sequence (4 bytes)
        // - number of outputs written as compactSize uint (1 byte, 3 bytes,
        //   5 bytes or 9 bytes)
        // - outputs (variable length)
        // - transaction locktime (4 bytes)
        // - sighash type (4 bytes)

        // See example for reference:
        // https://en.bitcoin.it/wiki/OP_CHECKSIG#Code_samples_and_raw_dumps.

        // The input data begins at the constant offset of 4 (the first 4 bytes
        // are for the transaction version).
        (uint256 inputsCompactSizeUintLength, uint256 inputsCount) = preimage
            .parseVarIntAt(4);

        // To determine the first input starting index, we must jump 4 bytes
        // over the transaction version length and the compactSize uint which
        // prepends the input vector. One byte must be added because
        // `BtcUtils.parseVarInt` does not include compactSize uint tag in the
        // returned length.
        //
        // For >= 0 && <= 252, `BTCUtils.determineVarIntDataLengthAt`
        // returns `0`, so we jump over one byte of compactSize uint.
        //
        // For >= 253 && <= 0xffff there is `0xfd` tag,
        // `BTCUtils.determineVarIntDataLengthAt` returns `2` (no
        // tag byte included) so we need to jump over 1+2 bytes of
        // compactSize uint.
        //
        // Please refer `BTCUtils` library and compactSize uint
        // docs in `BitcoinTx` library for more details.
        uint256 inputStartingIndex = 4 + 1 + inputsCompactSizeUintLength;

        for (uint256 i = 0; i < inputsCount; i++) {
            uint256 inputLength = preimage.determineInputLengthAt(
                inputStartingIndex
            );

            (, uint256 scriptSigLength) = preimage.extractScriptSigLenAt(
                inputStartingIndex
            );

            if (scriptSigLength > 0) {
                // The input this preimage was generated for was found.
                // All the other inputs in the preimage are marked with a null
                // scriptSig ("00") which has length of 1.
                bytes32 outpointTxHash = preimage.extractInputTxIdLeAt(
                    inputStartingIndex
                );
                uint32 outpointIndex = BTCUtils.reverseUint32(
                    uint32(preimage.extractTxIndexLeAt(inputStartingIndex))
                );

                utxoKey = uint256(
                    keccak256(abi.encodePacked(outpointTxHash, outpointIndex))
                );

                break;
            }

            inputStartingIndex += inputLength;
        }

        return utxoKey;
    }

    /// @notice Extracts the sighash type from the given preimage.
    /// @param preimage Serialized subset of the transaction. See BIP-143 for
    ///        reference.
    /// @dev Sighash type is stored as the last 4 bytes in the preimage (little
    ///      endian).
    /// @return sighashType Sighash type as a 32-bit integer.
    function extractSighashType(bytes calldata preimage)
        internal
        pure
        returns (uint32 sighashType)
    {
        bytes4 sighashTypeBytes = preimage.slice4(preimage.length - 4);
        uint32 sighashTypeLE = uint32(sighashTypeBytes);
        return sighashTypeLE.reverseUint32();
    }
}
