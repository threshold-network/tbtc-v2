// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "./EcdsaFraudRouterCutover.sol";
import "./EcdsaFraudRouterProtocol.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title ECDSA fraud router cutover verifier
/// @notice Linked verification sidecar for the cutover coordinator.
/// @dev Calls are delegatecalls, preserving the BridgeGovernance execution
///      context and the coordinator's storage pointer.
library EcdsaFraudRouterCutoverVerifier {
    using ECDSA for bytes32;

    uint256 internal constant FINALITY_CONFIRMATIONS = 64;
    uint256 internal constant MAX_AUTHENTICATED_TAIL_BLOCKS = 255;
    uint256 internal constant MAX_BLOCKHASH_AGE = 255;
    bytes32 internal constant INVENTORY_DOMAIN =
        keccak256("tbtc/ecdsa-fraud-router-cutover/inventory/v1");
    bytes32 internal constant POST_MIGRATION_DOMAIN =
        keccak256("tbtc/ecdsa-fraud-router-cutover/post-migration/v1");
    bytes32 internal constant SOURCE_ATTESTATION_DOMAIN =
        keccak256("tbtc/ecdsa-fraud-cutover/inventory-source-attestation/v1");
    bytes32 internal constant BEGIN_AUTHORITY_DOMAIN =
        keccak256("tbtc/ecdsa-fraud-cutover/begin-authority/v2");
    bytes32 internal constant OWNER_AUTHORIZATION_DOMAIN =
        keccak256("tbtc/ecdsa-fraud-cutover/owner-authorization/v1");
    bytes32 internal constant RECONCILER_ENROLLMENT_DOMAIN =
        keccak256("tbtc/ecdsa-fraud-cutover/reconciler-enrollment/v1");
    bytes32 internal constant RECONCILER_RECOVERY_DOMAIN =
        keccak256("tbtc/ecdsa-fraud-cutover/reconciler-recovery/v1");
    bytes32 internal constant SOURCE_CONTEXT_DOMAIN =
        keccak256("tbtc/ecdsa-fraud-cutover/source-context/v1");
    bytes32 internal constant RECONCILER_CONTEXT_DOMAIN =
        keccak256("tbtc/ecdsa-fraud-cutover/reconciler-context/v1");
    bytes32 internal constant SOURCE_CHECKPOINT_DOMAIN =
        keccak256("tbtc/ecdsa-fraud-cutover/source-checkpoint/v1");
    bytes32 internal constant RECONCILER_CHECKPOINT_DOMAIN =
        keccak256("tbtc/ecdsa-fraud-cutover/reconciler-checkpoint/v1");
    bytes32 internal constant SOURCE_STAGE_DOMAIN =
        keccak256("tbtc/ecdsa-fraud-cutover/source-stage/v1");
    bytes32 internal constant RECONCILER_STAGE_DOMAIN =
        keccak256("tbtc/ecdsa-fraud-cutover/reconciler-stage/v1");

    function ownerAuthorizationHash(
        address bridgeAddress,
        EcdsaFraudRouterCutover.OwnerAuthorizationParams memory params,
        uint256 governanceDelay
    ) external view returns (bytes32) {
        if (
            params.sourceSigner == address(0) ||
            params.reconciler == address(0) ||
            params.sourceSigner == params.reconciler ||
            params.sourceSigner == address(this) ||
            params.reconciler == address(this) ||
            params.sourceSigner == msg.sender ||
            params.reconciler == msg.sender ||
            params.sourceId == bytes32(0) ||
            params.reconcilerSourceId == bytes32(0) ||
            params.sourceId == params.reconcilerSourceId ||
            !_validDistinctContext(
                params.sourceContext,
                params.reconcilerContext
            ) ||
            params.emitterSetCommitment == bytes32(0)
        ) {
            revert EcdsaFraudRouterCutover
                .EcdsaFraudCutoverInvalidSourceAuthority();
        }
        return _ownerAuthorizationHash(bridgeAddress, params, governanceDelay);
    }

    function requireAuthorityProof(
        bytes32 ownerAuthorizationHash_,
        EcdsaFraudRouterCutover.AuthorityProof memory proof,
        address bridgeAddress,
        address oldRouter,
        bytes32 oldRouterCodeHash,
        address newRouter,
        bytes32 newRouterCodeHash,
        uint64 scanStartBlock,
        uint256 governanceDelay
    ) external view {
        uint256 preflightBlock = proof.sourcePreflightFinalizedBlock;
        uint256 beginBlock = block.number;
        if (
            proof.sourceSigner == address(0) ||
            proof.reconciler == address(0) ||
            proof.sourceSigner == proof.reconciler ||
            proof.sourceSigner == address(this) ||
            proof.reconciler == address(this) ||
            proof.sourceId == bytes32(0) ||
            proof.reconcilerSourceId == bytes32(0) ||
            proof.sourceId == proof.reconcilerSourceId ||
            !_validDistinctContext(
                proof.sourceContext,
                proof.reconcilerContext
            ) ||
            proof.manifestPlanHash == bytes32(0) ||
            proof.evidenceGeneration == 0 ||
            proof.evidenceAnchorArtifactHash == bytes32(0) ||
            proof.evidencePredecessorArtifactHash == bytes32(0) ||
            (proof.evidenceGeneration == 1 &&
                proof.evidenceAnchorArtifactHash !=
                proof.evidencePredecessorArtifactHash) ||
            proof.emitterSetCommitment == bytes32(0) ||
            proof.sourcePreflightCommitment == bytes32(0) ||
            proof.sourceCheckpointCommitment == bytes32(0) ||
            preflightBlock < scanStartBlock ||
            preflightBlock >= beginBlock ||
            proof.sourcePreflightFinalizedBlockHash == bytes32(0) ||
            proof.maxTailBlocks < FINALITY_CONFIRMATIONS ||
            proof.maxTailBlocks > MAX_AUTHENTICATED_TAIL_BLOCKS
        ) {
            revert EcdsaFraudRouterCutover
                .EcdsaFraudCutoverInvalidSourceAuthority();
        }
        uint256 preflightAge = beginBlock - preflightBlock;
        if (
            preflightAge < FINALITY_CONFIRMATIONS ||
            preflightAge > proof.maxTailBlocks
        ) {
            revert EcdsaFraudRouterCutover
                .EcdsaFraudCutoverInvalidSourceAuthority();
        }
        _requireCanonicalBlock(
            proof.sourcePreflightFinalizedBlock,
            proof.sourcePreflightFinalizedBlockHash
        );

        EcdsaFraudRouterCutover.OwnerAuthorizationParams
            memory authorization = EcdsaFraudRouterCutover
                .OwnerAuthorizationParams({
                    oldRouter: oldRouter,
                    oldRouterCodeHash: oldRouterCodeHash,
                    newRouter: newRouter,
                    newRouterCodeHash: newRouterCodeHash,
                    scanStartBlock: scanStartBlock,
                    sourceSigner: proof.sourceSigner,
                    sourceId: proof.sourceId,
                    sourceContext: proof.sourceContext,
                    reconciler: proof.reconciler,
                    reconcilerSourceId: proof.reconcilerSourceId,
                    reconcilerContext: proof.reconcilerContext,
                    emitterSetCommitment: proof.emitterSetCommitment
                });
        if (
            ownerAuthorizationHash_ == bytes32(0) ||
            ownerAuthorizationHash_ !=
            _ownerAuthorizationHash(
                bridgeAddress,
                authorization,
                governanceDelay
            )
        ) {
            revert EcdsaFraudRouterCutover
                .EcdsaFraudCutoverInvalidSourceAuthority();
        }

        bytes32 expectedPlanHash = keccak256(
            abi.encode(
                BEGIN_AUTHORITY_DOMAIN,
                ownerAuthorizationHash_,
                _preflightCommitment(proof)
            )
        );
        if (proof.manifestPlanHash != expectedPlanHash) {
            revert EcdsaFraudRouterCutover
                .EcdsaFraudCutoverInvalidSourceAuthority();
        }
        if (
            !_isValidSignature(
                proof.sourceSigner,
                proof.manifestPlanHash,
                proof.sourceManifestSignature
            ) ||
            !_isValidSignature(
                proof.reconciler,
                proof.manifestPlanHash,
                proof.reconcilerManifestSignature
            )
        ) {
            revert EcdsaFraudRouterCutover
                .EcdsaFraudCutoverInvalidSourceAttestation();
        }
    }

    function requireFinalizedBlock(
        uint64 finalizedBlock,
        bytes32 expectedBlockHash
    ) external view {
        if (block.number < uint256(finalizedBlock) + FINALITY_CONFIRMATIONS) {
            revert EcdsaFraudRouterCutover
                .EcdsaFraudCutoverBlockNotFinalized();
        }
        if (block.number > uint256(finalizedBlock) + MAX_BLOCKHASH_AGE) {
            revert EcdsaFraudRouterCutover
                .EcdsaFraudCutoverBlockHashUnavailable();
        }
        _requireCanonicalBlock(finalizedBlock, expectedBlockHash);
    }

    function verifyInventory(
        EcdsaFraudRouterCutover.Data storage self,
        address bridgeAddress,
        EcdsaFraudRouterCutover.InventorySnapshot memory snapshot,
        bytes memory sourceAttestation,
        bytes memory reconcilerAttestation
    ) external view returns (bytes32, bytes32, bytes32) {
        _requireHistoryEvidence(
            self,
            bridgeAddress,
            snapshot.finalizedBlock,
            snapshot.challengeCount,
            snapshot.totalEscrow,
            snapshot.history
        );
        bytes32 historyEvidenceHash = keccak256(
            abi.encode(snapshot.history)
        );
        bytes32 sourceDigest = _authorityAttestationDigest(
            self,
            bridgeAddress,
            snapshot,
            historyEvidenceHash,
            true
        );
        bytes32 reconcilerDigest = _authorityAttestationDigest(
            self,
            bridgeAddress,
            snapshot,
            historyEvidenceHash,
            false
        );
        if (
            !_isValidSignature(
                self.sourceSigner,
                sourceDigest,
                sourceAttestation
            ) ||
            !_isValidSignature(
                self.reconciler,
                reconcilerDigest,
                reconcilerAttestation
            )
        ) {
            revert EcdsaFraudRouterCutover
                .EcdsaFraudCutoverInvalidSourceAttestation();
        }

        bytes32 sourceAttestationHash = keccak256(sourceAttestation);
        bytes32 reconcilerAttestationHash = keccak256(
            reconcilerAttestation
        );
        return (
            sourceAttestationHash,
            reconcilerAttestationHash,
            _inventoryCommitment(
                self,
                bridgeAddress,
                snapshot,
                sourceAttestationHash,
                reconcilerAttestationHash
            )
        );
    }

    function validateReconcilerUpdate(
        EcdsaFraudRouterCutover.Data storage self,
        address bridgeAddress,
        address newReconciler,
        bytes32 newReconcilerSourceId,
        EcdsaFraudRouterCutover.AuthorityContext memory newReconcilerContext,
        bytes memory enrollmentAttestation,
        bytes memory sourceRecoveryAttestation
    ) external view returns (bytes32, bytes32) {
        if (
            newReconciler == address(0) ||
            newReconciler == address(this) ||
            newReconciler == msg.sender ||
            newReconciler == self.reconciler ||
            newReconciler == self.sourceSigner ||
            newReconcilerSourceId == bytes32(0) ||
            newReconcilerSourceId == self.sourceId ||
            newReconcilerSourceId == self.reconcilerSourceId ||
            !_validDistinctContext(
                newReconcilerContext,
                self.sourceContext
            )
        ) {
            revert EcdsaFraudRouterCutover
                .EcdsaFraudCutoverInvalidReconciler();
        }

        bytes32 enrollmentDigest = _reconcilerEnrollmentDigest(
            self,
            bridgeAddress,
            newReconciler,
            newReconcilerSourceId,
            newReconcilerContext
        );
        if (
            !_isValidSignature(
                newReconciler,
                enrollmentDigest,
                enrollmentAttestation
            )
        ) {
            revert EcdsaFraudRouterCutover
                .EcdsaFraudCutoverInvalidReconciler();
        }

        bytes32 enrollmentAttestationHash = keccak256(
            enrollmentAttestation
        );
        if (
            !_isValidSignature(
                self.sourceSigner,
                _reconcilerRecoveryDigest(
                    self,
                    bridgeAddress,
                    enrollmentDigest,
                    enrollmentAttestationHash
                ),
                sourceRecoveryAttestation
            )
        ) {
            revert EcdsaFraudRouterCutover
                .EcdsaFraudCutoverInvalidReconciler();
        }

        return (
            enrollmentAttestationHash,
            keccak256(sourceRecoveryAttestation)
        );
    }

    function requireCommittedHistoryLive(
        EcdsaFraudRouterCutover.Data storage self
    ) external view {
        if (
            self.history.historyCommitment == bytes32(0) ||
            self.history.emitterSetCommitment == bytes32(0) ||
            self.history.emitterSetCommitment != self.emitterSetCommitment ||
            self.history.blockCount !=
            self.finalizedBlock - self.scanStartBlock + 1 ||
            self.history.transactionCount != self.history.receiptCount ||
            self.history.emitterLogCount < self.history.lifecycleEventCount ||
            self.history.candidateCallCount != self.history.sourceEventCount ||
            self.history.lifecycleEventCount < self.history.sourceEventCount ||
            self.history.sourceEventCount < self.challengeCount ||
            self.sourceAttestationHash == bytes32(0) ||
            self.reconcilerAttestationHash == bytes32(0) ||
            self.manifestSourceAttestationHash == bytes32(0) ||
            self.manifestReconcilerAttestationHash == bytes32(0)
        ) {
            revert EcdsaFraudRouterCutover
                .EcdsaFraudCutoverCommitmentMismatch();
        }
    }

    function verifyPostMigration(
        EcdsaFraudRouterCutover.Data storage self,
        IBridgeEcdsaFraudCutover bridge,
        address bridgeAddress,
        uint256[] memory challengeKeys
    ) external view returns (bytes32) {
        _requireCodeHash(self.oldRouter, self.oldRouterCodeHash);
        _requireCurrentRouter(
            self.newRouter,
            bridgeAddress,
            self.newRouterCodeHash,
            false,
            self.oldRouter
        );
        if (challengeKeys.length != self.challengeCount) {
            revert EcdsaFraudRouterCutover
                .EcdsaFraudCutoverChallengeCountMismatch();
        }

        IEcdsaFraudRouterCutoverReadback newRouter = IEcdsaFraudRouterCutoverReadback(
                self.newRouter
            );
        EcdsaFraudRouterCutover.FraudChallenge[]
            memory challenges = new EcdsaFraudRouterCutover.FraudChallenge[](
                challengeKeys.length
            );
        for (uint256 i = 0; i < challengeKeys.length; i++) {
            uint256 challengeKey = challengeKeys[i];
            if (i > 0 && challengeKey <= challengeKeys[i - 1]) {
                revert EcdsaFraudRouterCutover
                    .EcdsaFraudCutoverKeysNotStrictlyIncreasing();
            }
            if (bridge.legacyFraudChallengeExists(challengeKey)) {
                revert EcdsaFraudRouterCutover
                    .EcdsaFraudCutoverLegacyRecordStillExists(challengeKey);
            }
            (
                address challenger,
                uint256 depositAmount,
                uint32 reportedAt,
                bool resolved
            ) = newRouter.fraudChallenges(challengeKey);
            if (reportedAt == 0 || resolved) {
                revert EcdsaFraudRouterCutover
                    .EcdsaFraudCutoverMigratedRecordMismatch(challengeKey);
            }
            challenges[i] = EcdsaFraudRouterCutover.FraudChallenge(
                challenger,
                depositAmount,
                reportedAt,
                resolved
            );
        }

        bytes32 observedChallengeSetHash = keccak256(
            abi.encode(challengeKeys, challenges)
        );
        if (observedChallengeSetHash != self.challengeSetHash) {
            revert EcdsaFraudRouterCutover
                .EcdsaFraudCutoverChallengeSetMismatch();
        }
        if (
            newRouter.openFraudChallengeCount() != self.challengeCount ||
            newRouter.unattributedOpenFraudChallengeCount() !=
            self.challengeCount
        ) {
            revert EcdsaFraudRouterCutover
                .EcdsaFraudCutoverChallengeCountMismatch();
        }
        uint256 observedEscrow = newRouter.openFraudChallengeEscrow();
        if (
            observedEscrow != self.totalEscrow ||
            self.newRouter.balance < observedEscrow
        ) {
            revert EcdsaFraudRouterCutover
                .EcdsaFraudCutoverEscrowMismatch();
        }

        return
            keccak256(
                abi.encode(
                    POST_MIGRATION_DOMAIN,
                    self.inventoryCommitment,
                    observedChallengeSetHash,
                    self.challengeCount,
                    observedEscrow
                )
            );
    }

    function readiness(EcdsaFraudRouterCutover.Data storage self)
        external
        view
        returns (EcdsaFraudRouterCutover.Readiness memory result)
    {
        result.phase = uint8(self.phase);
        result.oldRouter = self.oldRouter;
        result.newRouter = self.newRouter;
        result.inventoryCommitment = self.inventoryCommitment;
        result.postMigrationCommitment = self.postMigrationCommitment;
        result.sourceSigner = self.sourceSigner;
        result.sourceId = self.sourceId;
        result.reconciler = self.reconciler;
        result.reconcilerSourceId = self.reconcilerSourceId;
        result.pendingReconciler = self.pendingReconciler;
        result.pendingReconcilerSourceId = self.pendingReconcilerSourceId;
        result.finalizedBlock = self.finalizedBlock;
        result.finalizedBlockHash = self.finalizedBlockHash;
        result.migratedBlock = self.migratedBlock;
        result.migrationConfirmedAt = self.migrationConfirmedAt;
        result.sourceContext = self.sourceContext;
        result.reconcilerContext = self.reconcilerContext;
        result.pendingReconcilerContext = self.pendingReconcilerContext;
        result.sourceCheckpointCommitment = self.sourceCheckpointCommitment;
        result.sourcePreflightCommitment = self.sourcePreflightCommitment;
        result.sourcePreflightBlock = self.sourcePreflightFinalizedBlock;
        result.evidenceGeneration = self.evidenceGeneration;
        result.evidenceAnchorArtifactHash = self.evidenceAnchorArtifactHash;
        result.evidencePredecessorArtifactHash = self
            .evidencePredecessorArtifactHash;
        result.drainBlock = self.drainBlock;
        result.maxTailBlocks = self.maxTailBlocks;
        result.stageDeadlineBlock = self.stageDeadlineBlock;
        result.ownerAuthorizationHash = self.ownerAuthorizationHash;
        if (self.sourceSigner != address(0)) {
            result.sourceContextCommitment = _contextCommitment(
                SOURCE_CONTEXT_DOMAIN,
                self.sourceSigner,
                self.sourceId,
                self.sourceContext
            );
            result.reconcilerContextCommitment = _contextCommitment(
                RECONCILER_CONTEXT_DOMAIN,
                self.reconciler,
                self.reconcilerSourceId,
                self.reconcilerContext
            );
            result.sourceCheckpointRoleDigest = keccak256(
                abi.encode(
                    SOURCE_CHECKPOINT_DOMAIN,
                    self.sourceCheckpointCommitment,
                    result.sourceContextCommitment
                )
            );
            result.reconcilerCheckpointRoleDigest = keccak256(
                abi.encode(
                    RECONCILER_CHECKPOINT_DOMAIN,
                    self.sourceCheckpointCommitment,
                    result.reconcilerContextCommitment
                )
            );
        }
    }

    function _ownerAuthorizationHash(
        address bridgeAddress,
        EcdsaFraudRouterCutover.OwnerAuthorizationParams memory params,
        uint256 governanceDelay
    ) private view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    OWNER_AUTHORIZATION_DOMAIN,
                    block.chainid,
                    address(this),
                    bridgeAddress,
                    keccak256(
                        abi.encode(
                            params.oldRouter,
                            params.oldRouterCodeHash,
                            params.newRouter,
                            params.newRouterCodeHash
                        )
                    ),
                    params.scanStartBlock,
                    governanceDelay,
                    _authorityCommitment(
                        params.sourceSigner,
                        params.sourceId,
                        params.sourceContext,
                        params.reconciler,
                        params.reconcilerSourceId,
                        params.reconcilerContext
                    ),
                    params.emitterSetCommitment
                )
            );
    }

    function _preflightCommitment(
        EcdsaFraudRouterCutover.AuthorityProof memory proof
    ) private pure returns (bytes32) {
        bytes32 sourceContextCommitment = _contextCommitment(
            SOURCE_CONTEXT_DOMAIN,
            proof.sourceSigner,
            proof.sourceId,
            proof.sourceContext
        );
        bytes32 reconcilerContextCommitment = _contextCommitment(
            RECONCILER_CONTEXT_DOMAIN,
            proof.reconciler,
            proof.reconcilerSourceId,
            proof.reconcilerContext
        );
        return
            keccak256(
                abi.encode(
                    proof.emitterSetCommitment,
                    proof.sourcePreflightCommitment,
                    keccak256(
                        abi.encode(
                            SOURCE_CHECKPOINT_DOMAIN,
                            proof.sourceCheckpointCommitment,
                            sourceContextCommitment
                        )
                    ),
                    keccak256(
                        abi.encode(
                            RECONCILER_CHECKPOINT_DOMAIN,
                            proof.sourceCheckpointCommitment,
                            reconcilerContextCommitment
                        )
                    ),
                    proof.sourcePreflightFinalizedBlock,
                    proof.sourcePreflightFinalizedBlockHash,
                    proof.maxTailBlocks,
                    proof.evidenceGeneration,
                    proof.evidenceAnchorArtifactHash,
                    proof.evidencePredecessorArtifactHash
                )
            );
    }

    function _validDistinctContext(
        EcdsaFraudRouterCutover.AuthorityContext memory source,
        EcdsaFraudRouterCutover.AuthorityContext memory reconciler
    ) private pure returns (bool) {
        return
            source.durableStoreIdentity != bytes32(0) &&
            source.endpointIdentity != bytes32(0) &&
            source.trustDomain != bytes32(0) &&
            source.policyHash != bytes32(0) &&
            reconciler.durableStoreIdentity != bytes32(0) &&
            reconciler.endpointIdentity != bytes32(0) &&
            reconciler.trustDomain != bytes32(0) &&
            reconciler.policyHash != bytes32(0) &&
            source.durableStoreIdentity != reconciler.durableStoreIdentity &&
            source.endpointIdentity != reconciler.endpointIdentity &&
            source.trustDomain != reconciler.trustDomain &&
            source.policyHash != reconciler.policyHash;
    }

    function _contextCommitment(
        bytes32 roleDomain,
        address signer,
        bytes32 sourceId,
        EcdsaFraudRouterCutover.AuthorityContext memory context
    ) private pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    roleDomain,
                    signer,
                    sourceId,
                    context.durableStoreIdentity,
                    context.endpointIdentity,
                    context.trustDomain,
                    context.policyHash
                )
            );
    }

    function _authorityCommitment(
        address sourceSigner,
        bytes32 sourceId,
        EcdsaFraudRouterCutover.AuthorityContext memory sourceContext,
        address reconciler,
        bytes32 reconcilerSourceId,
        EcdsaFraudRouterCutover.AuthorityContext memory reconcilerContext
    ) private pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    sourceSigner,
                    sourceId,
                    _contextCommitment(
                        SOURCE_CONTEXT_DOMAIN,
                        sourceSigner,
                        sourceId,
                        sourceContext
                    ),
                    reconciler,
                    reconcilerSourceId,
                    _contextCommitment(
                        RECONCILER_CONTEXT_DOMAIN,
                        reconciler,
                        reconcilerSourceId,
                        reconcilerContext
                    )
                )
            );
    }

    function _isValidSignature(
        address signer,
        bytes32 digest,
        bytes memory signature
    ) private view returns (bool) {
        return
            SignatureChecker.isValidSignatureNow(
                signer,
                digest.toEthSignedMessageHash(),
                signature
            );
    }

    function _requireCanonicalBlock(
        uint64 blockNumber,
        bytes32 expectedBlockHash
    ) private view {
        bytes32 observedBlockHash = blockhash(blockNumber);
        if (observedBlockHash == bytes32(0)) {
            revert EcdsaFraudRouterCutover
                .EcdsaFraudCutoverBlockHashUnavailable();
        }
        if (observedBlockHash != expectedBlockHash) {
            revert EcdsaFraudRouterCutover
                .EcdsaFraudCutoverBlockHashMismatch();
        }
    }

    function _requireHistoryEvidence(
        EcdsaFraudRouterCutover.Data storage self,
        address bridgeAddress,
        uint64 finalizedBlock,
        uint32 challengeCount,
        uint256 totalEscrow,
        EcdsaFraudRouterCutover.HistoryEvidence memory history
    ) private view {
        if (
            history.historyCommitment == bytes32(0) ||
            history.emitterSetCommitment == bytes32(0) ||
            history.emitterSetCommitment != self.emitterSetCommitment ||
            history.blockCount != finalizedBlock - self.scanStartBlock + 1 ||
            history.transactionCount != history.receiptCount ||
            history.emitterLogCount < history.lifecycleEventCount ||
            history.candidateCallCount != history.sourceEventCount ||
            history.lifecycleEventCount < history.sourceEventCount ||
            history.sourceEventCount < challengeCount ||
            history.emitterLogDigest == bytes32(0) ||
            history.candidateCallDigest == bytes32(0) ||
            history.sourceEventDigest == bytes32(0) ||
            history.lifecycleEventDigest == bytes32(0) ||
            history.legacyLiabilityDigest == bytes32(0) ||
            history.bridgeBalance !=
            totalEscrow + history.unrelatedBridgeBalance ||
            bridgeAddress.balance != history.bridgeBalance
        ) {
            revert EcdsaFraudRouterCutover
                .EcdsaFraudCutoverCommitmentMismatch();
        }
    }

    function _authorityAttestationDigest(
        EcdsaFraudRouterCutover.Data storage self,
        address bridgeAddress,
        EcdsaFraudRouterCutover.InventorySnapshot memory snapshot,
        bytes32 historyEvidenceHash,
        bool sourceRole
    ) private view returns (bytes32) {
        bytes32 routingCommitment = keccak256(
            abi.encode(self.oldRouter, self.newRouter, self.scanStartBlock)
        );
        bytes32 roleContextCommitment = _contextCommitment(
            sourceRole ? SOURCE_CONTEXT_DOMAIN : RECONCILER_CONTEXT_DOMAIN,
            sourceRole ? self.sourceSigner : self.reconciler,
            sourceRole ? self.sourceId : self.reconcilerSourceId,
            sourceRole ? self.sourceContext : self.reconcilerContext
        );
        return
            keccak256(
                abi.encode(
                    SOURCE_ATTESTATION_DOMAIN,
                    sourceRole ? SOURCE_STAGE_DOMAIN : RECONCILER_STAGE_DOMAIN,
                    block.chainid,
                    bridgeAddress,
                    routingCommitment,
                    keccak256(abi.encode(snapshot)),
                    historyEvidenceHash,
                    roleContextCommitment,
                    self.manifestPlanHash
                )
            );
    }

    function _reconcilerEnrollmentDigest(
        EcdsaFraudRouterCutover.Data storage self,
        address bridgeAddress,
        address newReconciler,
        bytes32 newReconcilerSourceId,
        EcdsaFraudRouterCutover.AuthorityContext memory newReconcilerContext
    ) private view returns (bytes32) {
        bytes32 pendingContextCommitment = _contextCommitment(
            RECONCILER_CONTEXT_DOMAIN,
            newReconciler,
            newReconcilerSourceId,
            newReconcilerContext
        );
        bytes32 pendingCheckpointRoleDigest = keccak256(
            abi.encode(
                RECONCILER_CHECKPOINT_DOMAIN,
                self.sourceCheckpointCommitment,
                pendingContextCommitment
            )
        );
        bytes32 currentAuthorityCommitment = _storedAuthorityCommitment(self);
        return
            keccak256(
                abi.encode(
                    RECONCILER_ENROLLMENT_DOMAIN,
                    block.chainid,
                    address(this),
                    bridgeAddress,
                    self.inventoryCommitment,
                    self.manifestPlanHash,
                    currentAuthorityCommitment,
                    pendingCheckpointRoleDigest
                )
            );
    }

    function _reconcilerRecoveryDigest(
        EcdsaFraudRouterCutover.Data storage self,
        address bridgeAddress,
        bytes32 enrollmentDigest,
        bytes32 enrollmentAttestationHash
    ) private view returns (bytes32) {
        bytes32 currentAuthorityCommitment = _storedAuthorityCommitment(self);
        return
            keccak256(
                abi.encode(
                    RECONCILER_RECOVERY_DOMAIN,
                    block.chainid,
                    address(this),
                    bridgeAddress,
                    self.inventoryCommitment,
                    self.manifestPlanHash,
                    currentAuthorityCommitment,
                    enrollmentDigest,
                    enrollmentAttestationHash
                )
            );
    }

    function _inventoryCommitment(
        EcdsaFraudRouterCutover.Data storage self,
        address bridgeAddress,
        EcdsaFraudRouterCutover.InventorySnapshot memory snapshot,
        bytes32 sourceAttestationHash,
        bytes32 reconcilerAttestationHash
    ) private view returns (bytes32) {
        bytes32 routerCommitment = keccak256(
            abi.encode(
                self.oldRouter,
                self.newRouter,
                self.oldRouterCodeHash,
                self.newRouterCodeHash,
                self.drainBlock,
                self.governanceDelay
            )
        );
        bytes32 snapshotHash = keccak256(abi.encode(snapshot));
        bytes32 attestationCommitment = keccak256(
            abi.encode(sourceAttestationHash, reconcilerAttestationHash)
        );
        bytes32 manifestCommitment = keccak256(
            abi.encode(
                self.manifestPlanHash,
                self.manifestSourceAttestationHash,
                self.manifestReconcilerAttestationHash
            )
        );
        bytes32 authorityCommitment = _storedAuthorityCommitment(self);
        bytes32 snapshotCommitment = keccak256(
            abi.encode(
                self.scanStartBlock,
                snapshotHash,
                attestationCommitment,
                manifestCommitment,
                authorityCommitment
            )
        );
        return
            keccak256(
                abi.encode(
                    INVENTORY_DOMAIN,
                    block.chainid,
                    bridgeAddress,
                    routerCommitment,
                    snapshotCommitment
                )
            );
    }

    function _requireCodeHash(address router, bytes32 expectedCodeHash)
        private
        view
    {
        if (
            expectedCodeHash == bytes32(0) ||
            router.codehash != expectedCodeHash
        ) {
            revert EcdsaFraudRouterCutover
                .EcdsaFraudCutoverCodeHashMismatch(router);
        }
    }

    function _storedAuthorityCommitment(
        EcdsaFraudRouterCutover.Data storage self
    ) private view returns (bytes32) {
        return
            _authorityCommitment(
                self.sourceSigner,
                self.sourceId,
                self.sourceContext,
                self.reconciler,
                self.reconcilerSourceId,
                self.reconcilerContext
            );
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
            revert EcdsaFraudRouterCutover
                .EcdsaFraudCutoverRouterNotEmpty(router);
        }
    }
}
