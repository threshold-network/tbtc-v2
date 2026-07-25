// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import {BTCUtils} from "@keep-network/bitcoin-spv-sol/contracts/BTCUtils.sol";
import {BytesLib} from "@keep-network/bitcoin-spv-sol/contracts/BytesLib.sol";

import "./BitcoinTx.sol";
import "./BridgeState.sol";
import "./Deposit.sol";
import "./DepositSweep.sol";
import "./MovingFunds.sol";
import "./P2TRAuthorizationRegistry.sol";
import "./P2TRReservation.sol";
import "./Redemption.sol";
import "./Wallets.sol";

/// @dev ABI-compatible subset of WalletProposalValidator. Keeping the types in
///      this interface avoids a Bridge -> library -> WalletProposalValidator ->
///      Bridge import cycle while preserving the exact selectors.
interface IP2TRWalletProposalValidator {
    struct DepositKey {
        bytes32 fundingTxHash;
        uint32 fundingOutputIndex;
    }

    struct DepositSweepProposal {
        bytes20 walletPubKeyHash;
        DepositKey[] depositsKeys;
        uint256 sweepTxFee;
        uint256[] depositsRevealBlocks;
    }

    struct TaprootDepositExtraInfo {
        BitcoinTx.Info fundingTx;
        bytes8 blindingFactor;
        bytes20 walletPubKeyHash;
        bytes32 walletXOnlyPublicKey;
        bytes20 refundPubKeyHash;
        bytes32 refundXOnlyPublicKey;
        bytes4 refundLocktime;
    }

    struct RedemptionProposal {
        bytes20 walletPubKeyHash;
        bytes[] redeemersOutputScripts;
        uint256 redemptionTxFee;
    }

    struct MovingFundsProposal {
        bytes20 walletPubKeyHash;
        bytes20[] targetWallets;
        uint256 movingFundsTxFee;
    }

    struct MovedFundsSweepProposal {
        bytes20 walletPubKeyHash;
        bytes32 movingFundsTxHash;
        uint32 movingFundsTxOutputIndex;
        uint256 movedFundsSweepTxFee;
    }

    function validateTaprootDepositSweepProposal(
        DepositSweepProposal calldata proposal,
        TaprootDepositExtraInfo[] calldata depositsExtraInfo
    ) external view returns (bool);

    function validateRedemptionProposal(RedemptionProposal calldata proposal)
        external
        view
        returns (bool);

    function validateMovingFundsProposal(
        MovingFundsProposal calldata proposal,
        BitcoinTx.UTXO calldata walletMainUtxo
    ) external view returns (bool);

    function validateMovedFundsSweepProposal(
        MovedFundsSweepProposal calldata proposal
    ) external view returns (bool);
}

