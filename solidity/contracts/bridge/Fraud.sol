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

    uint8 internal constant CUTOVER_BEGIN_DRAIN = 0;
    uint8 internal constant CUTOVER_MIGRATE = 1;
    uint8 internal constant CUTOVER_FINALIZE = 2;
    uint8 internal constant LEGACY_ROUTER_MIGRATE = 3;

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
    event EcdsaFraudRouterCodeHashApproved(
        address indexed ecdsaFraudRouter,
        bytes32 indexed runtimeCodeHash
    );
    event EcdsaFraudRouterMigrationPrepared(
        address indexed previousEcdsaFraudRouter,
        address indexed newEcdsaFraudRouter,
        bytes32 indexed challengeSetHash,
        uint256 challengeCount,
        uint256 totalEscrow
    );

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
    error EcdsaFraudRouterAlreadyRetired(address ecdsaFraudRouter);
    error EcdsaFraudRouterMigrationPending();
    error EcdsaFraudInventoryKeysNotStrictlyIncreasing();
    error EcdsaFraudInventoryChallengeSetMismatch();
    error EcdsaFraudInventoryTotalEscrowMismatch();
    error EcdsaFraudRouterCutoverActionInvalid();

    /// @notice Single Bridge-facing dispatcher for every cutover mutation.
    /// @dev Decoding in linked-library bytecode keeps three large dynamic ABI
    ///      forwarding paths out of Bridge's size-constrained runtime.
    function processEcdsaFraudRouterCutover(
        BridgeState.Storage storage self,
        uint8 action,
        bytes calldata payload
    ) external {
        if (action == CUTOVER_BEGIN_DRAIN) {
            (bytes32 expectedCodeHash, address newEcdsaFraudRouter) = abi
                .decode(payload, (bytes32, address));
            _beginEcdsaFraudRouterDrain(
                self,
                expectedCodeHash,
                newEcdsaFraudRouter
            );
            return;
        }
        if (action == CUTOVER_MIGRATE) {
            (
                address expectedEcdsaFraudRouter,
                address newEcdsaFraudRouter,
                bytes32 expectedNewCodeHash,
                bytes32 expectedChallengeSetHash,
                uint256 expectedTotalEscrow,
                uint256[] memory legacyChallengeKeys
            ) = abi.decode(
                    payload,
                    (address, address, bytes32, bytes32, uint256, uint256[])
                );
            _migrateEcdsaFraudRouter(
                self,
                expectedEcdsaFraudRouter,
                newEcdsaFraudRouter,
                expectedNewCodeHash,
                expectedChallengeSetHash,
                expectedTotalEscrow,
                legacyChallengeKeys
            );
            return;
        }
        if (action == CUTOVER_FINALIZE) {
            (
                address expectedEcdsaFraudRouter,
                address newEcdsaFraudRouter,
                bytes32 expectedNewCodeHash,
                uint256 expectedOpenChallengeCount
            ) = abi.decode(payload, (address, address, bytes32, uint256));
            _finalizeEcdsaFraudRouterReplacement(
                self,
                expectedEcdsaFraudRouter,
                newEcdsaFraudRouter,
                expectedNewCodeHash,
                expectedOpenChallengeCount
            );
            return;
        }
        if (action == LEGACY_ROUTER_MIGRATE) {
            (uint8 routerKind, uint256[] memory challengeKeys) = abi.decode(
                payload,
                (uint8, uint256[])
            );
            _migrateLegacyFraudChallenges(self, routerKind, challengeKeys);
            return;
        }

        revert EcdsaFraudRouterCutoverActionInvalid();
    }

    /// @notice Validates and wires an empty current-generation router on a
    ///         Bridge whose one-shot router slot has never been initialized.
    function configureEcdsaFraudRouter(
        BridgeState.Storage storage self,
        address ecdsaFraudRouter,
        bytes32 expectedCodeHash
    ) external {
        if (self.ecdsaFraudRouter != address(0)) {
            revert BridgeState.EcdsaFraudRouterAlreadySet();
        }
        EcdsaFraudRouterProtocol.requireEmptyCurrentRouter(
            ecdsaFraudRouter,
            address(this),
            expectedCodeHash,
            address(0)
        );
        self.setEcdsaFraudRouter(ecdsaFraudRouter);
        self.ecdsaFraudRouterCodeHash = expectedCodeHash;
        emit EcdsaFraudRouterCodeHashApproved(
            ecdsaFraudRouter,
            expectedCodeHash
        );
    }

    /// @notice Starts the fail-closed drain of an already-wired router.
    /// @dev While the pinned drain address is non-zero, Wallets refuses every
    ///      graceful ECDSA closure. This protects the legacy timeout path even
    ///      though pre-fix routers decrement their global counter before the
    ///      untrusted challenger refund callback.
    function _beginEcdsaFraudRouterDrain(
        BridgeState.Storage storage self,
        bytes32 expectedCodeHash,
        address newEcdsaFraudRouter
    ) private {
        address ecdsaFraudRouter = self.ecdsaFraudRouter;
        if (ecdsaFraudRouter == address(0)) {
            revert EcdsaFraudRouterNotSet();
        }
        if (self.ecdsaFraudRouterInDrain != address(0)) {
            revert EcdsaFraudRouterDrainAlreadyStarted(
                self.ecdsaFraudRouterInDrain
            );
        }
        if (self.retiredEcdsaFraudRouters[newEcdsaFraudRouter]) {
            revert EcdsaFraudRouterAlreadyRetired(newEcdsaFraudRouter);
        }
        // There is deliberately no drain-cancel escape hatch. Prove the
        // authoritative legacy count is readable before entering that
        // fail-closed state so malformed router wiring cannot brick closure.
        // Read and require both the authoritative unresolved count and the
        // escrow counter (when present) in the same transaction that enters
        // the no-cancel drain. This closes the Safe/Timelock delay between an
        // off-chain zero-state preflight and calldata execution.
        EcdsaFraudRouterProtocol.requireEmptyAncestry(ecdsaFraudRouter);
        bytes32 approvedCodeHash = self.ecdsaFraudRouterCodeHash;
        if (
            approvedCodeHash != bytes32(0) &&
            approvedCodeHash != expectedCodeHash
        ) {
            revert EcdsaFraudRouterProtocol.EcdsaFraudRouterCodeHashMismatch(
                ecdsaFraudRouter,
                approvedCodeHash,
                expectedCodeHash
            );
        }
        EcdsaFraudRouterProtocol.requireCodeHash(
            ecdsaFraudRouter,
            expectedCodeHash
        );
        if (approvedCodeHash == bytes32(0)) {
            self.ecdsaFraudRouterCodeHash = expectedCodeHash;
            emit EcdsaFraudRouterCodeHashApproved(
                ecdsaFraudRouter,
                expectedCodeHash
            );
        }

        self.ecdsaFraudRouterInDrain = ecdsaFraudRouter;
        emit EcdsaFraudRouterDrainStarted(ecdsaFraudRouter);
    }

    /// @notice Migrates Bridge-resident legacy challenges into an inactive
    ///         replacement without changing the authoritative router or
    ///         clearing the drain lock.
    /// @dev The governance coordinator independently commits and reconciles
    ///      the inventory around this call. Returning the hash and escrow sum
    ///      lets it reject an incomplete caller-supplied key set atomically.
    function _migrateEcdsaFraudRouter(
        BridgeState.Storage storage self,
        address expectedEcdsaFraudRouter,
        address newEcdsaFraudRouter,
        bytes32 expectedNewCodeHash,
        bytes32 expectedChallengeSetHash,
        uint256 expectedTotalEscrow,
        uint256[] memory legacyChallengeKeys
    ) private {
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
        if (self.retiredEcdsaFraudRouters[newEcdsaFraudRouter]) {
            revert EcdsaFraudRouterAlreadyRetired(newEcdsaFraudRouter);
        }

        EcdsaFraudRouterProtocol.requireCodeHash(
            expectedEcdsaFraudRouter,
            self.ecdsaFraudRouterCodeHash
        );

        uint256 openChallengeCount = EcdsaFraudRouterProtocol
            .requireOpenChallengeCount(expectedEcdsaFraudRouter);
        if (openChallengeCount != 0) {
            revert EcdsaFraudRouterProtocol.EcdsaFraudRouterHasOpenChallenges(
                openChallengeCount
            );
        }
        EcdsaFraudRouterProtocol.requireEmptyCurrentRouter(
            newEcdsaFraudRouter,
            address(this),
            expectedNewCodeHash,
            expectedEcdsaFraudRouter
        );

        (
            bytes32 challengeSetHash,
            uint256 totalEscrow
        ) = _migrateLegacyFraudChallengesTo(
                self,
                0,
                newEcdsaFraudRouter,
                legacyChallengeKeys,
                true
            );
        if (challengeSetHash != expectedChallengeSetHash) {
            revert EcdsaFraudInventoryChallengeSetMismatch();
        }
        if (totalEscrow != expectedTotalEscrow) {
            revert EcdsaFraudInventoryTotalEscrowMismatch();
        }
        emit EcdsaFraudRouterMigrationPrepared(
            expectedEcdsaFraudRouter,
            newEcdsaFraudRouter,
            challengeSetHash,
            legacyChallengeKeys.length,
            totalEscrow
        );
    }

    /// @notice Activates a replacement only after the governance coordinator
    ///         has independently reconciled its migrated state and observed a
    ///         full governance delay.
    function _finalizeEcdsaFraudRouterReplacement(
        BridgeState.Storage storage self,
        address expectedEcdsaFraudRouter,
        address newEcdsaFraudRouter,
        bytes32 expectedNewCodeHash,
        uint256 expectedOpenChallengeCount
    ) private {
        address currentEcdsaFraudRouter = self.ecdsaFraudRouter;
        if (
            self.ecdsaFraudRouterInDrain != expectedEcdsaFraudRouter ||
            currentEcdsaFraudRouter != expectedEcdsaFraudRouter
        ) {
            revert EcdsaFraudRouterUnexpected(
                expectedEcdsaFraudRouter,
                currentEcdsaFraudRouter
            );
        }
        if (self.retiredEcdsaFraudRouters[newEcdsaFraudRouter]) {
            revert EcdsaFraudRouterAlreadyRetired(newEcdsaFraudRouter);
        }

        EcdsaFraudRouterProtocol.requireCodeHash(
            expectedEcdsaFraudRouter,
            self.ecdsaFraudRouterCodeHash
        );
        uint256 oldOpenChallengeCount = EcdsaFraudRouterProtocol
            .requireOpenChallengeCount(expectedEcdsaFraudRouter);
        if (oldOpenChallengeCount != 0) {
            revert EcdsaFraudRouterProtocol.EcdsaFraudRouterHasOpenChallenges(
                oldOpenChallengeCount
            );
        }
        EcdsaFraudRouterProtocol.requireCurrentRouter(
            newEcdsaFraudRouter,
            address(this),
            expectedNewCodeHash,
            expectedEcdsaFraudRouter
        );
        if (expectedOpenChallengeCount != 0) {
            revert EcdsaFraudRouterProtocol
                .EcdsaFraudRouterUnexpectedOpenChallengeCount(
                    0,
                    expectedOpenChallengeCount
                );
        }
        uint256 newOpenChallengeCount = EcdsaFraudRouterProtocol
            .requireOpenChallengeCount(newEcdsaFraudRouter);
        if (newOpenChallengeCount != expectedOpenChallengeCount) {
            revert EcdsaFraudRouterProtocol
                .EcdsaFraudRouterUnexpectedOpenChallengeCount(
                    expectedOpenChallengeCount,
                    newOpenChallengeCount
                );
        }
        EcdsaFraudRouterProtocol.requireEmptyAncestry(newEcdsaFraudRouter);

        IEcdsaFraudRouterMigrationActivation(newEcdsaFraudRouter)
            .activateMigratedChallenges();

        self.retiredEcdsaFraudRouters[expectedEcdsaFraudRouter] = true;
        self.ecdsaFraudRouter = newEcdsaFraudRouter;
        self.ecdsaFraudRouterCodeHash = expectedNewCodeHash;
        delete self.ecdsaFraudRouterInDrain;

        emit EcdsaFraudRouterRetired(expectedEcdsaFraudRouter);
        emit EcdsaFraudRouterReplaced(
            expectedEcdsaFraudRouter,
            newEcdsaFraudRouter
        );
        emit EcdsaFraudRouterSet(newEcdsaFraudRouter);
        emit EcdsaFraudRouterCodeHashApproved(
            newEcdsaFraudRouter,
            expectedNewCodeHash
        );
    }

    function _migrateLegacyFraudChallenges(
        BridgeState.Storage storage self,
        uint8 routerKind,
        uint256[] memory challengeKeys
    ) private {
        // The legacy mapping is shared by both router kinds. Once an ECDSA
        // inventory drain starts, no generic migration may delete or reclassify
        // any key until the committed inventory has settled atomically.
        if (self.ecdsaFraudRouterInDrain != address(0)) {
            revert EcdsaFraudRouterMigrationPending();
        }

        address router;
        if (routerKind == 0) {
            router = self.ecdsaFraudRouter;
        } else if (routerKind == 1) {
            router = self.p2trFraudRouter;
        } else {
            revert InvalidLegacyFraudRouterKind();
        }
        _migrateLegacyFraudChallengesTo(
            self,
            routerKind,
            router,
            challengeKeys,
            false
        );
    }

    function _migrateLegacyFraudChallengesTo(
        BridgeState.Storage storage self,
        uint8 routerKind,
        address router,
        uint256[] memory challengeKeys,
        bool requireCanonicalOrder
    ) internal returns (bytes32 challengeSetHash, uint256 totalDeposit) {
        if (router == address(0)) {
            revert LegacyFraudRouterNotSet();
        }

        FraudChallenge[] memory challenges = new FraudChallenge[](
            challengeKeys.length
        );
        for (uint256 i = 0; i < challengeKeys.length; i++) {
            uint256 challengeKey = challengeKeys[i];
            if (
                requireCanonicalOrder &&
                i > 0 &&
                challengeKey <= challengeKeys[i - 1]
            ) {
                revert EcdsaFraudInventoryKeysNotStrictlyIncreasing();
            }
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

        challengeSetHash = keccak256(abi.encode(challengeKeys, challenges));

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

interface IEcdsaFraudRouterMigrationActivation {
    function activateMigratedChallenges() external;
}
