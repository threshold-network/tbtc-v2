// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "./EcdsaFraudRouterProtocol.sol";
import "./EcdsaFraudRouterCutoverVerifier.sol";

interface IBridgeEcdsaFraudCutover {
    function governance() external view returns (address);

    function ecdsaFraudRouter() external view returns (address);

    function ecdsaFraudRouterCodeHash() external view returns (bytes32);

    function legacyFraudChallengeExists(uint256 challengeKey)
        external
        view
        returns (bool);

    function processEcdsaFraudRouterCutover(
        uint8 action,
        bytes calldata payload
    ) external;
}

interface IEcdsaFraudRouterCutoverReadback {
    function bridge() external view returns (address);

    function fraudProtocolID() external view returns (bytes32);

    function openFraudChallengeCount() external view returns (uint256);

    function unattributedOpenFraudChallengeCount()
        external
        view
        returns (uint256);

    function openFraudChallengeEscrow() external view returns (uint256);

    function migratedChallengesActivatedAt() external view returns (uint64);

    function predecessor() external view returns (address);

    function fraudChallenges(uint256 challengeKey)
        external
        view
        returns (
            address challenger,
            uint256 depositAmount,
            uint32 reportedAt,
            bool resolved
        );
}

/// @title ECDSA fraud router cutover coordinator
/// @notice Delayed, independently reconciled state machine linked into the
///         fresh BridgeGovernance deployed for a stateful router cutover.
/// @dev Heavy inventory/readback logic lives in this external library so it
///      does not consume Bridge's EIP-170-constrained runtime. Delegatecall
///      preserves the governance owner or independent reconciler as msg.sender.
library EcdsaFraudRouterCutover {
    uint256 internal constant MAX_BLOCKHASH_AGE = 255;

    enum Phase {
        Idle,
        Draining,
        InventoryStaged,
        InventoryConfirmed,
        Migrated,
        MigrationConfirmed
    }

    struct FraudChallenge {
        address challenger;
        uint256 depositAmount;
        uint32 reportedAt;
        bool resolved;
    }

    struct HistoryEvidence {
        bytes32 historyCommitment;
        bytes32 emitterSetCommitment;
        uint64 blockCount;
        uint64 transactionCount;
        uint64 receiptCount;
        uint64 logCount;
        uint64 emitterLogCount;
        uint64 candidateCallCount;
        uint64 sourceEventCount;
        uint64 lifecycleEventCount;
        bytes32 emitterLogDigest;
        bytes32 candidateCallDigest;
        bytes32 sourceEventDigest;
        bytes32 lifecycleEventDigest;
        bytes32 legacyLiabilityDigest;
        uint256 bridgeBalance;
        uint256 unrelatedBridgeBalance;
    }

    struct AuthorityContext {
        bytes32 durableStoreIdentity;
        bytes32 endpointIdentity;
        bytes32 trustDomain;
        bytes32 policyHash;
    }

    struct AuthorityProof {
        address sourceSigner;
        bytes32 sourceId;
        AuthorityContext sourceContext;
        address reconciler;
        bytes32 reconcilerSourceId;
        AuthorityContext reconcilerContext;
        bytes32 manifestPlanHash;
        uint32 evidenceGeneration;
        bytes32 evidenceAnchorArtifactHash;
        bytes32 evidencePredecessorArtifactHash;
        bytes32 emitterSetCommitment;
        bytes32 sourcePreflightCommitment;
        bytes32 sourceCheckpointCommitment;
        uint64 sourcePreflightFinalizedBlock;
        bytes32 sourcePreflightFinalizedBlockHash;
        uint8 maxTailBlocks;
        bytes sourceManifestSignature;
        bytes reconcilerManifestSignature;
    }

    struct OwnerAuthorizationParams {
        address oldRouter;
        bytes32 oldRouterCodeHash;
        address newRouter;
        bytes32 newRouterCodeHash;
        uint64 scanStartBlock;
        address sourceSigner;
        bytes32 sourceId;
        AuthorityContext sourceContext;
        address reconciler;
        bytes32 reconcilerSourceId;
        AuthorityContext reconcilerContext;
        bytes32 emitterSetCommitment;
    }

    struct BeginDrainParams {
        address oldRouter;
        bytes32 oldRouterCodeHash;
        address newRouter;
        bytes32 newRouterCodeHash;
        uint64 scanStartBlock;
        bytes authorityProof;
    }

    struct InventorySnapshot {
        uint64 finalizedBlock;
        bytes32 finalizedBlockHash;
        bytes32 challengeSetHash;
        uint32 challengeCount;
        uint256 totalEscrow;
        HistoryEvidence history;
    }

    struct Readiness {
        uint8 phase;
        address oldRouter;
        address newRouter;
        bytes32 inventoryCommitment;
        bytes32 postMigrationCommitment;
        address sourceSigner;
        bytes32 sourceId;
        address reconciler;
        bytes32 reconcilerSourceId;
        address pendingReconciler;
        bytes32 pendingReconcilerSourceId;
        uint64 finalizedBlock;
        bytes32 finalizedBlockHash;
        uint64 migratedBlock;
        uint64 migrationConfirmedAt;
        AuthorityContext sourceContext;
        AuthorityContext reconcilerContext;
        AuthorityContext pendingReconcilerContext;
        bytes32 sourceContextCommitment;
        bytes32 reconcilerContextCommitment;
        bytes32 sourceCheckpointRoleDigest;
        bytes32 reconcilerCheckpointRoleDigest;
        bytes32 sourceCheckpointCommitment;
        bytes32 sourcePreflightCommitment;
        uint64 sourcePreflightBlock;
        uint32 evidenceGeneration;
        bytes32 evidenceAnchorArtifactHash;
        bytes32 evidencePredecessorArtifactHash;
        uint64 drainBlock;
        uint8 maxTailBlocks;
        uint64 stageDeadlineBlock;
        bytes32 ownerAuthorizationHash;
    }

    struct Data {
        Phase phase;
        address oldRouter;
        address newRouter;
        bytes32 oldRouterCodeHash;
        bytes32 newRouterCodeHash;
        uint64 drainBlock;
        uint64 scanStartBlock;
        uint64 finalizedBlock;
        bytes32 finalizedBlockHash;
        bytes32 challengeSetHash;
        uint32 challengeCount;
        uint256 totalEscrow;
        HistoryEvidence history;
        bytes32 manifestPlanHash;
        uint32 evidenceGeneration;
        bytes32 evidenceAnchorArtifactHash;
        bytes32 evidencePredecessorArtifactHash;
        bytes32 emitterSetCommitment;
        bytes32 sourcePreflightCommitment;
        bytes32 sourceCheckpointCommitment;
        uint64 sourcePreflightFinalizedBlock;
        bytes32 sourcePreflightFinalizedBlockHash;
        uint8 maxTailBlocks;
        uint64 stageDeadlineBlock;
        bytes32 ownerAuthorizationHash;
        bytes32 manifestSourceAttestationHash;
        bytes32 manifestReconcilerAttestationHash;
        bytes32 sourceAttestationHash;
        bytes32 reconcilerAttestationHash;
        address sourceSigner;
        bytes32 sourceId;
        AuthorityContext sourceContext;
        address reconciler;
        bytes32 reconcilerSourceId;
        AuthorityContext reconcilerContext;
        bytes32 inventoryCommitment;
        bytes32 postMigrationCommitment;
        uint64 migratedBlock;
        uint64 migrationConfirmedAt;
        uint256 governanceDelay;
        address pendingReconciler;
        bytes32 pendingReconcilerSourceId;
        AuthorityContext pendingReconcilerContext;
        bytes32 pendingReconcilerAttestationHash;
        bytes32 pendingSourceRecoveryAttestationHash;
        uint64 reconcilerUpdateStartedAt;
    }

    event EcdsaFraudCutoverDrainStarted(
        address indexed oldRouter,
        address indexed newRouter,
        bytes32 oldRouterCodeHash,
        bytes32 newRouterCodeHash,
        uint64 drainBlock,
        uint64 scanStartBlock,
        address sourceSigner,
        bytes32 sourceId,
        address reconciler,
        bytes32 reconcilerSourceId,
        bytes32 emitterSetCommitment,
        bytes32 sourcePreflightCommitment,
        uint64 sourcePreflightFinalizedBlock,
        uint256 governanceDelay
    );
    event EcdsaFraudCutoverAuthorizationBound(
        bytes32 indexed manifestPlanHash,
        bytes32 indexed sourceCheckpointCommitment,
        uint8 maxTailBlocks,
        uint64 stageDeadlineBlock
    );
    event EcdsaFraudCutoverOwnerAuthorized(
        bytes32 indexed ownerAuthorizationHash
    );
    event EcdsaFraudInventoryStaged(
        bytes32 indexed inventoryCommitment,
        uint64 indexed scanStartBlock,
        uint64 indexed finalizedBlock,
        bytes32 finalizedBlockHash,
        bytes32 challengeSetHash,
        uint32 challengeCount,
        uint256 totalEscrow,
        bytes32 historyEvidenceHash,
        bytes32 sourceAttestationHash,
        bytes32 reconcilerAttestationHash,
        address sourceSigner,
        bytes32 sourceId,
        address reconciler,
        bytes32 reconcilerSourceId
    );
    event EcdsaFraudInventoryConfirmed(
        bytes32 indexed inventoryCommitment,
        address indexed reconciler
    );
    event EcdsaFraudMigrationExecuted(
        bytes32 indexed inventoryCommitment,
        bytes32 indexed challengeSetHash,
        uint32 challengeCount,
        uint256 totalEscrow,
        uint64 migratedBlock
    );
    event EcdsaFraudMigrationConfirmed(
        bytes32 indexed inventoryCommitment,
        bytes32 indexed postMigrationCommitment,
        address indexed reconciler,
        uint64 confirmedAt
    );
    event EcdsaFraudCutoverFinalized(
        address indexed oldRouter,
        address indexed newRouter,
        bytes32 indexed inventoryCommitment,
        bytes32 postMigrationCommitment
    );
    event EcdsaFraudReconcilerUpdateStarted(
        address indexed previousReconciler,
        address indexed pendingReconciler,
        bytes32 indexed pendingReconcilerSourceId,
        bytes32 enrollmentAttestationHash,
        bytes32 sourceRecoveryAttestationHash,
        uint64 startedAt
    );
    event EcdsaFraudReconcilerUpdated(
        address indexed previousReconciler,
        address indexed newReconciler,
        bytes32 indexed newReconcilerSourceId
    );

    error EcdsaFraudCutoverWrongPhase(Phase expected, Phase actual);
    error EcdsaFraudCutoverNotBridgeGovernance();
    error EcdsaFraudCutoverRouterMismatch();
    error EcdsaFraudCutoverRouterRetired(address router);
    error EcdsaFraudCutoverCodeHashMismatch(address router);
    error EcdsaFraudCutoverRouterIncompatible(address router);
    error EcdsaFraudCutoverRouterNotEmpty(address router);
    error EcdsaFraudCutoverInvalidReconciler();
    error EcdsaFraudCutoverInvalidSourceAuthority();
    error EcdsaFraudCutoverInvalidSourceAttestation();
    error EcdsaFraudCutoverInvalidScanRange();
    error EcdsaFraudCutoverBlockNotFinalized();
    error EcdsaFraudCutoverBlockHashUnavailable();
    error EcdsaFraudCutoverBlockHashMismatch();
    error EcdsaFraudCutoverUnauthorizedReconciler();
    error EcdsaFraudCutoverCommitmentMismatch();
    error EcdsaFraudCutoverChallengeCountMismatch();
    error EcdsaFraudCutoverEscrowMismatch();
    error EcdsaFraudCutoverChallengeSetMismatch();
    error EcdsaFraudCutoverLegacyRecordStillExists(uint256 challengeKey);
    error EcdsaFraudCutoverMigratedRecordMismatch(uint256 challengeKey);
    error EcdsaFraudCutoverKeysNotStrictlyIncreasing();
    error EcdsaFraudCutoverDelayNotElapsed();
    error EcdsaFraudCutoverActivationRequiresEmptyInventory();
    error EcdsaFraudCutoverReconcilerUpdateNotPending();
    error EcdsaFraudCutoverInvalidAction();
    error EcdsaFraudCutoverGovernanceStatePending();

    function processOwnerAction(
        Data storage self,
        address bridgeAddress,
        uint8 action,
        bytes calldata payload,
        uint256 governanceDelay,
        bool governanceStatePending
    ) external {
        if (action == 0) {
            if (governanceStatePending) {
                revert EcdsaFraudCutoverGovernanceStatePending();
            }
            OwnerAuthorizationParams memory params = abi.decode(
                payload,
                (OwnerAuthorizationParams)
            );
            _authorizeDrain(self, bridgeAddress, params, governanceDelay);
        } else if (action == 2) {
            _migrate(self, bridgeAddress, abi.decode(payload, (uint256[])));
        } else if (action == 3) {
            (
                address newReconciler,
                bytes32 newReconcilerSourceId,
                AuthorityContext memory newReconcilerContext,
                bytes memory enrollmentAttestation,
                bytes memory sourceRecoveryAttestation
            ) = abi.decode(
                    payload,
                    (address, bytes32, AuthorityContext, bytes, bytes)
                );
            _beginReconcilerUpdate(
                self,
                bridgeAddress,
                newReconciler,
                newReconcilerSourceId,
                newReconcilerContext,
                enrollmentAttestation,
                sourceRecoveryAttestation
            );
        } else if (action == 4) {
            _finalize(self, bridgeAddress, abi.decode(payload, (uint256[])));
        } else {
            revert EcdsaFraudCutoverInvalidAction();
        }
    }

    function processAuthorityAction(
        Data storage self,
        address bridgeAddress,
        uint8 action,
        bytes calldata payload,
        uint256 governanceDelay,
        bool governanceStatePending
    ) external {
        if (action == 0) {
            _confirmInventory(
                self,
                bridgeAddress,
                abi.decode(payload, (bytes32))
            );
        } else if (action == 1) {
            _confirmMigration(
                self,
                bridgeAddress,
                abi.decode(payload, (uint256[]))
            );
        } else if (action == 2) {
            if (payload.length != 0) {
                revert EcdsaFraudCutoverInvalidAction();
            }
            _finalizeReconcilerUpdate(self, bridgeAddress);
        } else if (action == 3) {
            if (governanceStatePending) {
                revert EcdsaFraudCutoverGovernanceStatePending();
            }
            _beginDrain(
                self,
                bridgeAddress,
                abi.decode(payload, (BeginDrainParams)),
                governanceDelay
            );
        } else if (action == 4) {
            (
                bytes memory snapshot,
                bytes memory sourceAttestation,
                bytes memory reconcilerAttestation
            ) = abi.decode(payload, (bytes, bytes, bytes));
            _stageInventory(
                self,
                bridgeAddress,
                snapshot,
                sourceAttestation,
                reconcilerAttestation
            );
        } else {
            revert EcdsaFraudCutoverInvalidAction();
        }
    }

    function _authorizeDrain(
        Data storage self,
        address bridgeAddress,
        OwnerAuthorizationParams memory params,
        uint256 governanceDelay
    ) private {
        _requirePhase(self, Phase.Idle);
        IBridgeEcdsaFraudCutover bridge = IBridgeEcdsaFraudCutover(
            bridgeAddress
        );
        _requireBridgeGovernance(bridge);
        if (
            params.oldRouter == address(0) ||
            params.newRouter == address(0) ||
            params.oldRouter == params.newRouter ||
            bridge.ecdsaFraudRouter() != params.oldRouter ||
            params.scanStartBlock > block.number
        ) {
            revert EcdsaFraudCutoverInvalidSourceAuthority();
        }
        bytes32 approvedOldCodeHash = bridge.ecdsaFraudRouterCodeHash();
        if (
            approvedOldCodeHash != bytes32(0) &&
            approvedOldCodeHash != params.oldRouterCodeHash
        ) {
            revert EcdsaFraudCutoverCodeHashMismatch(params.oldRouter);
        }
        _requireCodeHash(params.oldRouter, params.oldRouterCodeHash);
        _requireCurrentRouter(
            params.newRouter,
            bridgeAddress,
            params.newRouterCodeHash,
            true,
            params.oldRouter
        );
        bytes32 authorizationHash = EcdsaFraudRouterCutoverVerifier
            .ownerAuthorizationHash(bridgeAddress, params, governanceDelay);
        self.ownerAuthorizationHash = authorizationHash;
        emit EcdsaFraudCutoverOwnerAuthorized(authorizationHash);
    }

    function _beginDrain(
        Data storage self,
        address bridgeAddress,
        BeginDrainParams memory params,
        uint256 governanceDelay
    ) private {
        _requirePhase(self, Phase.Idle);
        IBridgeEcdsaFraudCutover bridge = IBridgeEcdsaFraudCutover(
            bridgeAddress
        );
        _requireBridgeGovernance(bridge);
        if (
            params.oldRouter == address(0) ||
            params.newRouter == address(0) ||
            params.oldRouter == params.newRouter ||
            bridge.ecdsaFraudRouter() != params.oldRouter ||
            params.scanStartBlock > block.number
        ) {
            revert EcdsaFraudCutoverRouterMismatch();
        }

        bytes32 approvedOldCodeHash = bridge.ecdsaFraudRouterCodeHash();
        if (
            approvedOldCodeHash != bytes32(0) &&
            approvedOldCodeHash != params.oldRouterCodeHash
        ) {
            revert EcdsaFraudCutoverCodeHashMismatch(params.oldRouter);
        }
        _requireCodeHash(params.oldRouter, params.oldRouterCodeHash);
        _requireCurrentRouter(
            params.newRouter,
            bridgeAddress,
            params.newRouterCodeHash,
            true,
            params.oldRouter
        );
        AuthorityProof memory authorityProof = abi.decode(
            params.authorityProof,
            (AuthorityProof)
        );
        EcdsaFraudRouterCutoverVerifier.requireAuthorityProof(
            self.ownerAuthorizationHash,
            authorityProof,
            bridgeAddress,
            params.oldRouter,
            params.oldRouterCodeHash,
            params.newRouter,
            params.newRouterCodeHash,
            params.scanStartBlock,
            governanceDelay
        );

        bridge.processEcdsaFraudRouterCutover(
            0,
            abi.encode(params.oldRouterCodeHash, params.newRouter)
        );

        self.phase = Phase.Draining;
        self.oldRouter = params.oldRouter;
        self.newRouter = params.newRouter;
        self.oldRouterCodeHash = params.oldRouterCodeHash;
        self.newRouterCodeHash = params.newRouterCodeHash;
        self.drainBlock = uint64(block.number);
        self.scanStartBlock = params.scanStartBlock;
        self.manifestPlanHash = authorityProof.manifestPlanHash;
        self.evidenceGeneration = authorityProof.evidenceGeneration;
        self.evidenceAnchorArtifactHash = authorityProof
            .evidenceAnchorArtifactHash;
        self.evidencePredecessorArtifactHash = authorityProof
            .evidencePredecessorArtifactHash;
        self.emitterSetCommitment = authorityProof.emitterSetCommitment;
        self.sourcePreflightCommitment = authorityProof
            .sourcePreflightCommitment;
        self.sourceCheckpointCommitment = authorityProof
            .sourceCheckpointCommitment;
        self.sourcePreflightFinalizedBlock = authorityProof
            .sourcePreflightFinalizedBlock;
        self.sourcePreflightFinalizedBlockHash = authorityProof
            .sourcePreflightFinalizedBlockHash;
        self.maxTailBlocks = authorityProof.maxTailBlocks;
        self.stageDeadlineBlock = uint64(block.number + MAX_BLOCKHASH_AGE);
        self.manifestSourceAttestationHash = keccak256(
            authorityProof.sourceManifestSignature
        );
        self.manifestReconcilerAttestationHash = keccak256(
            authorityProof.reconcilerManifestSignature
        );
        self.sourceSigner = authorityProof.sourceSigner;
        self.sourceId = authorityProof.sourceId;
        self.sourceContext = authorityProof.sourceContext;
        self.reconciler = authorityProof.reconciler;
        self.reconcilerSourceId = authorityProof.reconcilerSourceId;
        self.reconcilerContext = authorityProof.reconcilerContext;
        self.governanceDelay = governanceDelay;

        _emitDrainStarted(self);
        _emitAuthorizationBound(self);
    }

    function _stageInventory(
        Data storage self,
        address bridgeAddress,
        bytes memory encodedInventorySnapshot,
        bytes memory sourceAttestation,
        bytes memory reconcilerAttestation
    ) private {
        if (
            self.phase != Phase.Draining &&
            self.phase != Phase.InventoryStaged &&
            self.phase != Phase.InventoryConfirmed
        ) {
            revert EcdsaFraudCutoverWrongPhase(Phase.Draining, self.phase);
        }
        IBridgeEcdsaFraudCutover bridge = IBridgeEcdsaFraudCutover(
            bridgeAddress
        );
        _requireBridgeGovernance(bridge);
        _requireFrozenBridgeState(self, bridge);
        InventorySnapshot memory snapshot = abi.decode(
            encodedInventorySnapshot,
            (InventorySnapshot)
        );
        if (
            keccak256(encodedInventorySnapshot) !=
            keccak256(abi.encode(snapshot))
        ) {
            revert EcdsaFraudCutoverCommitmentMismatch();
        }
        if (
            self.scanStartBlock > snapshot.finalizedBlock ||
            snapshot.finalizedBlock != self.drainBlock
        ) {
            revert EcdsaFraudCutoverInvalidScanRange();
        }
        if (block.number > self.stageDeadlineBlock) {
            revert EcdsaFraudCutoverBlockHashUnavailable();
        }
        EcdsaFraudRouterCutoverVerifier.requireFinalizedBlock(
            snapshot.finalizedBlock,
            snapshot.finalizedBlockHash
        );
        if (snapshot.challengeCount != 0 || snapshot.totalEscrow != 0) {
            revert EcdsaFraudCutoverActivationRequiresEmptyInventory();
        }
        (
            bytes32 sourceAttestationHash,
            bytes32 reconcilerAttestationHash,
            bytes32 commitment
        ) = EcdsaFraudRouterCutoverVerifier.verifyInventory(
                self,
                bridgeAddress,
                snapshot,
                sourceAttestation,
                reconcilerAttestation
            );

        self.phase = Phase.InventoryStaged;
        self.finalizedBlock = snapshot.finalizedBlock;
        self.finalizedBlockHash = snapshot.finalizedBlockHash;
        self.challengeSetHash = snapshot.challengeSetHash;
        self.challengeCount = snapshot.challengeCount;
        self.totalEscrow = snapshot.totalEscrow;
        self.history = snapshot.history;
        self.sourceAttestationHash = sourceAttestationHash;
        self.reconcilerAttestationHash = reconcilerAttestationHash;
        self.inventoryCommitment = commitment;

        _emitInventoryStaged(self, commitment);
    }

    function _confirmInventory(
        Data storage self,
        address bridgeAddress,
        bytes32 expectedInventoryCommitment
    ) private {
        _requirePhase(self, Phase.InventoryStaged);
        if (msg.sender != self.reconciler) {
            revert EcdsaFraudCutoverUnauthorizedReconciler();
        }
        if (expectedInventoryCommitment != self.inventoryCommitment) {
            revert EcdsaFraudCutoverCommitmentMismatch();
        }
        IBridgeEcdsaFraudCutover bridge = IBridgeEcdsaFraudCutover(
            bridgeAddress
        );
        _requireBridgeGovernance(bridge);
        _requireFrozenBridgeState(self, bridge);

        self.phase = Phase.InventoryConfirmed;
        emit EcdsaFraudInventoryConfirmed(self.inventoryCommitment, msg.sender);
    }

    function _migrate(
        Data storage self,
        address bridgeAddress,
        uint256[] memory challengeKeys
    ) private {
        _requirePhase(self, Phase.InventoryConfirmed);
        IBridgeEcdsaFraudCutover bridge = IBridgeEcdsaFraudCutover(
            bridgeAddress
        );
        _requireBridgeGovernance(bridge);
        _requireFrozenBridgeState(self, bridge);
        _requireCodeHash(self.oldRouter, self.oldRouterCodeHash);
        _requireCurrentRouter(
            self.newRouter,
            bridgeAddress,
            self.newRouterCodeHash,
            true,
            self.oldRouter
        );
        EcdsaFraudRouterProtocol.requireEmptyAncestry(self.newRouter);
        if (challengeKeys.length != self.challengeCount) {
            revert EcdsaFraudCutoverChallengeCountMismatch();
        }
        if (challengeKeys.length != 0 || self.totalEscrow != 0) {
            revert EcdsaFraudCutoverActivationRequiresEmptyInventory();
        }

        bridge.processEcdsaFraudRouterCutover(
            1,
            abi.encode(
                self.oldRouter,
                self.newRouter,
                self.newRouterCodeHash,
                self.challengeSetHash,
                self.totalEscrow,
                challengeKeys
            )
        );

        self.phase = Phase.Migrated;
        self.migratedBlock = uint64(block.number);
        emit EcdsaFraudMigrationExecuted(
            self.inventoryCommitment,
            self.challengeSetHash,
            self.challengeCount,
            self.totalEscrow,
            self.migratedBlock
        );
    }

    function _confirmMigration(
        Data storage self,
        address bridgeAddress,
        uint256[] memory challengeKeys
    ) private {
        _requirePhase(self, Phase.Migrated);
        if (msg.sender != self.reconciler) {
            revert EcdsaFraudCutoverUnauthorizedReconciler();
        }
        IBridgeEcdsaFraudCutover bridge = IBridgeEcdsaFraudCutover(
            bridgeAddress
        );
        _requireBridgeGovernance(bridge);
        _requireFrozenBridgeState(self, bridge);

        bytes32 postMigrationCommitment = EcdsaFraudRouterCutoverVerifier
            .verifyPostMigration(self, bridge, bridgeAddress, challengeKeys);
        self.phase = Phase.MigrationConfirmed;
        self.postMigrationCommitment = postMigrationCommitment;
        /* solhint-disable-next-line not-rely-on-time */
        self.migrationConfirmedAt = uint64(block.timestamp);

        emit EcdsaFraudMigrationConfirmed(
            self.inventoryCommitment,
            postMigrationCommitment,
            msg.sender,
            self.migrationConfirmedAt
        );
    }

    /// @notice Starts a delayed recovery of a lost phase-four reconciler key.
    /// @dev Recovery is intentionally restricted to the post-migration phase:
    ///      earlier inventory commitments can be restaged, while phase five
    ///      already contains the independent confirmation being protected.
    function _beginReconcilerUpdate(
        Data storage self,
        address bridgeAddress,
        address newReconciler,
        bytes32 newReconcilerSourceId,
        AuthorityContext memory newReconcilerContext,
        bytes memory enrollmentAttestation,
        bytes memory sourceRecoveryAttestation
    ) private {
        _requirePhase(self, Phase.Migrated);
        IBridgeEcdsaFraudCutover bridge = IBridgeEcdsaFraudCutover(
            bridgeAddress
        );
        _requireBridgeGovernance(bridge);
        _requireFrozenBridgeState(self, bridge);
        (
            bytes32 enrollmentAttestationHash,
            bytes32 sourceRecoveryAttestationHash
        ) = EcdsaFraudRouterCutoverVerifier.validateReconcilerUpdate(
                self,
                bridgeAddress,
                newReconciler,
                newReconcilerSourceId,
                newReconcilerContext,
                enrollmentAttestation,
                sourceRecoveryAttestation
            );

        self.pendingReconciler = newReconciler;
        self.pendingReconcilerSourceId = newReconcilerSourceId;
        self.pendingReconcilerContext = newReconcilerContext;
        self.pendingReconcilerAttestationHash = enrollmentAttestationHash;
        self
            .pendingSourceRecoveryAttestationHash = sourceRecoveryAttestationHash;
        /* solhint-disable-next-line not-rely-on-time */
        self.reconcilerUpdateStartedAt = uint64(block.timestamp);
        emit EcdsaFraudReconcilerUpdateStarted(
            self.reconciler,
            newReconciler,
            newReconcilerSourceId,
            enrollmentAttestationHash,
            self.pendingSourceRecoveryAttestationHash,
            self.reconcilerUpdateStartedAt
        );
    }

    /// @notice Completes a phase-four reconciler recovery after the cutover's
    ///         immutable governance delay.
    function _finalizeReconcilerUpdate(Data storage self, address bridgeAddress)
        private
    {
        _requirePhase(self, Phase.Migrated);
        IBridgeEcdsaFraudCutover bridge = IBridgeEcdsaFraudCutover(
            bridgeAddress
        );
        _requireBridgeGovernance(bridge);
        _requireFrozenBridgeState(self, bridge);
        address pendingReconciler = self.pendingReconciler;
        if (
            pendingReconciler == address(0) ||
            self.reconcilerUpdateStartedAt == 0
        ) {
            revert EcdsaFraudCutoverReconcilerUpdateNotPending();
        }
        if (msg.sender != pendingReconciler) {
            revert EcdsaFraudCutoverUnauthorizedReconciler();
        }
        /* solhint-disable not-rely-on-time */
        if (
            block.timestamp <
            uint256(self.reconcilerUpdateStartedAt) + self.governanceDelay
        ) {
            revert EcdsaFraudCutoverDelayNotElapsed();
        }
        /* solhint-enable not-rely-on-time */

        address previousReconciler = self.reconciler;
        self.reconciler = pendingReconciler;
        self.reconcilerSourceId = self.pendingReconcilerSourceId;
        self.reconcilerContext = self.pendingReconcilerContext;
        self.manifestReconcilerAttestationHash = self
            .pendingReconcilerAttestationHash;
        delete self.pendingReconciler;
        delete self.pendingReconcilerSourceId;
        delete self.pendingReconcilerContext;
        delete self.pendingReconcilerAttestationHash;
        delete self.pendingSourceRecoveryAttestationHash;
        delete self.reconcilerUpdateStartedAt;
        emit EcdsaFraudReconcilerUpdated(
            previousReconciler,
            pendingReconciler,
            self.reconcilerSourceId
        );
    }

    function _finalize(
        Data storage self,
        address bridgeAddress,
        uint256[] memory challengeKeys
    ) private {
        _requirePhase(self, Phase.MigrationConfirmed);
        if (
            self.challengeCount != 0 ||
            self.totalEscrow != 0 ||
            challengeKeys.length != 0
        ) {
            revert EcdsaFraudCutoverActivationRequiresEmptyInventory();
        }
        /* solhint-disable not-rely-on-time */
        if (
            block.timestamp <
            uint256(self.migrationConfirmedAt) + self.governanceDelay
        ) {
            revert EcdsaFraudCutoverDelayNotElapsed();
        }
        /* solhint-enable not-rely-on-time */
        IBridgeEcdsaFraudCutover bridge = IBridgeEcdsaFraudCutover(
            bridgeAddress
        );
        _requireBridgeGovernance(bridge);
        _requireFrozenBridgeState(self, bridge);
        EcdsaFraudRouterCutoverVerifier.requireCommittedHistoryLive(self);
        bytes32 observedPostMigrationCommitment = EcdsaFraudRouterCutoverVerifier
                .verifyPostMigration(
                    self,
                    bridge,
                    bridgeAddress,
                    challengeKeys
                );
        if (observedPostMigrationCommitment != self.postMigrationCommitment) {
            revert EcdsaFraudCutoverCommitmentMismatch();
        }
        EcdsaFraudRouterProtocol.requireEmptyAncestry(self.newRouter);

        address oldRouter = self.oldRouter;
        address newRouter = self.newRouter;
        bytes32 inventoryCommitment = self.inventoryCommitment;
        bytes32 postMigrationCommitment = self.postMigrationCommitment;
        _finalizeBridge(self, bridge);

        delete self.phase;
        delete self.oldRouter;
        delete self.newRouter;
        delete self.oldRouterCodeHash;
        delete self.newRouterCodeHash;
        delete self.drainBlock;
        delete self.scanStartBlock;
        delete self.finalizedBlock;
        delete self.finalizedBlockHash;
        delete self.challengeSetHash;
        delete self.challengeCount;
        delete self.totalEscrow;
        delete self.history;
        delete self.manifestPlanHash;
        delete self.evidenceGeneration;
        delete self.evidenceAnchorArtifactHash;
        delete self.evidencePredecessorArtifactHash;
        delete self.emitterSetCommitment;
        delete self.sourcePreflightCommitment;
        delete self.sourceCheckpointCommitment;
        delete self.sourcePreflightFinalizedBlock;
        delete self.sourcePreflightFinalizedBlockHash;
        delete self.maxTailBlocks;
        delete self.stageDeadlineBlock;
        delete self.ownerAuthorizationHash;
        delete self.manifestSourceAttestationHash;
        delete self.manifestReconcilerAttestationHash;
        delete self.sourceAttestationHash;
        delete self.reconcilerAttestationHash;
        delete self.sourceSigner;
        delete self.sourceId;
        delete self.sourceContext;
        delete self.reconciler;
        delete self.reconcilerSourceId;
        delete self.reconcilerContext;
        delete self.inventoryCommitment;
        delete self.postMigrationCommitment;
        delete self.migratedBlock;
        delete self.migrationConfirmedAt;
        delete self.governanceDelay;
        delete self.pendingReconciler;
        delete self.pendingReconcilerSourceId;
        delete self.pendingReconcilerContext;
        delete self.pendingReconcilerAttestationHash;
        delete self.pendingSourceRecoveryAttestationHash;
        delete self.reconcilerUpdateStartedAt;

        emit EcdsaFraudCutoverFinalized(
            oldRouter,
            newRouter,
            inventoryCommitment,
            postMigrationCommitment
        );
    }

    function _requirePhase(Data storage self, Phase expected) private view {
        if (self.phase != expected) {
            revert EcdsaFraudCutoverWrongPhase(expected, self.phase);
        }
    }

    function _emitDrainStarted(Data storage self) private {
        emit EcdsaFraudCutoverDrainStarted(
            self.oldRouter,
            self.newRouter,
            self.oldRouterCodeHash,
            self.newRouterCodeHash,
            self.drainBlock,
            self.scanStartBlock,
            self.sourceSigner,
            self.sourceId,
            self.reconciler,
            self.reconcilerSourceId,
            self.emitterSetCommitment,
            self.sourcePreflightCommitment,
            self.sourcePreflightFinalizedBlock,
            self.governanceDelay
        );
    }

    function _emitInventoryStaged(Data storage self, bytes32 commitment)
        private
    {
        emit EcdsaFraudInventoryStaged(
            commitment,
            self.scanStartBlock,
            self.finalizedBlock,
            self.finalizedBlockHash,
            self.challengeSetHash,
            self.challengeCount,
            self.totalEscrow,
            keccak256(abi.encode(self.history)),
            self.sourceAttestationHash,
            self.reconcilerAttestationHash,
            self.sourceSigner,
            self.sourceId,
            self.reconciler,
            self.reconcilerSourceId
        );
    }

    function _emitAuthorizationBound(Data storage self) private {
        emit EcdsaFraudCutoverAuthorizationBound(
            self.manifestPlanHash,
            self.sourceCheckpointCommitment,
            self.maxTailBlocks,
            self.stageDeadlineBlock
        );
    }

    function _finalizeBridge(Data storage self, IBridgeEcdsaFraudCutover bridge)
        private
    {
        bridge.processEcdsaFraudRouterCutover(
            2,
            abi.encode(
                self.oldRouter,
                self.newRouter,
                self.newRouterCodeHash,
                self.challengeCount
            )
        );
    }

    function _requireBridgeGovernance(IBridgeEcdsaFraudCutover bridge)
        private
        view
    {
        if (bridge.governance() != address(this)) {
            revert EcdsaFraudCutoverNotBridgeGovernance();
        }
    }

    function _requireFrozenBridgeState(
        Data storage self,
        IBridgeEcdsaFraudCutover bridge
    ) private view {
        if (bridge.ecdsaFraudRouter() != self.oldRouter) {
            revert EcdsaFraudCutoverRouterMismatch();
        }
        if (bridge.ecdsaFraudRouterCodeHash() != self.oldRouterCodeHash) {
            revert EcdsaFraudCutoverRouterMismatch();
        }
    }

    function _requireCodeHash(address router, bytes32 expectedCodeHash)
        private
        view
    {
        if (
            expectedCodeHash == bytes32(0) ||
            router.codehash != expectedCodeHash
        ) {
            revert EcdsaFraudCutoverCodeHashMismatch(router);
        }
    }

    function _requireCurrentRouter(
        address router,
        address bridgeAddress,
        bytes32 expectedCodeHash,
        bool requireEmpty,
        address expectedPredecessor
    ) private view {
        EcdsaFraudRouterProtocol.requireCurrentRouter(
            router,
            bridgeAddress,
            expectedCodeHash,
            expectedPredecessor
        );
        IEcdsaFraudRouterCutoverReadback candidate = IEcdsaFraudRouterCutoverReadback(
                router
            );
        if (
            requireEmpty &&
            (candidate.openFraudChallengeCount() != 0 ||
                candidate.unattributedOpenFraudChallengeCount() != 0 ||
                candidate.openFraudChallengeEscrow() != 0 ||
                candidate.migratedChallengesActivatedAt() != 0)
        ) {
            revert EcdsaFraudCutoverRouterNotEmpty(router);
        }
    }

    function readiness(Data storage self)
        external
        view
        returns (Readiness memory result)
    {
        return EcdsaFraudRouterCutoverVerifier.readiness(self);
    }
}
