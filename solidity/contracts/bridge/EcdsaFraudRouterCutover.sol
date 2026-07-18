// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "./EcdsaFraudRouterProtocol.sol";

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
    uint256 internal constant FINALITY_CONFIRMATIONS = 64;
    uint256 internal constant MAX_BLOCKHASH_AGE = 255;
    bytes32 internal constant INVENTORY_DOMAIN =
        keccak256("tbtc/ecdsa-fraud-router-cutover/inventory/v1");
    bytes32 internal constant POST_MIGRATION_DOMAIN =
        keccak256("tbtc/ecdsa-fraud-router-cutover/post-migration/v1");

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
        address reconciler;
        bytes32 inventoryCommitment;
        bytes32 postMigrationCommitment;
        uint64 migratedBlock;
        uint64 migrationConfirmedAt;
        uint256 governanceDelay;
        address pendingReconciler;
        uint64 reconcilerUpdateStartedAt;
    }

    event EcdsaFraudCutoverDrainStarted(
        address indexed oldRouter,
        address indexed newRouter,
        bytes32 oldRouterCodeHash,
        bytes32 newRouterCodeHash,
        uint64 drainBlock,
        uint64 scanStartBlock,
        uint256 governanceDelay
    );
    event EcdsaFraudInventoryStaged(
        bytes32 indexed inventoryCommitment,
        uint64 indexed scanStartBlock,
        uint64 indexed finalizedBlock,
        bytes32 finalizedBlockHash,
        bytes32 challengeSetHash,
        uint32 challengeCount,
        uint256 totalEscrow,
        address reconciler
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
        uint64 startedAt
    );
    event EcdsaFraudReconcilerUpdated(
        address indexed previousReconciler,
        address indexed newReconciler
    );

    error EcdsaFraudCutoverWrongPhase(Phase expected, Phase actual);
    error EcdsaFraudCutoverNotBridgeGovernance();
    error EcdsaFraudCutoverRouterMismatch();
    error EcdsaFraudCutoverRouterRetired(address router);
    error EcdsaFraudCutoverCodeHashMismatch(address router);
    error EcdsaFraudCutoverRouterIncompatible(address router);
    error EcdsaFraudCutoverRouterNotEmpty(address router);
    error EcdsaFraudCutoverInvalidReconciler();
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

    function beginDrain(
        Data storage self,
        address bridgeAddress,
        address oldRouter,
        bytes32 oldRouterCodeHash,
        address newRouter,
        bytes32 newRouterCodeHash,
        uint64 scanStartBlock,
        uint256 governanceDelay
    ) external {
        _requirePhase(self, Phase.Idle);
        IBridgeEcdsaFraudCutover bridge = IBridgeEcdsaFraudCutover(
            bridgeAddress
        );
        _requireBridgeGovernance(bridge);
        if (
            oldRouter == address(0) ||
            newRouter == address(0) ||
            oldRouter == newRouter ||
            bridge.ecdsaFraudRouter() != oldRouter ||
            scanStartBlock > block.number
        ) {
            revert EcdsaFraudCutoverRouterMismatch();
        }

        bytes32 approvedOldCodeHash = bridge.ecdsaFraudRouterCodeHash();
        if (
            approvedOldCodeHash != bytes32(0) &&
            approvedOldCodeHash != oldRouterCodeHash
        ) {
            revert EcdsaFraudCutoverCodeHashMismatch(oldRouter);
        }
        _requireCodeHash(oldRouter, oldRouterCodeHash);
        _requireCurrentRouter(
            newRouter,
            bridgeAddress,
            newRouterCodeHash,
            true,
            oldRouter
        );

        bridge.processEcdsaFraudRouterCutover(
            0,
            abi.encode(oldRouterCodeHash, newRouter)
        );

        self.phase = Phase.Draining;
        self.oldRouter = oldRouter;
        self.newRouter = newRouter;
        self.oldRouterCodeHash = oldRouterCodeHash;
        self.newRouterCodeHash = newRouterCodeHash;
        self.drainBlock = uint64(block.number);
        self.scanStartBlock = scanStartBlock;
        self.governanceDelay = governanceDelay;

        emit EcdsaFraudCutoverDrainStarted(
            oldRouter,
            newRouter,
            oldRouterCodeHash,
            newRouterCodeHash,
            self.drainBlock,
            scanStartBlock,
            governanceDelay
        );
    }

    function stageInventory(
        Data storage self,
        address bridgeAddress,
        uint64 finalizedBlock,
        bytes32 finalizedBlockHash,
        bytes32 challengeSetHash,
        uint32 challengeCount,
        uint256 totalEscrow,
        address reconciler
    ) external {
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
        if (
            reconciler == address(0) ||
            reconciler == address(this) ||
            reconciler == msg.sender
        ) {
            revert EcdsaFraudCutoverInvalidReconciler();
        }
        if (
            self.scanStartBlock > finalizedBlock ||
            finalizedBlock < self.drainBlock
        ) {
            revert EcdsaFraudCutoverInvalidScanRange();
        }
        _requireFinalizedBlock(finalizedBlock, finalizedBlockHash);

        bytes32 commitment = _inventoryCommitment(
            self,
            bridgeAddress,
            self.scanStartBlock,
            finalizedBlock,
            finalizedBlockHash,
            challengeSetHash,
            challengeCount,
            totalEscrow
        );

        self.phase = Phase.InventoryStaged;
        self.finalizedBlock = finalizedBlock;
        self.finalizedBlockHash = finalizedBlockHash;
        self.challengeSetHash = challengeSetHash;
        self.challengeCount = challengeCount;
        self.totalEscrow = totalEscrow;
        self.reconciler = reconciler;
        self.inventoryCommitment = commitment;

        emit EcdsaFraudInventoryStaged(
            commitment,
            self.scanStartBlock,
            finalizedBlock,
            finalizedBlockHash,
            challengeSetHash,
            challengeCount,
            totalEscrow,
            reconciler
        );
    }

    function confirmInventory(
        Data storage self,
        address bridgeAddress,
        bytes32 expectedInventoryCommitment
    ) external {
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
        _requireFinalizedBlock(self.finalizedBlock, self.finalizedBlockHash);

        self.phase = Phase.InventoryConfirmed;
        emit EcdsaFraudInventoryConfirmed(self.inventoryCommitment, msg.sender);
    }

    function migrate(
        Data storage self,
        address bridgeAddress,
        uint256[] calldata challengeKeys
    ) external {
        _requirePhase(self, Phase.InventoryConfirmed);
        IBridgeEcdsaFraudCutover bridge = IBridgeEcdsaFraudCutover(
            bridgeAddress
        );
        _requireBridgeGovernance(bridge);
        _requireFrozenBridgeState(self, bridge);
        _requireFinalizedBlock(self.finalizedBlock, self.finalizedBlockHash);
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

    function confirmMigration(
        Data storage self,
        address bridgeAddress,
        uint256[] calldata challengeKeys
    ) external {
        _requirePhase(self, Phase.Migrated);
        if (msg.sender != self.reconciler) {
            revert EcdsaFraudCutoverUnauthorizedReconciler();
        }
        IBridgeEcdsaFraudCutover bridge = IBridgeEcdsaFraudCutover(
            bridgeAddress
        );
        _requireBridgeGovernance(bridge);
        _requireFrozenBridgeState(self, bridge);

        bytes32 postMigrationCommitment = _verifyPostMigration(
            self,
            bridge,
            bridgeAddress,
            challengeKeys
        );
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
    function beginReconcilerUpdate(
        Data storage self,
        address bridgeAddress,
        address newReconciler
    ) external {
        _requirePhase(self, Phase.Migrated);
        IBridgeEcdsaFraudCutover bridge = IBridgeEcdsaFraudCutover(
            bridgeAddress
        );
        _requireBridgeGovernance(bridge);
        _requireFrozenBridgeState(self, bridge);
        if (
            newReconciler == address(0) ||
            newReconciler == address(this) ||
            newReconciler == msg.sender ||
            newReconciler == self.reconciler
        ) {
            revert EcdsaFraudCutoverInvalidReconciler();
        }

        self.pendingReconciler = newReconciler;
        /* solhint-disable-next-line not-rely-on-time */
        self.reconcilerUpdateStartedAt = uint64(block.timestamp);
        emit EcdsaFraudReconcilerUpdateStarted(
            self.reconciler,
            newReconciler,
            self.reconcilerUpdateStartedAt
        );
    }

    /// @notice Completes a phase-four reconciler recovery after the cutover's
    ///         immutable governance delay.
    function finalizeReconcilerUpdate(Data storage self, address bridgeAddress)
        external
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
        delete self.pendingReconciler;
        delete self.reconcilerUpdateStartedAt;
        emit EcdsaFraudReconcilerUpdated(previousReconciler, pendingReconciler);
    }

    function finalize(
        Data storage self,
        address bridgeAddress,
        uint256[] calldata challengeKeys
    ) external {
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
        bytes32 observedPostMigrationCommitment = _verifyPostMigration(
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
        delete self.reconciler;
        delete self.inventoryCommitment;
        delete self.postMigrationCommitment;
        delete self.migratedBlock;
        delete self.migrationConfirmedAt;
        delete self.governanceDelay;
        delete self.pendingReconciler;
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

    function _requireFinalizedBlock(
        uint64 finalizedBlock,
        bytes32 expectedBlockHash
    ) private view {
        if (block.number < uint256(finalizedBlock) + FINALITY_CONFIRMATIONS) {
            revert EcdsaFraudCutoverBlockNotFinalized();
        }
        if (block.number > uint256(finalizedBlock) + MAX_BLOCKHASH_AGE) {
            revert EcdsaFraudCutoverBlockHashUnavailable();
        }
        bytes32 observedBlockHash = blockhash(finalizedBlock);
        if (observedBlockHash == bytes32(0)) {
            revert EcdsaFraudCutoverBlockHashUnavailable();
        }
        if (observedBlockHash != expectedBlockHash) {
            revert EcdsaFraudCutoverBlockHashMismatch();
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

    function _inventoryCommitment(
        Data storage self,
        address bridgeAddress,
        uint64 scanStartBlock,
        uint64 finalizedBlock,
        bytes32 finalizedBlockHash,
        bytes32 challengeSetHash,
        uint32 challengeCount,
        uint256 totalEscrow
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
        bytes32 snapshotCommitment = keccak256(
            abi.encode(
                scanStartBlock,
                finalizedBlock,
                finalizedBlockHash,
                challengeSetHash,
                challengeCount,
                totalEscrow
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

    function _verifyPostMigration(
        Data storage self,
        IBridgeEcdsaFraudCutover bridge,
        address bridgeAddress,
        uint256[] calldata challengeKeys
    ) private view returns (bytes32) {
        _requireCodeHash(self.oldRouter, self.oldRouterCodeHash);
        _requireCurrentRouter(
            self.newRouter,
            bridgeAddress,
            self.newRouterCodeHash,
            false,
            self.oldRouter
        );
        if (challengeKeys.length != self.challengeCount) {
            revert EcdsaFraudCutoverChallengeCountMismatch();
        }

        IEcdsaFraudRouterCutoverReadback newRouter = IEcdsaFraudRouterCutoverReadback(
                self.newRouter
            );
        FraudChallenge[] memory challenges = new FraudChallenge[](
            challengeKeys.length
        );
        for (uint256 i = 0; i < challengeKeys.length; i++) {
            uint256 challengeKey = challengeKeys[i];
            if (i > 0 && challengeKey <= challengeKeys[i - 1]) {
                revert EcdsaFraudCutoverKeysNotStrictlyIncreasing();
            }
            if (bridge.legacyFraudChallengeExists(challengeKey)) {
                revert EcdsaFraudCutoverLegacyRecordStillExists(challengeKey);
            }
            (
                address challenger,
                uint256 depositAmount,
                uint32 reportedAt,
                bool resolved
            ) = newRouter.fraudChallenges(challengeKey);
            if (reportedAt == 0 || resolved) {
                revert EcdsaFraudCutoverMigratedRecordMismatch(challengeKey);
            }
            challenges[i] = FraudChallenge(
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
            revert EcdsaFraudCutoverChallengeSetMismatch();
        }
        if (
            newRouter.openFraudChallengeCount() != self.challengeCount ||
            newRouter.unattributedOpenFraudChallengeCount() !=
            self.challengeCount
        ) {
            revert EcdsaFraudCutoverChallengeCountMismatch();
        }
        uint256 observedEscrow = newRouter.openFraudChallengeEscrow();
        if (
            observedEscrow != self.totalEscrow ||
            self.newRouter.balance < observedEscrow
        ) {
            revert EcdsaFraudCutoverEscrowMismatch();
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
}