/// @notice Linked pre-signing dispatcher for the four Bridge Bitcoin actions.
/// @dev Action payload ABI (all Bitcoin hashes use raw/internal byte order):
///      1 = abi.encode(DepositSweepAuthorizationData)
///      2 = abi.encode(RedemptionAuthorizationData)
///      3 = abi.encode(MovingFundsAuthorizationData)
///      4 = abi.encode(MovedFundsSweepAuthorizationData)
///
///      Every path first calls the existing WalletProposalValidator, then
///      validates the exact stripped transaction against live Bridge storage.
///      Callers cannot supply snapshots, signing keys, input values, resource
///      IDs, or apply plans.
library P2TRPreSigning {
    using BTCUtils for bytes;
    using BytesLib for bytes;

    uint8 internal constant DepositSweepAction = 1;
    uint8 internal constant RedemptionAction = 2;
    uint8 internal constant MovingFundsAction = 3;
    uint8 internal constant MovedFundsSweepAction = 4;

    string internal constant SnapshotDomain =
        "tbtc-p2tr-pre-signing-snapshot-v1";
    string internal constant ApplyPlanDomain =
        "tbtc-p2tr-pre-signing-apply-plan-v1";
    struct DepositSweepAuthorizationData {
        IP2TRWalletProposalValidator.DepositSweepProposal proposal;
        IP2TRWalletProposalValidator.TaprootDepositExtraInfo[] depositsExtraInfo;
        BitcoinTx.UTXO mainUtxo;
    }

    struct RedemptionAuthorizationData {
        IP2TRWalletProposalValidator.RedemptionProposal proposal;
        BitcoinTx.UTXO mainUtxo;
    }

    struct MovingFundsAuthorizationData {
        IP2TRWalletProposalValidator.MovingFundsProposal proposal;
        BitcoinTx.UTXO mainUtxo;
    }

    struct MovedFundsSweepAuthorizationData {
        IP2TRWalletProposalValidator.MovedFundsSweepProposal proposal;
        BitcoinTx.UTXO mainUtxo;
    }

    struct PreparedTransaction {
        uint8 action;
        bytes20 walletPubKeyHash;
        bytes32 walletID;
        bytes32 transactionHash;
        bytes32 snapshotHash;
        bytes32 resourceHash;
        bytes32 orderedInputRoot;
        bytes32 applyPlanHash;
        bytes32 applyPlanData1;
        bytes32 applyPlanData2;
        uint64 feeLimitSnapshot;
        uint64 transactionFee;
        uint16 feeUnits;
        uint64[] inputValues;
        bytes32[] signingKeys;
        bytes32[] resourceIDs;
    }

    /// @notice Fixed preview consumed before collecting the 51 seat
    ///         attestations. `transactionHash` is raw SHA256d bytes, matching
    ///         transaction serialization and Bridge outpoint byte order (it is
    ///         not explorer/RPC display-reversed).
    struct AuthorizationPreview {
        bytes32 reservationID;
        bytes32 transactionHash;
        bytes32 authorizationRoot;
        bytes32 digest;
        bytes20 walletPubKeyHash;
        bytes32 walletID;
        bytes32 membersIDsHash;
        bytes32 snapshotHash;
        bytes32 resourceHash;
        bytes32 orderedInputRoot;
        bytes32 applyPlanHash;
        bytes32 applyPlanData1;
        bytes32 applyPlanData2;
        uint64 feeLimitSnapshot;
        uint8 action;
    }

    struct DepositScratch {
        uint256 inputsCount;
        uint256 inputOffset;
        uint256 inputsTotalValue;
        uint256 depositsFound;
        bool mainFound;
        bytes32 stateHash;
        bytes32[] orderedInputResources;
        bool[] matchedDeposits;
    }

    struct RedemptionScratch {
        uint256 requestsCount;
        uint256 redeemableTotal;
        uint256 outputsTotal;
        uint256 feePerRequest;
        uint256 feeRemainder;
        bytes32 stateHash;
    }

    struct MovingFundsScratch {
        uint256 outputsCount;
        uint256 outputsTotalValue;
        bytes32 targetStateHash;
        uint64[] outputValues;
    }

    struct MovedFundsSweepScratch {
        bool mainExpected;
        uint256 requestKey;
        uint256 inputsTotal;
        bytes32[] orderedInputs;
    }

    function walletMainSlotResource(bytes32 walletID)
        internal
        pure
        returns (bytes32)
    {
        return P2TRReservation.walletMainSlotResource(walletID);
    }

    function outpointResource(bytes32 txHash, uint32 outputIndex)
        internal
        pure
        returns (bytes32)
    {
        return P2TRReservation.outpointResource(txHash, outputIndex);
    }

    function redemptionRequestResource(uint256 redemptionKey)
        internal
        pure
        returns (bytes32)
    {
        return P2TRReservation.redemptionRequestResource(redemptionKey);
    }

    function movedFundsRequestResource(uint256 requestKey)
        internal
        pure
        returns (bytes32)
    {
        return P2TRReservation.movedFundsRequestResource(requestKey);
    }

    /// @notice Recomputes and registers a previewed authorization. This is the
    ///         only write entry point and has no cancellation counterpart.
    function authorize(BridgeState.Storage storage self, bytes calldata payload)
        external
        returns (bytes memory result)
    {
        (
            uint8 action,
            BitcoinTx.Info memory transaction,
            bytes memory actionData,
            IP2TRAuthorizationRegistry.SeatAttestation memory attestation
        ) = abi.decode(
                payload,
                (
                    uint8,
                    BitcoinTx.Info,
                    bytes,
                    IP2TRAuthorizationRegistry.SeatAttestation
                )
            );
        PreparedTransaction memory prepared = _prepare(
            self,
            action,
            transaction,
            actionData
        );
        _canonicalizeResources(prepared);

        bytes32 membersIDsHash = keccak256(
            abi.encode(attestation.walletMembersIDs)
        );
        _reuseActiveReservationPlan(self, prepared, membersIDsHash);
        _requireFrozenFee(prepared);
        IP2TRAuthorizationRegistry.PreAuthorization
            memory authorization = IP2TRAuthorizationRegistry.PreAuthorization(
                prepared.action,
                prepared.walletPubKeyHash,
                prepared.walletID,
                membersIDsHash,
                prepared.snapshotHash,
                prepared.resourceHash,
                prepared.orderedInputRoot,
                prepared.applyPlanHash,
                prepared.applyPlanData1,
                prepared.applyPlanData2,
                prepared.feeLimitSnapshot
            );
        (bytes32 reservationID, bytes32 transactionHash) = P2TRAuthorization
            .registerPreAuthorizedTransaction(
                self.p2trFraudRouter,
                authorization,
                transaction,
                prepared.inputValues,
                prepared.signingKeys,
                prepared.resourceIDs,
                attestation
            );
        require(transactionHash == prepared.transactionHash);
        return abi.encode(reservationID, transactionHash);
    }

    /// @notice Returns the exact digest seats must attest. The write path
    ///         recomputes every field and rejects any intervening state change.
    function preview(BridgeState.Storage storage self, bytes calldata payload)
        external
        view
        returns (bytes memory encodedResult)
    {
        (
            uint8 action,
            BitcoinTx.Info memory transaction,
            bytes memory actionData,
            bytes32 membersIDsHash
        ) = abi.decode(payload, (uint8, BitcoinTx.Info, bytes, bytes32));
        require(membersIDsHash != bytes32(0));
        PreparedTransaction memory prepared = _prepare(
            self,
            action,
            transaction,
            actionData
        );
        _canonicalizeResources(prepared);
        _reuseActiveReservationPlan(self, prepared, membersIDsHash);
        _requireFrozenFee(prepared);

        IP2TRAuthorizationRegistry registry = IP2TRAuthorizationRegistry(
            _registry(self)
        );
        bytes32 authorizationRoot = P2TRAuthorizationRegistry(address(registry))
            .authorizationRoot(
                prepared.walletID,
                transaction,
                prepared.inputValues,
                prepared.signingKeys
            );
        IP2TRAuthorizationRegistry.PreAuthorization
            memory authorization = IP2TRAuthorizationRegistry.PreAuthorization(
                prepared.action,
                prepared.walletPubKeyHash,
                prepared.walletID,
                membersIDsHash,
                prepared.snapshotHash,
                prepared.resourceHash,
                prepared.orderedInputRoot,
                prepared.applyPlanHash,
                prepared.applyPlanData1,
                prepared.applyPlanData2,
                prepared.feeLimitSnapshot
            );
        P2TRAuthorizationRegistry concreteRegistry = P2TRAuthorizationRegistry(
            address(registry)
        );
        bytes32 id = concreteRegistry.reservationID(authorization);

        AuthorizationPreview memory result = AuthorizationPreview(
            id,
            prepared.transactionHash,
            authorizationRoot,
            concreteRegistry.preAuthorizationDigest(
                authorization,
                prepared.transactionHash,
                authorizationRoot
            ),
            prepared.walletPubKeyHash,
            prepared.walletID,
            membersIDsHash,
            prepared.snapshotHash,
            prepared.resourceHash,
            prepared.orderedInputRoot,
            prepared.applyPlanHash,
            prepared.applyPlanData1,
            prepared.applyPlanData2,
            prepared.feeLimitSnapshot,
            prepared.action
        );
        return abi.encode(result);
    }

    function hasActiveReservation(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash
    ) internal view returns (bool) {
        address registry = _registry(self);
        return
            registry != address(0) &&
            IP2TRAuthorizationRegistry(registry).hasActiveReservation(
                walletPubKeyHash
            );
    }

    function isResourceReserved(
        BridgeState.Storage storage self,
        bytes32 resourceID
    ) internal view returns (bool) {
        address registry = _registry(self);
        return
            registry != address(0) &&
            IP2TRAuthorizationRegistry(registry).isResourceReserved(resourceID);
    }

    function _prepare(
        BridgeState.Storage storage self,
        uint8 action,
        BitcoinTx.Info memory transaction,
        bytes memory actionData
    ) private view returns (PreparedTransaction memory prepared) {
        if (action == DepositSweepAction) {
            prepared = _prepareDepositSweep(
                self,
                transaction,
                abi.decode(actionData, (DepositSweepAuthorizationData))
            );
        } else if (action == RedemptionAction) {
            prepared = _prepareRedemption(
                self,
                transaction,
                abi.decode(actionData, (RedemptionAuthorizationData))
            );
        } else if (action == MovingFundsAction) {
            prepared = _prepareMovingFunds(
                self,
                transaction,
                abi.decode(actionData, (MovingFundsAuthorizationData))
            );
        } else if (action == MovedFundsSweepAction) {
            prepared = _prepareMovedFundsSweep(
                self,
                transaction,
                abi.decode(actionData, (MovedFundsSweepAuthorizationData))
            );
        } else {
            revert();
        }
    }

    function _prepareDepositSweep(
        BridgeState.Storage storage self,
        BitcoinTx.Info memory transaction,
        DepositSweepAuthorizationData memory data
    ) private view returns (PreparedTransaction memory prepared) {
        if (!hasActiveReservation(self, data.proposal.walletPubKeyHash)) {
            require(
                IP2TRWalletProposalValidator(_proposalValidator(self))
                    .validateTaprootDepositSweepProposal(
                        data.proposal,
                        data.depositsExtraInfo
                    )
            );
        }

        prepared.action = DepositSweepAction;
        prepared.walletPubKeyHash = data.proposal.walletPubKeyHash;
        prepared.walletID = _requireFrostWallet(
            self,
            prepared.walletPubKeyHash,
            false
        );
        prepared.transactionHash = BitcoinTx.validateInfoMemory(transaction);

        Wallets.Wallet storage wallet = self.registeredWallets[
            prepared.walletPubKeyHash
        ];
        bool mainExpected = wallet.mainUtxoHash != bytes32(0);
        if (mainExpected) {
            _requireMainUtxo(wallet.mainUtxoHash, data.mainUtxo);
        } else {
            _requireZeroUtxo(data.mainUtxo);
        }

        DepositScratch memory scratch;
        (uint256 compactSizeLength, uint256 inputsCount) = transaction
            .inputVector
            .parseVarInt();
        scratch.inputsCount = inputsCount;
        scratch.inputOffset = 1 + compactSizeLength;
        require(
            inputsCount ==
                data.proposal.depositsKeys.length + (mainExpected ? 1 : 0)
        );
        prepared.inputValues = new uint64[](inputsCount);
        prepared.signingKeys = new bytes32[](inputsCount);
        prepared.resourceIDs = new bytes32[](inputsCount + 1);
        scratch.orderedInputResources = new bytes32[](inputsCount);
        scratch.matchedDeposits = new bool[](data.proposal.depositsKeys.length);

        for (uint256 i = 0; i < inputsCount; i++) {
            _processDepositSweepInput(
                self,
                transaction.inputVector,
                data,
                prepared,
                scratch,
                i,
                mainExpected
            );
        }
        require(
            scratch.depositsFound == data.proposal.depositsKeys.length &&
                scratch.mainFound == mainExpected
        );

        (bytes20 outputWallet, uint64 outputValue) = DepositSweep
            .processDepositSweepTxOutput(self, transaction.outputVector);
        require(outputWallet == prepared.walletPubKeyHash);
        require(
            scratch.inputsTotalValue - outputValue == data.proposal.sweepTxFee
        );

        prepared.resourceIDs[inputsCount] = walletMainSlotResource(
            prepared.walletID
        );
        prepared.orderedInputRoot = keccak256(
            abi.encode(scratch.orderedInputResources)
        );
        prepared.snapshotHash = keccak256(
            abi.encode(
                SnapshotDomain,
                prepared.action,
                prepared.walletID,
                wallet.mainUtxoHash,
                wallet.state,
                keccak256(
                    abi.encode(
                        data.proposal.depositsKeys,
                        data.depositsExtraInfo
                    )
                ),
                scratch.stateHash
            )
        );
        prepared.feeLimitSnapshot = self.depositTxMaxFee;
        require(data.proposal.sweepTxFee <= type(uint64).max);
        prepared.transactionFee = uint64(data.proposal.sweepTxFee);
        require(data.proposal.depositsKeys.length <= type(uint16).max);
        prepared.feeUnits = uint16(data.proposal.depositsKeys.length);
        _setDepositApplyPlan(self, data, prepared);
    }

    function _prepareRedemption(
        BridgeState.Storage storage self,
        BitcoinTx.Info memory transaction,
        RedemptionAuthorizationData memory data
    ) private view returns (PreparedTransaction memory prepared) {
        if (!hasActiveReservation(self, data.proposal.walletPubKeyHash)) {
            require(
                IP2TRWalletProposalValidator(_proposalValidator(self))
                    .validateRedemptionProposal(data.proposal)
            );
        }
        prepared.action = RedemptionAction;
        prepared.walletPubKeyHash = data.proposal.walletPubKeyHash;
        prepared.walletID = _requireFrostWallet(
            self,
            prepared.walletPubKeyHash,
            false
        );
        prepared.transactionHash = BitcoinTx.validateInfoMemory(transaction);

        Wallets.Wallet storage wallet = self.registeredWallets[
            prepared.walletPubKeyHash
        ];
        _requireMainUtxo(wallet.mainUtxoHash, data.mainUtxo);
        _requireSingleInput(transaction.inputVector, data.mainUtxo);

        RedemptionScratch memory scratch;
        scratch.requestsCount = data.proposal.redeemersOutputScripts.length;
        (, uint256 outputsCount) = transaction.outputVector.parseVarInt();
        require(
            outputsCount == scratch.requestsCount ||
                outputsCount == scratch.requestsCount + 1
        );
        prepared.resourceIDs = new bytes32[](scratch.requestsCount + 2);
        prepared.resourceIDs[0] = walletMainSlotResource(prepared.walletID);
        prepared.resourceIDs[1] = outpointResource(
            data.mainUtxo.txHash,
            data.mainUtxo.txOutputIndex
        );

        scratch.feeRemainder =
            data.proposal.redemptionTxFee %
            scratch.requestsCount;
        scratch.feePerRequest =
            (data.proposal.redemptionTxFee - scratch.feeRemainder) /
            scratch.requestsCount;
        for (uint256 i = 0; i < scratch.requestsCount; i++) {
            _processRedemptionRequest(
                self,
                transaction.outputVector,
                data,
                prepared,
                scratch,
                i
            );
        }

        uint256 changeValue = uint256(data.mainUtxo.txOutputValue) -
            scratch.redeemableTotal;
        if (changeValue > 0) {
            require(outputsCount == scratch.requestsCount + 1);
            bytes memory changeOutput = transaction
                .outputVector
                .extractOutputAtIndex(scratch.requestsCount);
            require(
                changeOutput.extractValue() == changeValue &&
                    keccak256(changeOutput.slice(8, changeOutput.length - 8)) ==
                    keccak256(BitcoinTx.makeP2TRScript(prepared.walletID))
            );
            scratch.outputsTotal += changeValue;
        } else {
            require(outputsCount == scratch.requestsCount);
        }
        require(
            uint256(data.mainUtxo.txOutputValue) - scratch.outputsTotal ==
                data.proposal.redemptionTxFee
        );

        prepared.inputValues = new uint64[](1);
        prepared.inputValues[0] = data.mainUtxo.txOutputValue;
        prepared.signingKeys = new bytes32[](1);
        prepared.signingKeys[0] = prepared.walletID;
        bytes32[] memory orderedInputs = new bytes32[](1);
        orderedInputs[0] = prepared.resourceIDs[1];
        prepared.orderedInputRoot = keccak256(abi.encode(orderedInputs));
        prepared.snapshotHash = keccak256(
            abi.encode(
                SnapshotDomain,
                prepared.action,
                prepared.walletID,
                wallet.mainUtxoHash,
                wallet.pendingRedemptionsValue,
                wallet.state,
                keccak256(abi.encode(data.proposal.redeemersOutputScripts)),
                scratch.stateHash
            )
        );
        prepared.feeLimitSnapshot = self.redemptionTxMaxTotalFee;
        require(data.proposal.redemptionTxFee <= type(uint64).max);
        prepared.transactionFee = uint64(data.proposal.redemptionTxFee);
        prepared.applyPlanData1 = _packAddress(self.treasury);
        prepared.applyPlanHash = _applyPlanHash(prepared);
    }

    function _prepareMovingFunds(
        BridgeState.Storage storage self,
        BitcoinTx.Info memory transaction,
        MovingFundsAuthorizationData memory data
    ) private view returns (PreparedTransaction memory prepared) {
        if (!hasActiveReservation(self, data.proposal.walletPubKeyHash)) {
            require(
                IP2TRWalletProposalValidator(_proposalValidator(self))
                    .validateMovingFundsProposal(data.proposal, data.mainUtxo)
            );
        }
        prepared.action = MovingFundsAction;
        prepared.walletPubKeyHash = data.proposal.walletPubKeyHash;
        prepared.walletID = _requireFrostWallet(
            self,
            prepared.walletPubKeyHash,
            true
        );
        prepared.transactionHash = BitcoinTx.validateInfoMemory(transaction);

        Wallets.Wallet storage wallet = self.registeredWallets[
            prepared.walletPubKeyHash
        ];
        _requireMainUtxo(wallet.mainUtxoHash, data.mainUtxo);
        _requireSingleInput(transaction.inputVector, data.mainUtxo);
        MovingFundsScratch memory scratch;
        (, scratch.outputsCount) = transaction.outputVector.parseVarInt();
        require(scratch.outputsCount == data.proposal.targetWallets.length);

        prepared.resourceIDs = new bytes32[](scratch.outputsCount + 2);
        prepared.resourceIDs[0] = walletMainSlotResource(prepared.walletID);
        prepared.resourceIDs[1] = outpointResource(
            data.mainUtxo.txHash,
            data.mainUtxo.txOutputIndex
        );
        scratch.outputValues = new uint64[](scratch.outputsCount);
        for (uint256 i = 0; i < scratch.outputsCount; i++) {
            _processMovingFundsOutput(
                self,
                transaction.outputVector,
                data,
                prepared,
                scratch,
                i
            );
        }
        require(
            uint256(data.mainUtxo.txOutputValue) - scratch.outputsTotalValue ==
                data.proposal.movingFundsTxFee
        );
        uint256 remainder = scratch.outputsTotalValue % scratch.outputsCount;
        uint256 minValue = (scratch.outputsTotalValue - remainder) /
            scratch.outputsCount;
        uint256 maxValue = minValue + remainder;
        for (uint256 i = 0; i < scratch.outputsCount; i++) {
            require(
                scratch.outputValues[i] >= minValue &&
                    scratch.outputValues[i] <= maxValue
            );
        }

        prepared.inputValues = new uint64[](1);
        prepared.inputValues[0] = data.mainUtxo.txOutputValue;
        prepared.signingKeys = new bytes32[](1);
        prepared.signingKeys[0] = prepared.walletID;
        bytes32[] memory orderedInputs = new bytes32[](1);
        orderedInputs[0] = prepared.resourceIDs[1];
        prepared.orderedInputRoot = keccak256(abi.encode(orderedInputs));
        prepared.snapshotHash = keccak256(
            abi.encode(
                SnapshotDomain,
                prepared.action,
                prepared.walletID,
                wallet.mainUtxoHash,
                wallet.movingFundsTargetWalletsCommitmentHash,
                wallet.state,
                keccak256(abi.encodePacked(data.proposal.targetWallets)),
                scratch.targetStateHash
            )
        );
        prepared.feeLimitSnapshot = self.movingFundsTxMaxTotalFee;
        require(data.proposal.movingFundsTxFee <= type(uint64).max);
        prepared.transactionFee = uint64(data.proposal.movingFundsTxFee);
        prepared.applyPlanHash = _applyPlanHash(prepared);
    }

    function _prepareMovedFundsSweep(
        BridgeState.Storage storage self,
        BitcoinTx.Info memory transaction,
        MovedFundsSweepAuthorizationData memory data
    ) private view returns (PreparedTransaction memory prepared) {
        if (!hasActiveReservation(self, data.proposal.walletPubKeyHash)) {
            require(
                IP2TRWalletProposalValidator(_proposalValidator(self))
                    .validateMovedFundsSweepProposal(data.proposal)
            );
        }
        prepared.action = MovedFundsSweepAction;
        prepared.walletPubKeyHash = data.proposal.walletPubKeyHash;
        prepared.walletID = _requireFrostWallet(
            self,
            prepared.walletPubKeyHash,
            false
        );
        prepared.transactionHash = BitcoinTx.validateInfoMemory(transaction);
        Wallets.Wallet storage wallet = self.registeredWallets[
            prepared.walletPubKeyHash
        ];

        MovedFundsSweepScratch memory scratch;
        _prepareMovedFundsSweepInputs(
            self,
            transaction.inputVector,
            data,
            prepared,
            scratch
        );
        MovingFunds.MovedFundsSweepRequest storage request = self
            .movedFundsSweepRequests[scratch.requestKey];

        (bytes20 outputWallet, uint64 outputValue) = MovingFunds
            .processMovedFundsSweepTxOutput(self, transaction.outputVector);
        require(outputWallet == prepared.walletPubKeyHash);
        require(
            scratch.inputsTotal - outputValue ==
                data.proposal.movedFundsSweepTxFee
        );

        prepared.orderedInputRoot = keccak256(
            abi.encode(scratch.orderedInputs)
        );
        prepared.snapshotHash = keccak256(
            abi.encode(
                SnapshotDomain,
                prepared.action,
                prepared.walletID,
                wallet.mainUtxoHash,
                wallet.pendingMovedFundsSweepRequestsCount,
                wallet.state,
                scratch.requestKey,
                request.walletPubKeyHash,
                request.value,
                request.createdAt,
                request.state
            )
        );
        prepared.feeLimitSnapshot = self.movedFundsSweepTxMaxTotalFee;
        require(data.proposal.movedFundsSweepTxFee <= type(uint64).max);
        prepared.transactionFee = uint64(data.proposal.movedFundsSweepTxFee);
        prepared.applyPlanHash = _applyPlanHash(prepared);
    }

    function _canonicalizeResources(PreparedTransaction memory prepared)
        private
        pure
    {
        bytes32[] memory resources = prepared.resourceIDs;
        require(resources.length > 0);
        for (uint256 i = 1; i < resources.length; i++) {
            bytes32 current = resources[i];
            uint256 j = i;
            while (j > 0 && resources[j - 1] > current) {
                resources[j] = resources[j - 1];
                j--;
            }
            resources[j] = current;
        }
        for (uint256 i = 0; i < resources.length; i++) {
            require(resources[i] != bytes32(0));
            if (i > 0) {
                require(resources[i - 1] < resources[i]);
            }
        }
        prepared.resourceHash = keccak256(abi.encode(resources));
    }

    function _processDepositSweepInput(
        BridgeState.Storage storage self,
        bytes memory inputVector,
        DepositSweepAuthorizationData memory data,
        PreparedTransaction memory prepared,
        DepositScratch memory scratch,
        uint256 inputIndex,
        bool mainExpected
    ) private view {
        (
            bytes32 outpointTxHash,
            uint32 outpointIndex,
            uint256 inputLength
        ) = _parseInputAt(inputVector, scratch.inputOffset);
        bytes32 resource = outpointResource(outpointTxHash, outpointIndex);
        prepared.resourceIDs[inputIndex] = resource;
        scratch.orderedInputResources[inputIndex] = resource;

        if (
            mainExpected &&
            !scratch.mainFound &&
            data.mainUtxo.txHash == outpointTxHash &&
            data.mainUtxo.txOutputIndex == outpointIndex
        ) {
            scratch.mainFound = true;
            prepared.inputValues[inputIndex] = data.mainUtxo.txOutputValue;
            prepared.signingKeys[inputIndex] = prepared.walletID;
            scratch.inputsTotalValue += data.mainUtxo.txOutputValue;
        } else {
            uint256 depositIndex = _findDeposit(
                data.proposal.depositsKeys,
                scratch.matchedDeposits,
                outpointTxHash,
                outpointIndex
            );
            scratch.matchedDeposits[depositIndex] = true;
            scratch.depositsFound++;

            uint256 depositKey = uint256(
                keccak256(abi.encodePacked(outpointTxHash, outpointIndex))
            );
            Deposit.DepositRequest storage deposit = self.deposits[depositKey];
            bytes32 outputKey = self.taprootDepositOutputKeys[depositKey];
            require(outputKey != bytes32(0));
            require(
                self.taprootDepositOutputKeyCommitments[depositKey] ==
                    Deposit.taprootOutputKeyCommitment(
                        prepared.walletID,
                        outputKey
                    )
            );
            prepared.inputValues[inputIndex] = deposit.amount;
            prepared.signingKeys[inputIndex] = outputKey;
            scratch.inputsTotalValue += deposit.amount;
            scratch.stateHash = keccak256(
                abi.encode(
                    scratch.stateHash,
                    depositKey,
                    deposit.depositor,
                    deposit.amount,
                    deposit.revealedAt,
                    deposit.vault,
                    deposit.treasuryFee,
                    deposit.sweptAt,
                    deposit.extraData,
                    outputKey
                )
            );
        }
        scratch.inputOffset += inputLength;
    }

    function _processRedemptionRequest(
        BridgeState.Storage storage self,
        bytes memory outputVector,
        RedemptionAuthorizationData memory data,
        PreparedTransaction memory prepared,
        RedemptionScratch memory scratch,
        uint256 requestIndex
    ) private view {
        bytes memory script = data.proposal.redeemersOutputScripts[
            requestIndex
        ];
        uint256 redemptionKey = uint256(
            keccak256(
                abi.encodePacked(keccak256(script), prepared.walletPubKeyHash)
            )
        );
        Redemption.RedemptionRequest storage request = self.pendingRedemptions[
            redemptionKey
        ];
        uint256 requestFee = scratch.feePerRequest;
        if (requestIndex == scratch.requestsCount - 1) {
            requestFee += scratch.feeRemainder;
        }
        uint64 redeemable = request.requestedAmount - request.treasuryFee;
        uint64 expectedValue = uint64(uint256(redeemable) - requestFee);
        require(requestFee <= request.txMaxFee);
        bytes memory output = outputVector.extractOutputAtIndex(requestIndex);
        require(
            output.extractValue() == expectedValue &&
                keccak256(output.slice(8, output.length - 8)) ==
                keccak256(script)
        );
        scratch.redeemableTotal += redeemable;
        scratch.outputsTotal += expectedValue;
        scratch.stateHash = keccak256(
            abi.encode(
                scratch.stateHash,
                redemptionKey,
                request.redeemer,
                request.requestedAmount,
                request.treasuryFee,
                request.txMaxFee,
                request.requestedAt
            )
        );
        prepared.resourceIDs[requestIndex + 2] = redemptionRequestResource(
            redemptionKey
        );
    }

    function _processMovingFundsOutput(
        BridgeState.Storage storage self,
        bytes memory outputVector,
        MovingFundsAuthorizationData memory data,
        PreparedTransaction memory prepared,
        MovingFundsScratch memory scratch,
        uint256 outputIndex
    ) private view {
        bytes memory output = outputVector.extractOutputAtIndex(outputIndex);
        bytes20 target = BitcoinTx.extractWalletPubKeyHash(self, output);
        require(target == data.proposal.targetWallets[outputIndex]);
        scratch.outputValues[outputIndex] = output.extractValue();
        scratch.outputsTotalValue += scratch.outputValues[outputIndex];
        bytes32 targetWalletID = _walletID(self, target);
        prepared.resourceIDs[outputIndex + 2] = walletMainSlotResource(
            targetWalletID
        );
        Wallets.Wallet storage targetWallet = self.registeredWallets[target];
        scratch.targetStateHash = keccak256(
            abi.encode(
                scratch.targetStateHash,
                targetWalletID,
                targetWallet.mainUtxoHash,
                targetWallet.pendingMovedFundsSweepRequestsCount,
                targetWallet.state
            )
        );
    }

    function _prepareMovedFundsSweepInputs(
        BridgeState.Storage storage self,
        bytes memory inputVector,
        MovedFundsSweepAuthorizationData memory data,
        PreparedTransaction memory prepared,
        MovedFundsSweepScratch memory scratch
    ) private view {
        Wallets.Wallet storage wallet = self.registeredWallets[
            prepared.walletPubKeyHash
        ];
        scratch.mainExpected = wallet.mainUtxoHash != bytes32(0);
        if (scratch.mainExpected) {
            _requireMainUtxo(wallet.mainUtxoHash, data.mainUtxo);
        } else {
            _requireZeroUtxo(data.mainUtxo);
        }

        (uint256 compactSizeLength, uint256 inputsCount) = inputVector
            .parseVarInt();
        require(inputsCount == (scratch.mainExpected ? 2 : 1));
        uint256 inputOffset = 1 + compactSizeLength;
        (
            bytes32 firstHash,
            uint32 firstIndex,
            uint256 firstLength
        ) = _parseInputAt(inputVector, inputOffset);
        require(
            firstHash == data.proposal.movingFundsTxHash &&
                firstIndex == data.proposal.movingFundsTxOutputIndex
        );
        scratch.requestKey = uint256(
            keccak256(abi.encodePacked(firstHash, firstIndex))
        );
        MovingFunds.MovedFundsSweepRequest storage request = self
            .movedFundsSweepRequests[scratch.requestKey];

        prepared.inputValues = new uint64[](inputsCount);
        prepared.signingKeys = new bytes32[](inputsCount);
        prepared.inputValues[0] = request.value;
        prepared.signingKeys[0] = prepared.walletID;
        prepared.resourceIDs = new bytes32[](inputsCount + 2);
        prepared.resourceIDs[0] = movedFundsRequestResource(scratch.requestKey);
        prepared.resourceIDs[1] = walletMainSlotResource(prepared.walletID);
        scratch.orderedInputs = new bytes32[](inputsCount);
        prepared.resourceIDs[2] = outpointResource(firstHash, firstIndex);
        scratch.orderedInputs[0] = prepared.resourceIDs[2];
        scratch.inputsTotal = request.value;

        // Request state and the physical outpoint are both bound. The request
        // resource locks Bridge state; orderedInputs commits Bitcoin order.
        if (scratch.mainExpected) {
            (bytes32 mainHash, uint32 mainIndex, ) = _parseInputAt(
                inputVector,
                inputOffset + firstLength
            );
            require(
                mainHash == data.mainUtxo.txHash &&
                    mainIndex == data.mainUtxo.txOutputIndex
            );
            prepared.inputValues[1] = data.mainUtxo.txOutputValue;
            prepared.signingKeys[1] = prepared.walletID;
            prepared.resourceIDs[3] = outpointResource(mainHash, mainIndex);
            scratch.orderedInputs[1] = prepared.resourceIDs[3];
            scratch.inputsTotal += data.mainUtxo.txOutputValue;
        }
    }

    function _findDeposit(
        IP2TRWalletProposalValidator.DepositKey[] memory keys,
        bool[] memory matched,
        bytes32 outpointHash,
        uint32 outpointIndex
    ) private pure returns (uint256) {
        for (uint256 i = 0; i < keys.length; i++) {
            if (
                !matched[i] &&
                keys[i].fundingTxHash == outpointHash &&
                keys[i].fundingOutputIndex == outpointIndex
            ) {
                return i;
            }
        }
        revert();
    }

    function _requireSingleInput(
        bytes memory inputVector,
        BitcoinTx.UTXO memory expected
    ) private pure {
        (uint256 compactSizeLength, uint256 inputsCount) = inputVector
            .parseVarInt();
        require(inputsCount == 1);
        (bytes32 txHash, uint32 outputIndex, ) = _parseInputAt(
            inputVector,
            1 + compactSizeLength
        );
        require(
            txHash == expected.txHash && outputIndex == expected.txOutputIndex
        );
    }

    function _parseInputAt(bytes memory inputVector, uint256 offset)
        private
        pure
        returns (
            bytes32 outpointTxHash,
            uint32 outpointIndex,
            uint256 inputLength
        )
    {
        outpointTxHash = inputVector.extractInputTxIdLeAt(offset);
        outpointIndex = BTCUtils.reverseUint32(
            uint32(inputVector.extractTxIndexLeAt(offset))
        );
        inputLength = inputVector.determineInputLengthAt(offset);
    }

    function _requireMainUtxo(
        bytes32 expectedHash,
        BitcoinTx.UTXO memory mainUtxo
    ) private pure {
        require(expectedHash != bytes32(0));
        require(
            keccak256(
                abi.encodePacked(
                    mainUtxo.txHash,
                    mainUtxo.txOutputIndex,
                    mainUtxo.txOutputValue
                )
            ) == expectedHash
        );
    }

    function _requireZeroUtxo(BitcoinTx.UTXO memory mainUtxo) private pure {
        require(
            mainUtxo.txHash == bytes32(0) &&
                mainUtxo.txOutputIndex == 0 &&
                mainUtxo.txOutputValue == 0
        );
    }

    function _requireFrostWallet(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash,
        bool movingFundsOnly
    ) private view returns (bytes32 walletID) {
        walletID = self.walletIDByWalletPubKeyHash[walletPubKeyHash];
        require(walletID != bytes32(0));
        Wallets.Wallet storage wallet = self.registeredWallets[
            walletPubKeyHash
        ];
        require(wallet.ecdsaWalletID == bytes32(0));
        if (movingFundsOnly) {
            require(wallet.state == Wallets.WalletState.MovingFunds);
        } else {
            require(
                wallet.state == Wallets.WalletState.Live ||
                    wallet.state == Wallets.WalletState.MovingFunds
            );
        }
    }

    function _walletID(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash
    ) private view returns (bytes32) {
        bytes32 walletID = self.walletIDByWalletPubKeyHash[walletPubKeyHash];
        if (walletID != bytes32(0)) {
            return walletID;
        }
        return Wallets.deriveLegacyWalletID(walletPubKeyHash);
    }

    function _packAddress(address value) private pure returns (bytes32) {
        return bytes32(uint256(uint160(value)));
    }

    function _setDepositApplyPlan(
        BridgeState.Storage storage self,
        DepositSweepAuthorizationData memory data,
        PreparedTransaction memory prepared
    ) private view {
        IP2TRWalletProposalValidator.DepositKey memory firstDeposit = data
            .proposal
            .depositsKeys[0];
        uint256 depositKey = uint256(
            keccak256(
                abi.encodePacked(
                    firstDeposit.fundingTxHash,
                    firstDeposit.fundingOutputIndex
                )
            )
        );
        address vault = self.deposits[depositKey].vault;
        prepared.applyPlanData1 = _packAddressFlag(
            vault,
            vault != address(0) && self.isVaultTrusted[vault]
        );
        prepared.applyPlanData2 = _packAddress(self.treasury);
        prepared.applyPlanHash = _applyPlanHash(prepared);
    }

    function _packAddressFlag(address value, bool flag)
        private
        pure
        returns (bytes32)
    {
        return
            bytes32(uint256(uint160(value)) | (flag ? uint256(1) << 160 : 0));
    }

    function _applyPlanHash(PreparedTransaction memory prepared)
        private
        pure
        returns (bytes32)
    {
        return
            keccak256(
                abi.encode(
                    ApplyPlanDomain,
                    prepared.action,
                    prepared.transactionHash,
                    prepared.snapshotHash,
                    prepared.applyPlanData1,
                    prepared.applyPlanData2
                )
            );
    }

    function _reuseActiveReservationPlan(
        BridgeState.Storage storage self,
        PreparedTransaction memory prepared,
        bytes32 membersIDsHash
    ) private view {
        IP2TRAuthorizationRegistry registry = IP2TRAuthorizationRegistry(
            _registry(self)
        );
        bytes32 id = registry.activeReservation(prepared.walletPubKeyHash);
        if (id == bytes32(0)) return;

        (
            bytes32 walletID,
            bytes20 walletPubKeyHash,
            bytes32 storedMembersIDsHash,
            bytes32 snapshotHash,
            bytes32 resourceHash,
            bytes32 orderedInputRoot,
            bytes32 applyPlanData1,
            bytes32 applyPlanData2,
            uint64 feeLimitSnapshot,
            uint8 action,
            uint8 status
        ) = registry.getReservation(id);

        require(
            status == 1 &&
                walletID == prepared.walletID &&
                walletPubKeyHash == prepared.walletPubKeyHash &&
                storedMembersIDsHash == membersIDsHash &&
                snapshotHash == prepared.snapshotHash &&
                resourceHash == prepared.resourceHash &&
                orderedInputRoot == prepared.orderedInputRoot &&
                action == prepared.action
        );

        prepared.applyPlanData1 = applyPlanData1;
        prepared.applyPlanData2 = applyPlanData2;
        prepared.feeLimitSnapshot = feeLimitSnapshot;
        prepared.applyPlanHash = _applyPlanHash(prepared);
    }

    function _requireFrozenFee(PreparedTransaction memory prepared)
        private
        pure
    {
        uint256 maximumFee = prepared.feeLimitSnapshot;
        if (prepared.action == DepositSweepAction) {
            require(prepared.feeUnits != 0);
            maximumFee *= prepared.feeUnits;
        }
        require(prepared.transactionFee <= maximumFee);
    }

    function _proposalValidator(BridgeState.Storage storage self)
        private
        view
        returns (address)
    {
        address registry = _registry(self);
        require(registry != address(0));
        address validator = IP2TRAuthorizationRegistry(registry)
            .proposalValidator();
        require(validator != address(0));
        return validator;
    }

    function _registry(BridgeState.Storage storage self)
        internal
        view
        returns (address)
    {
        address router = self.p2trFraudRouter;
        if (router == address(0)) {
            return address(0);
        }
        return IP2TRAuthorizationRouter(router).authorizationRegistry();
    }
}
