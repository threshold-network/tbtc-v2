// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import {BTCUtils} from "@keep-network/bitcoin-spv-sol/contracts/BTCUtils.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import "./BridgeState.sol";
import "./Deposit.sol";
import "./IBridgeLifecycleRouter.sol";
import "./P2TRAuthorizationRegistry.sol";
import "./P2TRFraudEvidenceProtocol.sol";
import "./Wallets.sol";

interface ICompleteP2TRAuthorizedProofReconciliation {
    function reconcileAuthorizedMovingFundsProof(bytes20 walletPubKeyHash)
        external;

    function reconcileReservationConflict(bytes20 walletPubKeyHash) external;
}

/// @notice Shared resource locking and SPV-proof settlement for COMPLETE_V2.
/// @dev This is a linked library so every production Bridge action uses one
///      canonical resource namespace and one fail-closed registry adapter.
library P2TRReservation {
    using BTCUtils for bytes;

    string internal constant ResourceDomain =
        "tbtc-p2tr-pre-signing-resource-v1";
    string internal constant WalletMainSlot = "wallet-main-slot";
    string internal constant BitcoinOutpoint = "bitcoin-outpoint";
    string internal constant RedemptionRequest = "redemption-request";
    string internal constant MovedFundsRequest = "moved-funds-request";
    string internal constant ApplyPlanDomain =
        "tbtc-p2tr-pre-signing-apply-plan-v1";
    string internal constant OutputKeyCoverageLeafDomain =
        "tbtc-p2tr-output-key-coverage-leaf-v1";
    string internal constant OutputKeyCoverageAuthorizationDomain =
        "tbtc-p2tr-output-key-coverage-authorization-v1";
    string internal constant DualSourceCheckpointDomain =
        "tbtc-complete-p2tr-dual-source-checkpoint-v1";
    bytes32 internal constant EIP1967ImplementationSlot =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    uint256 internal constant MaximumCoverageBatchSize = 32;

    enum ProofDisposition {
        Unreserved,
        Authorized,
        Conflicted
    }

    struct ProofSettlement {
        ProofDisposition disposition;
        uint64 feeLimitSnapshot;
    }

    struct DepositApplicationPlan {
        bool routeToVault;
        address treasury;
    }

    struct CoverageAuthorization {
        bytes32 inventoryRoot;
        uint64 inventoryCount;
        uint64 historyStartBlock;
        uint64 snapshotBlock;
        bytes32 snapshotBlockHash;
        bytes32 sourceIdentity1;
        address sourceSigner1;
        bytes32 sourceCheckpointDigest1;
        bytes32 sourceIdentity2;
        address sourceSigner2;
        bytes32 sourceCheckpointDigest2;
        bytes32 sourceCheckpointCommitment;
        bytes32 linkedLibrariesCommitment;
        address implementation;
        bytes32 implementationCodeHash;
        address authorizationRegistry;
        bytes32 authorizationRegistryCodeHash;
        address fraudRouter;
        bytes32 fraudRouterCodeHash;
    }

    event WalletQuarantinedForP2TRFraud(
        bytes20 indexed walletPubKeyHash,
        Wallets.WalletState previousState
    );
    event WalletP2TRFraudQuarantineLifted(
        bytes20 indexed walletPubKeyHash,
        Wallets.WalletState restoredState
    );
    event WalletRecoveryRequired(bytes20 indexed walletPubKeyHash);
    event TaprootOutputKeyCoverageInitialized(
        bytes32 indexed inventoryRoot,
        uint64 inventoryCount
    );
    event TaprootOutputKeyCoverageAuthorized(
        bytes32 indexed authorizationDigest,
        address indexed authority,
        address indexed fraudRouter,
        uint64 historyStartBlock,
        uint64 snapshotBlock,
        bytes32 snapshotBlockHash,
        bytes32 sourceCheckpointCommitment,
        bytes32 linkedLibrariesCommitment
    );
    event TaprootOutputKeyCoverageRebuildCheckpointsAuthorized(
        bytes32 indexed sourceCheckpointCommitment,
        bytes32 indexed sourceCheckpoint1,
        bytes32 indexed sourceCheckpoint2
    );
    event TaprootOutputKeyCoverageLeafMigrated(
        uint64 indexed leafIndex,
        uint256 indexed depositKey,
        bytes32 indexed walletID,
        bytes32 outputKey,
        uint64 migratedCount
    );
    event TaprootOutputKeyCoverageLeafTerminallyResolved(
        uint64 indexed leafIndex,
        uint256 indexed depositKey,
        bytes32 indexed walletID,
        bytes32 outputKey,
        uint64 migratedCount
    );

    function walletMainSlotResource(bytes32 walletID)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(ResourceDomain, WalletMainSlot, walletID));
    }

    function outpointResource(bytes32 txHash, uint32 outputIndex)
        internal
        pure
        returns (bytes32)
    {
        return
            keccak256(
                abi.encode(
                    ResourceDomain,
                    BitcoinOutpoint,
                    txHash,
                    outputIndex
                )
            );
    }

    function redemptionRequestResource(uint256 redemptionKey)
        internal
        pure
        returns (bytes32)
    {
        return
            keccak256(
                abi.encode(
                    ResourceDomain,
                    RedemptionRequest,
                    redemptionKey
                )
            );
    }

    function movedFundsRequestResource(uint256 requestKey)
        internal
        pure
        returns (bytes32)
    {
        return
            keccak256(
                abi.encode(ResourceDomain, MovedFundsRequest, requestKey)
            );
    }

    function canonicalWalletID(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash
    ) internal view returns (bytes32) {
        bytes32 walletID = self.walletIDByWalletPubKeyHash[walletPubKeyHash];
        return
            walletID == bytes32(0)
                ? Wallets.deriveLegacyWalletID(walletPubKeyHash)
                : walletID;
    }

    /// @notice Derives physical input locks in Bitcoin serialization order and
    ///         appends caller-derived semantic resources such as wallet slots.
    function proofResources(
        bytes memory inputVector,
        bytes32[] memory additionalResources
    ) internal pure returns (bytes32[] memory resources) {
        (uint256 compactSizeLength, uint256 inputsCount) = inputVector
            .parseVarInt();
        resources = new bytes32[](
            inputsCount + additionalResources.length
        );
        uint256 offset = 1 + compactSizeLength;
        for (uint256 i = 0; i < inputsCount; i++) {
            bytes32 txHash = inputVector.extractInputTxIdLeAt(offset);
            uint32 outputIndex = BTCUtils.reverseUint32(
                uint32(inputVector.extractTxIndexLeAt(offset))
            );
            resources[i] = outpointResource(txHash, outputIndex);
            offset += inputVector.determineInputLengthAt(offset);
        }
        for (uint256 i = 0; i < additionalResources.length; i++) {
            resources[inputsCount + i] = additionalResources[i];
        }
    }

    /// @notice Settles an exact authorized transaction or an SPV-proven
    ///         conflicting spend before Bridge state is mutated.
    /// @dev A later revert rolls this settlement back atomically. Resource IDs
    ///      must be derived from the proven transaction or its resolved wallet,
    ///      never supplied by an untrusted off-chain authorization payload.
    function settleProof(
        BridgeState.Storage storage self,
        bytes32 transactionHash,
        uint8 expectedAction,
        bytes20 expectedWalletPubKeyHash,
        bytes32[] memory provenResourceIDs
    ) external returns (ProofSettlement memory settlement) {
        address registryAddress = _registry(self);
        if (registryAddress == address(0)) {
            return ProofSettlement(ProofDisposition.Unreserved, 0);
        }

        IP2TRReservationRegistry registry = IP2TRReservationRegistry(
            registryAddress
        );
        (
            bytes32 reservationID,
            ,
            bytes32 applyPlanHash,
            bool authorized
        ) = registry.getAuthorizedVariant(transactionHash);

        if (authorized) {
            return ProofSettlement(
                ProofDisposition.Authorized,
                _settleAuthorized(
                    registry,
                    reservationID,
                    transactionHash,
                    applyPlanHash,
                    expectedAction,
                    expectedWalletPubKeyHash
                )
            );
        }

        if (
            _settleConflicts(
                self,
                registry,
                transactionHash,
                provenResourceIDs
            )
        )
            return ProofSettlement(ProofDisposition.Conflicted, 0);

        return ProofSettlement(ProofDisposition.Unreserved, 0);
    }

    function _settleConflicts(
        BridgeState.Storage storage self,
        IP2TRReservationRegistry registry,
        bytes32 transactionHash,
        bytes32[] memory provenResourceIDs
    ) private returns (bool conflicted) {
        bytes32[] memory reservationIDs = new bytes32[](
            provenResourceIDs.length
        );
        bytes32[] memory conflictResources = new bytes32[](
            provenResourceIDs.length
        );
        uint256 count;
        for (uint256 i = 0; i < provenResourceIDs.length; i++) {
            bytes32 id = registry.reservationForResource(provenResourceIDs[i]);
            if (id == bytes32(0)) continue;
            bool duplicate;
            for (uint256 j = 0; j < count; j++) {
                if (reservationIDs[j] == id) {
                    duplicate = true;
                    break;
                }
            }
            if (!duplicate) {
                reservationIDs[count] = id;
                conflictResources[count] = provenResourceIDs[i];
                count++;
            }
        }
        for (uint256 i = 0; i < count; i++) {
            (
                bytes32 settledReservation,
                bytes20 walletPubKeyHash
            ) = registry.settleConflictingProof(
                    transactionHash,
                    conflictResources[i]
                );
            require(settledReservation == reservationIDs[i]);
            _markRecoveryRequired(self, walletPubKeyHash);
        }
        return count > 0;
    }

    /// @notice Semantic resources are state-mutation locks only. They cannot
    ///         prove a Bitcoin conflict and therefore cause an ordinary revert,
    ///         never a recovery transition, for non-authorized transactions.
    function requireProofResourcesUnlocked(
        BridgeState.Storage storage self,
        bytes32 transactionHash,
        bytes32[] memory resourceIDs
    ) external view {
        address registryAddress = _registry(self);
        if (registryAddress == address(0)) return;
        IP2TRReservationRegistry registry = IP2TRReservationRegistry(
            registryAddress
        );
        (, , , bool authorized) = registry.getAuthorizedVariant(
            transactionHash
        );
        if (authorized) return;
        for (uint256 i = 0; i < resourceIDs.length; i++) {
            require(
                !registry.isResourceReserved(resourceIDs[i]),
                "Proof mutates a reserved Bridge resource"
            );
        }
    }

    function requireProofWalletUnlocked(
        BridgeState.Storage storage self,
        bytes32 transactionHash,
        bytes20 walletPubKeyHash
    ) external view {
        address registryAddress = _registry(self);
        if (registryAddress == address(0)) return;
        IP2TRReservationRegistry registry = IP2TRReservationRegistry(
            registryAddress
        );
        (, , , bool authorized) = registry.getAuthorizedVariant(
            transactionHash
        );
        if (authorized) return;
        require(
            !registry.isResourceReserved(
                walletMainSlotResource(
                    canonicalWalletID(self, walletPubKeyHash)
                )
            ),
            "Proof mutates a reserved wallet slot"
        );
    }

    function _settleAuthorized(
        IP2TRReservationRegistry registry,
        bytes32 reservationID,
        bytes32 transactionHash,
        bytes32 applyPlanHash,
        uint8 expectedAction,
        bytes20 expectedWalletPubKeyHash
    ) private returns (uint64 reservedFeeLimit) {
        bytes20 walletPubKeyHash;
        bytes32 snapshotHash;
        bytes32 applyPlanData1;
        bytes32 applyPlanData2;
        uint8 action;
        uint8 status;
        (
            ,
            walletPubKeyHash,
            ,
            snapshotHash,
            ,
            ,
            applyPlanData1,
            applyPlanData2,
            reservedFeeLimit,
            action,
            status
        ) = registry.getReservation(reservationID);
        require(status == 1, "Reservation is not active");
        require(action == expectedAction, "Reservation action mismatch");
        require(
            walletPubKeyHash == expectedWalletPubKeyHash,
            "Reservation wallet mismatch"
        );
        require(
            applyPlanHash ==
                keccak256(
                    abi.encode(
                        ApplyPlanDomain,
                        action,
                        transactionHash,
                        snapshotHash,
                        applyPlanData1,
                        applyPlanData2
                    )
                ),
            "Reservation application plan mismatch"
        );
        require(
            registry.settleAuthorizedProof(reservationID, transactionHash) ==
                expectedWalletPubKeyHash,
            "Reservation settlement mismatch"
        );
    }

    function requireWalletUnlocked(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash
    ) external view {
        address registry = _registry(self);
        require(
            registry == address(0) ||
                (!IP2TRAuthorizationRegistry(registry).hasActiveReservation(
                    walletPubKeyHash
                ) &&
                    !IP2TRAuthorizationRegistry(registry)
                        .isResourceReserved(
                            walletMainSlotResource(
                                canonicalWalletID(self, walletPubKeyHash)
                            )
                        )),
            "Wallet has an active signing reservation"
        );
    }

    /// @notice Returns the immutable reservation fee limit for an authorized
    ///         proven variant, otherwise the caller's current policy limit.
    function proofFeeLimit(
        BridgeState.Storage storage self,
        bytes32 transactionHash,
        uint64 currentFeeLimit
    ) external view returns (uint64) {
        address registryAddress = _registry(self);
        if (registryAddress == address(0)) return currentFeeLimit;
        IP2TRReservationRegistry registry = IP2TRReservationRegistry(
            registryAddress
        );
        (bytes32 reservationID, , , bool authorized) = registry
            .getAuthorizedVariant(transactionHash);
        if (!authorized) return currentFeeLimit;
        (, , , , , , , , uint64 reservedFeeLimit, , ) = registry
            .getReservation(reservationID);
        return reservedFeeLimit;
    }

    /// @notice Recomputes the attested application plan and returns the fixed
    ///         plan data consumed by the proof's Ethereum-side effects.
    function proofApplyPlan(
        BridgeState.Storage storage self,
        bytes32 transactionHash,
        uint8 expectedAction
    ) external view returns (bool authorized, bytes32 data1, bytes32 data2) {
        return _proofApplyPlan(self, transactionHash, expectedAction);
    }

    function depositApplicationPlan(
        BridgeState.Storage storage self,
        bytes32 transactionHash,
        address proofVault
    ) external view returns (DepositApplicationPlan memory plan) {
        (bool authorized, bytes32 data1, bytes32 data2) = _proofApplyPlan(
            self,
            transactionHash,
            1
        );
        if (!authorized) {
            return
                DepositApplicationPlan(
                    proofVault != address(0) && self.isVaultTrusted[proofVault],
                    self.treasury
                );
        }
        require(uint256(data1) >> 161 == 0, "Invalid vault plan data");
        require(uint256(data2) >> 160 == 0, "Invalid treasury plan data");
        address reservedVault = address(uint160(uint256(data1)));
        require(reservedVault == proofVault, "Reserved vault mismatch");
        return
            DepositApplicationPlan(
                ((uint256(data1) >> 160) & 1) == 1,
                address(uint160(uint256(data2)))
            );
    }

    function redemptionTreasury(
        BridgeState.Storage storage self,
        bytes32 transactionHash
    ) external view returns (address) {
        (bool authorized, bytes32 data1, bytes32 data2) = _proofApplyPlan(
            self,
            transactionHash,
            2
        );
        if (!authorized) return self.treasury;
        require(data2 == bytes32(0), "Invalid redemption plan data");
        require(uint256(data1) >> 160 == 0, "Invalid treasury plan data");
        return address(uint160(uint256(data1)));
    }

    function _proofApplyPlan(
        BridgeState.Storage storage self,
        bytes32 transactionHash,
        uint8 expectedAction
    ) private view returns (bool authorized, bytes32 data1, bytes32 data2) {
        address registryAddress = _registry(self);
        if (registryAddress == address(0)) return (false, 0, 0);
        IP2TRReservationRegistry registry = IP2TRReservationRegistry(
            registryAddress
        );
        (
            bytes32 reservationID,
            ,
            bytes32 storedApplyPlanHash,
            bool isAuthorized
        ) = registry.getAuthorizedVariant(transactionHash);
        if (!isAuthorized) return (false, 0, 0);
        bytes32 snapshotHash;
        uint8 action;
        uint8 status;
        (
            ,
            ,
            ,
            snapshotHash,
            ,
            ,
            data1,
            data2,
            ,
            action,
            status
        ) = registry.getReservation(reservationID);
        require(status != 0, "Reservation does not exist");
        require(action == expectedAction, "Reservation action mismatch");
        require(
            storedApplyPlanHash ==
                keccak256(
                    abi.encode(
                        ApplyPlanDomain,
                        action,
                        transactionHash,
                        snapshotHash,
                        data1,
                        data2
                    )
                ),
            "Reservation application plan mismatch"
        );
        return (true, data1, data2);
    }

    function requireResourceUnlocked(
        BridgeState.Storage storage self,
        bytes32 resourceID
    ) external view {
        address registry = _registry(self);
        require(
            registry == address(0) ||
                !IP2TRAuthorizationRegistry(registry).isResourceReserved(
                    resourceID
                ),
            "Bridge resource has an active signing reservation"
        );
    }

    /// @notice One-selector dispatcher for the activation-only historical
    ///         output-key inventory. Action 0 installs an independently signed
    ///         inventory; actions 1/5 migrate one/batched leaves; action 6
    ///         terminally resolves a swept/deleted leaf. Actions 2/3/4/7 are
    ///         exact state and authorization readbacks.
    function processTaprootOutputKeyCoverage(
        BridgeState.Storage storage self,
        bytes calldata payload,
        bool isGovernance,
        address coverageAuthority,
        address governance
    ) external returns (bytes memory result) {
        uint8 action = abi.decode(payload, (uint8));
        if (action == 0) {
            (
                ,
                CoverageAuthorization memory authorization,
                bytes memory sourceSignature1,
                bytes memory sourceSignature2,
                bytes memory signature
            ) = abi.decode(
                payload,
                (uint8, CoverageAuthorization, bytes, bytes, bytes)
            );
            require(isGovernance, "Caller is not governance");
            require(
                !self.taprootOutputKeyCoverageInitialized,
                "Coverage inventory already initialized"
            );
            bytes32 authorizationDigest = _authorizeCoverage(
                authorization,
                coverageAuthority,
                governance,
                sourceSignature1,
                sourceSignature2,
                signature
            );
            self.taprootOutputKeyCoverageInitialized = true;
            self.taprootOutputKeyCoverageInventoryRoot = authorization
                .inventoryRoot;
            self.taprootOutputKeyCoverageInventoryCount = authorization
                .inventoryCount;
            self.taprootOutputKeyCoverageAuthorizedRouter = authorization
                .fraudRouter;
            self.taprootOutputKeyCoverageAuthorizationDigest = authorizationDigest;
            self.taprootOutputKeyCoverageHistoryStartBlock = authorization
                .historyStartBlock;
            self.taprootOutputKeyCoverageSnapshotBlock = authorization
                .snapshotBlock;
            self.taprootOutputKeyCoverageSnapshotBlockHash = authorization
                .snapshotBlockHash;
            self.taprootOutputKeyCoverageSourceCheckpointCommitment = authorization
                .sourceCheckpointCommitment;
            self.taprootOutputKeyCoverageSourceCheckpoint1 = keccak256(
                abi.encode(
                    authorization.sourceIdentity1,
                    authorization.sourceSigner1,
                    authorization.sourceCheckpointDigest1
                )
            );
            self.taprootOutputKeyCoverageSourceCheckpoint2 = keccak256(
                abi.encode(
                    authorization.sourceIdentity2,
                    authorization.sourceSigner2,
                    authorization.sourceCheckpointDigest2
                )
            );
            self.taprootOutputKeyCoverageLinkedLibrariesCommitment = authorization
                .linkedLibrariesCommitment;
            emit TaprootOutputKeyCoverageAuthorized(
                authorizationDigest,
                coverageAuthority,
                authorization.fraudRouter,
                authorization.historyStartBlock,
                authorization.snapshotBlock,
                authorization.snapshotBlockHash,
                authorization.sourceCheckpointCommitment,
                authorization.linkedLibrariesCommitment
            );
            emit TaprootOutputKeyCoverageRebuildCheckpointsAuthorized(
                authorization.sourceCheckpointCommitment,
                self.taprootOutputKeyCoverageSourceCheckpoint1,
                self.taprootOutputKeyCoverageSourceCheckpoint2
            );
            emit TaprootOutputKeyCoverageInitialized(
                authorization.inventoryRoot,
                authorization.inventoryCount
            );
            return bytes("");
        }
        if (action == 1) {
            _migrateOutputKeyPayload(self, payload, false);
            return bytes("");
        }
        if (action == 2) {
            return
                abi.encode(
                    self.taprootOutputKeyCoverageInitialized,
                    self.taprootOutputKeyCoverageInventoryRoot,
                    self.taprootOutputKeyCoverageInventoryCount,
                    self.taprootOutputKeyCoverageMigratedCount
                );
        }
        if (action == 3) {
            (, uint64 index) = abi.decode(payload, (uint8, uint64));
            return
                abi.encode(
                    self.taprootOutputKeyCoverageLeafMigrated[index]
                );
        }
        if (action == 4) {
            (, uint256 depositKey) = abi.decode(
                payload,
                (uint8, uint256)
            );
            return abi.encode(self.taprootDepositOutputKeys[depositKey]);
        }
        if (action == 5) {
            (, bytes[] memory migrations) = abi.decode(
                payload,
                (uint8, bytes[])
            );
            require(
                migrations.length > 0 &&
                    migrations.length <= MaximumCoverageBatchSize,
                "Invalid coverage batch size"
            );
            for (uint256 i = 0; i < migrations.length; i++) {
                (uint8 migrationAction, uint64 migrationIndex) = abi.decode(
                    migrations[i],
                    (uint8, uint64)
                );
                require(
                    migrationAction == 1 || migrationAction == 6,
                    "Invalid coverage migration action"
                );
                if (!self.taprootOutputKeyCoverageLeafMigrated[migrationIndex]) {
                    _migrateOutputKeyPayload(
                        self,
                        migrations[i],
                        migrationAction == 6
                    );
                }
            }
            return bytes("");
        }
        if (action == 6) {
            _migrateOutputKeyPayload(self, payload, true);
            return bytes("");
        }
        if (action == 7) {
            return _coverageReadback(self, coverageAuthority);
        }
        revert("Unknown output-key coverage action");
    }

    function _coverageReadback(
        BridgeState.Storage storage self,
        address coverageAuthority
    ) private view returns (bytes memory) {
        return
            abi.encode(
                coverageAuthority,
                self.taprootOutputKeyCoverageAuthorizationDigest,
                self.taprootOutputKeyCoverageAuthorizedRouter,
                self.taprootOutputKeyCoverageHistoryStartBlock,
                self.taprootOutputKeyCoverageSnapshotBlock,
                self.taprootOutputKeyCoverageSnapshotBlockHash,
                self.taprootOutputKeyCoverageSourceCheckpointCommitment,
                self.taprootOutputKeyCoverageSourceCheckpoint1,
                self.taprootOutputKeyCoverageSourceCheckpoint2,
                self.taprootOutputKeyCoverageLinkedLibrariesCommitment
            );
    }

    function _authorizeCoverage(
        CoverageAuthorization memory authorization,
        address coverageAuthority,
        address governance,
        bytes memory sourceSignature1,
        bytes memory sourceSignature2,
        bytes memory signature
    ) private view returns (bytes32 digest) {
        require(
            coverageAuthority != address(0) &&
                coverageAuthority != governance,
            "Coverage authority is not independent"
        );
        require(
            (authorization.inventoryCount == 0 &&
                authorization.inventoryRoot == bytes32(0)) ||
                (authorization.inventoryCount != 0 &&
                    authorization.inventoryRoot != bytes32(0)),
            "Invalid coverage inventory"
        );
        require(
            authorization.historyStartBlock <= authorization.snapshotBlock &&
                authorization.snapshotBlock <= block.number &&
                authorization.linkedLibrariesCommitment != bytes32(0),
            "Invalid coverage history range"
        );
        require(
            authorization.sourceSigner1 != address(0) &&
                authorization.sourceSigner2 != address(0) &&
                authorization.sourceSigner1 != authorization.sourceSigner2 &&
                authorization.sourceSigner1 != coverageAuthority &&
                authorization.sourceSigner2 != coverageAuthority &&
                authorization.sourceSigner1 != governance &&
                authorization.sourceSigner2 != governance &&
                authorization.sourceIdentity1 < authorization.sourceIdentity2 &&
                authorization.sourceCheckpointDigest1 != bytes32(0) &&
                authorization.sourceCheckpointDigest2 != bytes32(0) &&
                authorization.sourceCheckpointDigest1 !=
                authorization.sourceCheckpointDigest2,
            "Coverage rebuild authorities are not independent"
        );
        bytes32 sourceCheckpoint1 = keccak256(
            abi.encode(
                authorization.sourceIdentity1,
                authorization.sourceSigner1,
                authorization.sourceCheckpointDigest1
            )
        );
        bytes32 sourceCheckpoint2 = keccak256(
            abi.encode(
                authorization.sourceIdentity2,
                authorization.sourceSigner2,
                authorization.sourceCheckpointDigest2
            )
        );
        require(
            authorization.sourceCheckpointCommitment ==
                keccak256(
                    abi.encode(
                        DualSourceCheckpointDomain,
                        block.chainid,
                        address(this),
                        sourceCheckpoint1,
                        sourceCheckpoint2
                    )
                ) &&
                _isValidCoverageSignature(
                    authorization.sourceSigner1,
                    authorization.sourceCheckpointDigest1,
                    sourceSignature1
                ) &&
                _isValidCoverageSignature(
                    authorization.sourceSigner2,
                    authorization.sourceCheckpointDigest2,
                    sourceSignature2
                ),
            "Invalid coverage rebuild checkpoint"
        );
        address implementation;
        bytes32 implementationSlot = EIP1967ImplementationSlot;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            implementation := sload(implementationSlot)
        }
        require(
            implementation != address(0) &&
                implementation == authorization.implementation &&
                implementation.codehash ==
                authorization.implementationCodeHash,
            "Coverage implementation codehash mismatch"
        );
        require(
            authorization.authorizationRegistry != address(0) &&
                authorization.authorizationRegistry.codehash ==
                authorization.authorizationRegistryCodeHash,
            "Coverage registry codehash mismatch"
        );
        require(
            authorization.fraudRouter != address(0) &&
                authorization.fraudRouter.codehash ==
                authorization.fraudRouterCodeHash &&
                IP2TRAuthorizationRouter(authorization.fraudRouter)
                    .authorizationRegistry() ==
                authorization.authorizationRegistry,
            "Coverage router codehash/crosslink mismatch"
        );
        bytes32 historyCommitment = _coverageHistoryCommitment(authorization);
        bytes32 codeCommitment = _coverageCodeCommitment(authorization);
        digest = keccak256(
            abi.encode(
                OutputKeyCoverageAuthorizationDomain,
                block.chainid,
                address(this),
                coverageAuthority,
                historyCommitment,
                codeCommitment
            )
        );
        require(
            _isValidCoverageSignature(coverageAuthority, digest, signature),
            "Invalid coverage authorization"
        );
    }

    function _coverageHistoryCommitment(
        CoverageAuthorization memory authorization
    ) private pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    authorization.inventoryRoot,
                    authorization.inventoryCount,
                    authorization.historyStartBlock,
                    authorization.snapshotBlock,
                    authorization.snapshotBlockHash,
                    authorization.sourceCheckpointCommitment,
                    authorization.linkedLibrariesCommitment
                )
            );
    }

    function _coverageCodeCommitment(
        CoverageAuthorization memory authorization
    ) private pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    authorization.linkedLibrariesCommitment,
                    authorization.implementation,
                    authorization.implementationCodeHash,
                    authorization.authorizationRegistry,
                    authorization.authorizationRegistryCodeHash,
                    authorization.fraudRouter,
                    authorization.fraudRouterCodeHash
                )
            );
    }

    function _isValidCoverageSignature(
        address signer,
        bytes32 digest,
        bytes memory signature
    ) private view returns (bool) {
        return
            SignatureChecker.isValidSignatureNow(
                signer,
                signer.code.length == 0
                    ? ECDSA.toEthSignedMessageHash(digest)
                    : digest,
                signature
            );
    }

    function _migrateOutputKeyPayload(
        BridgeState.Storage storage self,
        bytes memory payload,
        bool terminalResolution
    ) private {
        (
            uint8 action,
            uint64 index,
            uint256 depositKey,
            bytes32 walletID,
            bytes32 outputKey,
            bytes32[] memory proof
        ) = abi.decode(
                payload,
                (uint8, uint64, uint256, bytes32, bytes32, bytes32[])
            );
        require(
            action == (terminalResolution ? 6 : 1),
            "Invalid coverage migration action"
        );
        _migrateOutputKey(
            self,
            index,
            depositKey,
            walletID,
            outputKey,
            proof,
            terminalResolution
        );
    }

    function _migrateOutputKey(
        BridgeState.Storage storage self,
        uint64 index,
        uint256 depositKey,
        bytes32 walletID,
        bytes32 outputKey,
        bytes32[] memory proof,
        bool terminalResolution
    ) private {
        require(self.taprootOutputKeyCoverageInitialized);
        require(index < self.taprootOutputKeyCoverageInventoryCount);
        require(!self.taprootOutputKeyCoverageLeafMigrated[index]);
        require(outputKey != bytes32(0));
        require(self.taprootDepositOutputKeys[depositKey] == bytes32(0));
        if (terminalResolution) {
            require(
                self.deposits[depositKey].depositor == address(0) ||
                    self.deposits[depositKey].sweptAt != 0,
                "Live coverage leaf cannot be terminally resolved"
            );
        } else {
            require(self.deposits[depositKey].depositor != address(0));
        }
        bytes32 commitment = self.taprootDepositOutputKeyCommitments[
            depositKey
        ];
        require(
            commitment != bytes32(0) &&
                commitment ==
                Deposit.taprootOutputKeyCommitment(walletID, outputKey)
        );
        require(
            _verifyCoverageProof(
                self.taprootOutputKeyCoverageInventoryRoot,
                self.taprootOutputKeyCoverageInventoryCount,
                index,
                keccak256(
                    abi.encode(
                        OutputKeyCoverageLeafDomain,
                        index,
                        depositKey,
                        walletID,
                        outputKey,
                        commitment
                    )
                ),
                proof
            )
        );

        self.taprootOutputKeyCoverageLeafMigrated[index] = true;
        self.taprootOutputKeyCoverageMigratedCount++;
        if (terminalResolution) {
            emit TaprootOutputKeyCoverageLeafTerminallyResolved(
                index,
                depositKey,
                walletID,
                outputKey,
                self.taprootOutputKeyCoverageMigratedCount
            );
        } else {
            self.taprootDepositOutputKeys[depositKey] = outputKey;
            emit TaprootOutputKeyCoverageLeafMigrated(
                index,
                depositKey,
                walletID,
                outputKey,
                self.taprootOutputKeyCoverageMigratedCount
            );
        }
    }

    function _verifyCoverageProof(
        bytes32 root,
        uint64 count,
        uint64 index,
        bytes32 leaf,
        bytes32[] memory proof
    ) private pure returns (bool) {
        uint256 width = 1;
        uint256 depth;
        while (width < count) {
            width <<= 1;
            depth++;
        }
        if (proof.length != depth) return false;
        bytes32 node = leaf;
        uint256 position = index;
        for (uint256 i = 0; i < proof.length; i++) {
            node =
                (position & 1) == 0
                    ? keccak256(abi.encodePacked(node, proof[i]))
                    : keccak256(abi.encodePacked(proof[i], node));
            position >>= 1;
        }
        return node == root;
    }

    function setCompleteP2TRFraudRouter(
        BridgeState.Storage storage self,
        address router
    ) external {
        require(self.p2trFraudRouter == address(0));
        require(
            self.taprootOutputKeyCoverageInitialized &&
                self.taprootOutputKeyCoverageMigratedCount ==
                self.taprootOutputKeyCoverageInventoryCount
        );
        require(
            router == self.taprootOutputKeyCoverageAuthorizedRouter,
            "Router not authorized by coverage manifest"
        );
        P2TRFraudEvidenceProtocol.requireCompleteRouter(
            router,
            address(this),
            self.frostWalletRegistry
        );
        self.p2trFraudRouter = router;
        emit BridgeState.P2TRFraudRouterSet(router);
    }

    /// @notice Applies the stateful tail of an exact authorized moving-funds
    ///         proof without erasing an independent fraud lifecycle. Ordinary
    ///         MovingFunds wallets return false and use the legacy transition.
    ///         Quarantined/RecoveryRequired wallets keep that safety state.
    function reconcileAuthorizedMovingFundsProof(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash,
        bytes32 transactionHash,
        bytes32 targetWalletsHash
    ) external returns (bool reconciled) {
        Wallets.Wallet storage wallet = self.registeredWallets[
            walletPubKeyHash
        ];
        if (wallet.state == Wallets.WalletState.MovingFunds) return false;
        _requireProofWalletState(
            self,
            transactionHash,
            walletPubKeyHash,
            3
        );
        require(
            wallet.movingFundsTargetWalletsCommitmentHash != bytes32(0) &&
                wallet.movingFundsTargetWalletsCommitmentHash ==
                targetWalletsHash,
            "Target wallets don't correspond to the commitment"
        );

        delete wallet.mainUtxoHash;
        if (wallet.state == Wallets.WalletState.Quarantined) {
            /* solhint-disable-next-line not-rely-on-time */
            wallet.closingStartedAt = uint32(block.timestamp);
            ICompleteP2TRAuthorizedProofReconciliation(self.p2trFraudRouter)
                .reconcileAuthorizedMovingFundsProof(walletPubKeyHash);
            emit Wallets.WalletClosing(bytes32(0), walletPubKeyHash);
        }
        return true;
    }

    function requireProofWalletState(
        BridgeState.Storage storage self,
        bytes32 transactionHash,
        bytes20 walletPubKeyHash,
        uint8 expectedAction
    ) external view {
        _requireProofWalletState(
            self,
            transactionHash,
            walletPubKeyHash,
            expectedAction
        );
    }

    function _requireProofWalletState(
        BridgeState.Storage storage self,
        bytes32 transactionHash,
        bytes20 walletPubKeyHash,
        uint8 expectedAction
    ) private view {
        Wallets.WalletState state = self
            .registeredWallets[walletPubKeyHash]
            .state;
        if (expectedAction == 3) {
            if (state == Wallets.WalletState.MovingFunds) return;
        } else if (
            state == Wallets.WalletState.Live ||
            state == Wallets.WalletState.MovingFunds
        ) return;

        require(
            state == Wallets.WalletState.Quarantined ||
                state == Wallets.WalletState.RecoveryRequired,
            "Wallet state is invalid for proof"
        );
        IP2TRReservationRegistry registry = IP2TRReservationRegistry(
            _registry(self)
        );
        (bytes32 reservationID, , , bool authorized) = registry
            .getAuthorizedVariant(transactionHash);
        bytes20 reservedWallet;
        uint8 action;
        uint8 status;
        (, reservedWallet, , , , , , , , action, status) = registry
            .getReservation(reservationID);
        require(
            authorized &&
                status == 2 &&
                action == expectedAction &&
                reservedWallet == walletPubKeyHash,
            "Fraud-state proof is not settled authorization"
        );
    }

    /// @notice Compact Bridge callback dispatcher. Payload is
    ///         abi.encode(action, actionData): 0=quarantine(bytes20),
    ///         1=restore(bytes20,uint8,bool),
    ///         2=quarantined timeout(bytes20,uint32[],address),
    ///         3=archived timeout(bytes20,uint32[],address).
    function processWalletLifecycle(
        BridgeState.Storage storage self,
        bytes calldata payload
    ) external returns (bytes memory result) {
        (uint8 action, bytes memory actionData) = abi.decode(
            payload,
            (uint8, bytes)
        );
        if (action == 0) {
            Wallets.WalletState previousState;
            bool wasActive;
            (previousState, wasActive) = _quarantineWallet(
                self,
                abi.decode(actionData, (bytes20))
            );
            return abi.encode(uint8(previousState), wasActive);
        }
        if (action == 1) {
            (
                bytes20 walletPubKeyHash,
                uint8 previousState,
                bool wasActive
            ) = abi.decode(actionData, (bytes20, uint8, bool));
            require(previousState <= uint8(Wallets.WalletState.Closing));
            _restoreWallet(
                self,
                walletPubKeyHash,
                Wallets.WalletState(previousState),
                wasActive
            );
            return bytes("");
        }
        if (action == 2 || action == 3) {
            (
                bytes20 walletPubKeyHash,
                uint32[] memory walletMembersIDs,
                address challenger
            ) = abi.decode(actionData, (bytes20, uint32[], address));
            if (action == 2) {
                _notifyFraudTimeout(
                    self,
                    walletPubKeyHash,
                    walletMembersIDs,
                    challenger
                );
            } else {
                _notifyArchivedFraudTimeout(
                    self,
                    walletPubKeyHash,
                    walletMembersIDs,
                    challenger
                );
            }
            return bytes("");
        }
        revert("Unknown P2TR wallet lifecycle action");
    }

    function _quarantineWallet(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash
    ) private returns (Wallets.WalletState previousState, bool wasActive) {
        Wallets.Wallet storage wallet = self.registeredWallets[
            walletPubKeyHash
        ];
        previousState = wallet.state;
        require(wallet.ecdsaWalletID == bytes32(0), "FROST wallet required");
        require(
            previousState == Wallets.WalletState.Live ||
                previousState == Wallets.WalletState.MovingFunds ||
                previousState == Wallets.WalletState.Closing,
            "Wallet cannot be quarantined"
        );
        if (previousState == Wallets.WalletState.Live) {
            self.liveWalletsCount--;
            wasActive = self.activeWalletPubKeyHash == walletPubKeyHash;
            if (wasActive) {
                delete self.activeWalletPubKeyHash;
                delete self.activeWalletID;
            }
        }
        wallet.state = Wallets.WalletState.Quarantined;
        emit WalletQuarantinedForP2TRFraud(walletPubKeyHash, previousState);
    }

    function _restoreWallet(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash,
        Wallets.WalletState previousState,
        bool wasActive
    ) private {
        Wallets.Wallet storage wallet = self.registeredWallets[
            walletPubKeyHash
        ];
        require(
            wallet.state == Wallets.WalletState.Quarantined,
            "Wallet is not quarantined"
        );
        require(
            previousState == Wallets.WalletState.Live ||
                previousState == Wallets.WalletState.MovingFunds ||
                previousState == Wallets.WalletState.Closing,
            "Invalid quarantine restoration state"
        );
        wallet.state = previousState;
        if (previousState == Wallets.WalletState.Live) {
            self.liveWalletsCount++;
            if (wasActive && self.activeWalletPubKeyHash == bytes20(0)) {
                self.activeWalletPubKeyHash = walletPubKeyHash;
                self.activeWalletID = self.walletIDByWalletPubKeyHash[
                    walletPubKeyHash
                ];
            }
        }
        emit WalletP2TRFraudQuarantineLifted(
            walletPubKeyHash,
            previousState
        );
    }

    function _notifyFraudTimeout(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash,
        uint32[] memory walletMembersIDs,
        address challenger
    ) private {
        Wallets.Wallet storage wallet = self.registeredWallets[
            walletPubKeyHash
        ];
        require(
            wallet.state == Wallets.WalletState.Quarantined,
            "Wallet must be quarantined"
        );
        _seizeWalletForFraud(
            self,
            walletPubKeyHash,
            walletMembersIDs,
            challenger
        );
        wallet.state = Wallets.WalletState.RecoveryRequired;
        emit WalletRecoveryRequired(walletPubKeyHash);
    }

    function _notifyArchivedFraudTimeout(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash,
        uint32[] memory walletMembersIDs,
        address challenger
    ) private {
        Wallets.Wallet storage wallet = self.registeredWallets[
            walletPubKeyHash
        ];
        require(wallet.ecdsaWalletID == bytes32(0), "FROST wallet required");
        require(
            wallet.state == Wallets.WalletState.Closed ||
                wallet.state == Wallets.WalletState.Terminated,
            "Wallet must be archived"
        );
        _seizeWalletForFraud(
            self,
            walletPubKeyHash,
            walletMembersIDs,
            challenger
        );
    }

    function _seizeWalletForFraud(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash,
        uint32[] memory walletMembersIDs,
        address challenger
    ) private {
        IBridgeLifecycleRouter(self.lifecycleRouter).seize(
            walletPubKeyHash,
            self.fraudSlashingAmount,
            self.fraudNotifierRewardMultiplier,
            challenger,
            walletMembersIDs
        );
    }

    function _markRecoveryRequired(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash
    ) private {
        Wallets.Wallet storage wallet = self.registeredWallets[
            walletPubKeyHash
        ];
        Wallets.WalletState previousState = wallet.state;
        require(
            previousState != Wallets.WalletState.Unknown &&
                previousState != Wallets.WalletState.Closed,
            "Wallet cannot enter recovery"
        );

        if (previousState == Wallets.WalletState.Live) {
            if (self.activeWalletPubKeyHash == walletPubKeyHash) {
                delete self.activeWalletPubKeyHash;
                delete self.activeWalletID;
            }
            self.liveWalletsCount--;
        }
        wallet.state = Wallets.WalletState.RecoveryRequired;
        ICompleteP2TRAuthorizedProofReconciliation(self.p2trFraudRouter)
            .reconcileReservationConflict(walletPubKeyHash);
    }

    function _registry(BridgeState.Storage storage self)
        private
        view
        returns (address)
    {
        address router = self.p2trFraudRouter;
        if (router == address(0)) return address(0);
        return IP2TRAuthorizationRouter(router).authorizationRegistry();
    }
}

interface IP2TRReservationRegistry is IP2TRAuthorizationRegistry {
    function getAuthorizedVariant(bytes32 transactionHash)
        external
        view
        returns (
            bytes32 reservationID,
            bytes32 authorizationRoot,
            bytes32 applyPlanHash,
            bool authorized
        );

    function getReservation(bytes32 reservationID)
        external
        view
        returns (
            bytes32 walletID,
            bytes20 walletPubKeyHash,
            bytes32 membersIDsHash,
            bytes32 snapshotHash,
            bytes32 resourceHash,
            bytes32 orderedInputRoot,
            bytes32 applyPlanData1,
            bytes32 applyPlanData2,
            uint64 feeLimitSnapshot,
            uint8 action,
            uint8 status
        );

    function reservationForResource(bytes32 resourceID)
        external
        view
        returns (bytes32);
}
