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

import "./BridgeState.sol";
import "./EcdsaFraudRouterProtocol.sol";

/// @title Bridge fraud helpers
/// @notice The ECDSA fraud lifecycle (submit / defeat / timeout) was
///         extracted out of this library into the `EcdsaFraudRouter`
///         sidecar. Only the pieces that have to stay reachable from
///         Bridge storage remain here:
///
///         - The `FraudChallenge` struct, which Bridge keeps in its
///           legacy `BridgeState.fraudChallenges` mapping so the
///           one-time `migrateFraudChallengesToRouter` helper can read
///           pre-cutover entries out and hand them to the router.
///
///         - Three pure BIP-143 preimage helpers
///           (`extractUtxoKeyFromWitnessPreimage`,
///           `extractUtxoKeyFromNonWitnessPreimage`,
///           `extractSighashType`). The watchtower and external tooling
///           still call into these, so they remain part of Bridge's
///           public surface area.
///
///         The fraud events that used to live here have moved to
///         `EcdsaFraudRouter`. The fraud entry points have been removed
///         entirely.
library Fraud {
    using BytesLib for bytes;
    using BTCUtils for bytes;
    using BTCUtils for uint32;
    using BridgeState for BridgeState.Storage;

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

    event LegacyFraudChallengeMigrated(
        uint8 indexed routerKind,
        uint256 indexed challengeKey,
        address indexed challenger,
        uint256 depositAmount
    );

    event EcdsaFraudRouterDrainStarted(address indexed ecdsaFraudRouter);
    event EcdsaFraudRouterRetired(address indexed ecdsaFraudRouter);
    event EcdsaFraudRouterReplaced(
        address indexed previousEcdsaFraudRouter,
        address indexed newEcdsaFraudRouter
    );
    event EcdsaFraudRouterSet(address ecdsaFraudRouter);

    error InvalidLegacyFraudRouterKind();
    error LegacyFraudRouterNotSet();
    error LegacyFraudChallengeDoesNotExist();
    error LegacyFraudChallengeAlreadyResolved();
    error EcdsaFraudRouterNotSet();
    error EcdsaFraudRouterDrainAlreadyStarted(address ecdsaFraudRouter);
    error EcdsaFraudRouterDrainNotStarted();
    error EcdsaFraudRouterUnexpected(
        address expectedEcdsaFraudRouter,
        address actualEcdsaFraudRouter
    );
    error EcdsaFraudRouterReplacementUnchanged();

    /// @notice Validates and wires an empty current-generation router on a
    ///         Bridge whose one-shot router slot has never been initialized.
    function configureEcdsaFraudRouter(
        BridgeState.Storage storage self,
        address ecdsaFraudRouter
    ) external {
        if (self.ecdsaFraudRouter != address(0)) {
            revert BridgeState.EcdsaFraudRouterAlreadySet();
        }
        EcdsaFraudRouterProtocol.requireEmptyCurrentRouter(
            ecdsaFraudRouter,
            address(this)
        );
        self.setEcdsaFraudRouter(ecdsaFraudRouter);
    }

    /// @notice Starts the fail-closed drain of an already-wired router.
    /// @dev While the pinned drain address is non-zero, Wallets refuses every
    ///      graceful ECDSA closure. This protects the legacy timeout path even
    ///      though pre-fix routers decrement their global counter before the
    ///      untrusted challenger refund callback.
    function beginEcdsaFraudRouterDrain(BridgeState.Storage storage self)
        external
    {
        address ecdsaFraudRouter = self.ecdsaFraudRouter;
        if (ecdsaFraudRouter == address(0)) {
            revert EcdsaFraudRouterNotSet();
        }
        if (self.ecdsaFraudRouterInDrain != address(0)) {
            revert EcdsaFraudRouterDrainAlreadyStarted(
                self.ecdsaFraudRouterInDrain
            );
        }

        // There is deliberately no drain-cancel escape hatch. Prove the
        // authoritative legacy count is readable before entering that
        // fail-closed state so malformed router wiring cannot brick closure.
        EcdsaFraudRouterProtocol.requireOpenChallengeCount(
            ecdsaFraudRouter
        );

        self.ecdsaFraudRouterInDrain = ecdsaFraudRouter;
        emit EcdsaFraudRouterDrainStarted(ecdsaFraudRouter);
    }

    /// @notice Atomically retires a drained legacy router, installs an empty
    ///         current-generation router, and migrates selected unresolved
    ///         Bridge-resident legacy challenges into it.
    /// @dev The old router cannot export its own ETH or records, so its global
    ///      open count must be exactly zero. Any validation or migration failure
    ///      reverts the pointer swap and retirement marker together.
    function replaceEcdsaFraudRouter(
        BridgeState.Storage storage self,
        address expectedEcdsaFraudRouter,
        address newEcdsaFraudRouter,
        uint256[] calldata legacyChallengeKeys
    ) external {
        address ecdsaFraudRouterInDrain = self.ecdsaFraudRouterInDrain;
        if (ecdsaFraudRouterInDrain == address(0)) {
            revert EcdsaFraudRouterDrainNotStarted();
        }

        address currentEcdsaFraudRouter = self.ecdsaFraudRouter;
        if (
            currentEcdsaFraudRouter != expectedEcdsaFraudRouter ||
            ecdsaFraudRouterInDrain != expectedEcdsaFraudRouter
        ) {
            revert EcdsaFraudRouterUnexpected(
                expectedEcdsaFraudRouter,
                currentEcdsaFraudRouter
            );
        }
        if (newEcdsaFraudRouter == expectedEcdsaFraudRouter) {
            revert EcdsaFraudRouterReplacementUnchanged();
        }

        uint256 openChallengeCount = EcdsaFraudRouterProtocol
            .requireOpenChallengeCount(expectedEcdsaFraudRouter);
        if (openChallengeCount != 0) {
            revert EcdsaFraudRouterProtocol
                .EcdsaFraudRouterHasOpenChallenges(openChallengeCount);
        }
        EcdsaFraudRouterProtocol.requireEmptyCurrentRouter(
            newEcdsaFraudRouter,
            address(this)
        );

        self.retiredEcdsaFraudRouters[expectedEcdsaFraudRouter] = true;
        self.ecdsaFraudRouter = newEcdsaFraudRouter;
        delete self.ecdsaFraudRouterInDrain;

        emit EcdsaFraudRouterRetired(expectedEcdsaFraudRouter);
        emit EcdsaFraudRouterReplaced(
            expectedEcdsaFraudRouter,
            newEcdsaFraudRouter
        );
        emit EcdsaFraudRouterSet(newEcdsaFraudRouter);

        if (legacyChallengeKeys.length > 0) {
            _migrateLegacyFraudChallenges(self, 0, legacyChallengeKeys);
        }
    }

    /// @notice Moves unresolved fraud challenges and their exact ETH escrow
    ///         from legacy Bridge storage into one of the fraud routers.
    /// @dev This function is external so the migration loop stays in linked
    ///      library bytecode instead of the size-constrained Bridge runtime.
    ///      Records are deleted before the router interaction. Any router
    ///      failure reverts the entire delegatecall, restoring both storage
    ///      and escrow atomically.
    function migrateLegacyFraudChallenges(
        BridgeState.Storage storage self,
        uint8 routerKind,
        uint256[] calldata challengeKeys
    ) external {
        _migrateLegacyFraudChallenges(self, routerKind, challengeKeys);
    }

    function _migrateLegacyFraudChallenges(
        BridgeState.Storage storage self,
        uint8 routerKind,
        uint256[] calldata challengeKeys
    ) internal {
        address router;

        if (routerKind == 0) {
            router = self.ecdsaFraudRouter;
        } else if (routerKind == 1) {
            router = self.p2trFraudRouter;
        } else {
            revert InvalidLegacyFraudRouterKind();
        }

        if (router == address(0)) {
            revert LegacyFraudRouterNotSet();
        }

        FraudChallenge[] memory challenges = new FraudChallenge[](
            challengeKeys.length
        );
        uint256 totalDeposit;

        for (uint256 i = 0; i < challengeKeys.length; i++) {
            uint256 challengeKey = challengeKeys[i];
            FraudChallenge storage challenge = self.fraudChallenges[
                challengeKey
            ];

            if (challenge.reportedAt == 0) {
                revert LegacyFraudChallengeDoesNotExist();
            }
            if (challenge.resolved) {
                revert LegacyFraudChallengeAlreadyResolved();
            }

            challenges[i] = challenge;
            totalDeposit += challenge.depositAmount;

            address challenger = challenge.challenger;
            uint256 depositAmount = challenge.depositAmount;
            delete self.fraudChallenges[challengeKey];

            emit LegacyFraudChallengeMigrated(
                routerKind,
                challengeKey,
                challenger,
                depositAmount
            );
        }

        IFraudRouterMigration(router).acceptMigration{value: totalDeposit}(
            challengeKeys,
            challenges
        );
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

/// @dev Common migration receiver implemented by both fraud router sidecars.
interface IFraudRouterMigration {
    function acceptMigration(
        uint256[] calldata challengeKeys,
        Fraud.FraudChallenge[] calldata data
    ) external payable;
}
