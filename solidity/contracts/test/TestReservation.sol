// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../bridge/BridgeState.sol";
import "../bridge/Deposit.sol";
import "../bridge/Reservation.sol";
import "../bridge/ReservationProofs.sol";
import "../bridge/Wallets.sol";
import "../bridge/WalletProposalValidatorConstants.sol";
import "../bridge/BitcoinTx.sol";

/// @title TestReservation
/// @notice Test harness for the Reservation and ReservationProofs library
///         functions, exercised directly without pulling in the full
///         Bridge contract (and the external library linking that
///         requires).
/// @dev Stubs the reveal-side producer contract that milestone-2 reveal flow must implement:
///      1. When a deposit is revealed with `vault == reservationVault`, the producer records:
///         - `pendingReservedDeposit[key] = PendingReservedDeposit({ isReserved: true, walletPubKeyHash, refundDeadline, refundDeadlineValidated })`
///         - `pendingReservedDeposits += 1`
///         - `reservations[key].owner = depositor`
///         - `deposits[key] = DepositRequest({ depositor, amount, revealedAt, vault, treasuryFee: 0, sweptAt: 0, extraData })`
///      2. The producer validates that the deposit is routed to the configured reservation vault,
///         preserving the deposit's reveal-time refund deadline and designated wallet commitment
///         for downstream acceptance authorization and settlement checks.
contract TestReservation {
    BridgeState.Storage internal state;
    event ReservationAcceptanceRequested(
        uint256 indexed reservationKey,
        uint64 requestNonce,
        bytes20 indexed walletPubKeyHash,
        uint64 depositAmount,
        uint64 txMaxFee,
        uint32 timeoutAt
    );

    event ReservationStranded(
        uint256 indexed reservationKey,
        bytes20 indexed walletPubKeyHash,
        address indexed owner,
        uint64 anchorAmount
    );
    event ReservationCapsUpdated(
        uint64 maxReservationsAmountPerWallet,
        uint64 reservationMaxSingleAmount,
        uint32 maxActiveReservations
    );

    /// @notice Initialize a deposit reservation producer stub.
    /// @dev Sets up `pendingReservedDeposit`, increments `pendingReservedDeposits`,
    ///      and sets `reservations[key].owner`.
    function initializeProducerStub(
        uint256 reservationKey,
        bytes20 walletPubKeyHash,
        uint32 refundDeadline,
        address owner
    ) external {
        state.pendingReservedDeposit[reservationKey] = BridgeState
            .PendingReservedDeposit({
                isReserved: true,
                walletPubKeyHash: walletPubKeyHash,
                refundDeadline: refundDeadline,
                refundDeadlineValidated: true
            });
        state.pendingReservedDeposits += 1;
        state.reservations[reservationKey].owner = owner;
    }

    function setReservationVault(address vault) external {
        state.reservationVault = vault;
    }

    function setReservationMinAmount(uint64 amount) external {
        state.reservationMinAmount = amount;
    }

    function setReservationTxMaxFee(uint64 fee) external {
        state.reservationTxMaxFee = fee;
    }

    function setReservationActionTimeout(uint32 timeout) external {
        state.reservationActionTimeout = timeout;
    }

    function setReservationMaxSingleAmount(uint64 amount) external {
        state.reservationMaxSingleAmount = amount;
    }

    function setReservationMaxTotalAmount(uint64 amount) external {
        state.reservationMaxTotalAmount = amount;
    }

    function setMaxReservationsPerWallet(uint32 count) external {
        state.maxReservationsPerWallet = count;
    }

    function setMaxReservationsAmountPerWallet(uint64 amount) external {
        state.maxReservationsAmountPerWallet = amount;
    }

    function setMaxActiveReservations(uint32 count) external {
        state.maxActiveReservations = count;
    }

    function setReservationTotalAmount(uint64 amount) external {
        state.reservationTotalAmount = amount;
    }

    function setWalletReservationsCount(bytes20 walletPubKeyHash, uint32 count)
        external
    {
        state.walletReservationsCount[walletPubKeyHash] = count;
    }

    function setWalletReservationsAmount(
        bytes20 walletPubKeyHash,
        uint64 amount
    ) external {
        state.walletReservationsAmount[walletPubKeyHash] = amount;
    }

    function setActiveReservationsCount(uint32 count) external {
        state.activeReservationsCount = count;
    }

    function registerWallet(
        bytes20 walletPubKeyHash,
        Wallets.WalletState walletState
    ) external {
        /* solhint-disable-next-line not-rely-on-time */
        uint32 createdAt = uint32(block.timestamp);
        state.registeredWallets[walletPubKeyHash] = Wallets.Wallet({
            ecdsaWalletID: bytes32(0),
            mainUtxoHash: bytes32(0),
            pendingRedemptionsValue: 0,
            createdAt: createdAt,
            movingFundsRequestedAt: 0,
            closingStartedAt: 0,
            pendingMovedFundsSweepRequestsCount: 0,
            state: walletState,
            movingFundsTargetWalletsCommitmentHash: bytes32(0)
        });
    }

    function seedDeposit(
        uint256 reservationKey,
        address depositor,
        uint64 amount,
        address vault,
        uint32 revealedAt
    ) external {
        state.deposits[reservationKey] = Deposit.DepositRequest({
            depositor: depositor,
            amount: amount,
            revealedAt: revealedAt,
            vault: vault,
            treasuryFee: 0,
            sweptAt: 0,
            extraData: bytes32(0)
        });
    }

    function seedDepositFull(
        uint256 reservationKey,
        address depositor,
        uint64 amount,
        address vault,
        uint32 revealedAt,
        uint64 treasuryFee,
        uint32 sweptAt,
        bytes32 extraData
    ) external {
        state.deposits[reservationKey] = Deposit.DepositRequest({
            depositor: depositor,
            amount: amount,
            revealedAt: revealedAt,
            vault: vault,
            treasuryFee: treasuryFee,
            sweptAt: sweptAt,
            extraData: extraData
        });
    }

    function setSweptAt(uint256 reservationKey, uint32 sweptAt) external {
        state.deposits[reservationKey].sweptAt = sweptAt;
    }

    function setPendingReservedDeposit(
        uint256 reservationKey,
        BridgeState.PendingReservedDeposit calldata pendingDeposit
    ) external {
        state.pendingReservedDeposit[reservationKey] = pendingDeposit;
    }

    function setReservation(
        uint256 reservationKey,
        Reservation.ReservationRequest calldata reservation
    ) external {
        state.reservations[reservationKey] = reservation;
    }

    function setReservationState(
        uint256 reservationKey,
        Reservation.ReservationState reservationState
    ) external {
        state.reservations[reservationKey].state = reservationState;
    }

    function setReservationAnchorAmount(
        uint256 reservationKey,
        uint64 anchorAmount
    ) external {
        state.reservations[reservationKey].anchorAmount = anchorAmount;
    }

    function setReservationWalletPubKeyHash(
        uint256 reservationKey,
        bytes20 walletPubKeyHash
    ) external {
        state.reservations[reservationKey].walletPubKeyHash = walletPubKeyHash;
    }

    function setReservationAnchorUtxo(
        uint256 reservationKey,
        bytes32 anchorTxHash,
        uint32 anchorTxOutputIndex
    ) external {
        state.reservations[reservationKey].anchorTxHash = anchorTxHash;
        state
            .reservations[reservationKey]
            .anchorTxOutputIndex = anchorTxOutputIndex;
        uint256 utxoKey = uint256(
            keccak256(abi.encodePacked(anchorTxHash, anchorTxOutputIndex))
        );
        state.reservationsByAnchorUtxo[utxoKey] = reservationKey;
    }

    function setReservationAnchor(
        uint256 reservationKey,
        bytes32 anchorTxHash,
        uint32 anchorTxOutputIndex
    ) external {
        state.reservations[reservationKey].anchorTxHash = anchorTxHash;
        state.reservations[reservationKey].anchorTxOutputIndex = (
            anchorTxOutputIndex
        );
    }

    function setAction(
        uint256 reservationKey,
        uint64 requestNonce,
        Reservation.ReservationAction calldata action
    ) external {
        state.reservationActions[
            Reservation.actionKey(reservationKey, requestNonce)
        ] = action;
    }

    function requestReservationAcceptance(
        uint256 reservationKey,
        bytes20 walletPubKeyHash
    ) external {
        Reservation.requestReservationAcceptance(
            state,
            reservationKey,
            walletPubKeyHash
        );
    }

    function strandReservation(uint256 reservationKey) external {
        Reservation.strandReservation(
            state,
            state.reservations[reservationKey],
            reservationKey
        );
    }

    function notifyReservationStranded(uint256 reservationKey) external {
        Reservation.notifyReservationStranded(state, reservationKey);
    }

    function addWalletReservationKey(
        bytes20 walletPubKeyHash,
        uint256 reservationKey
    ) external {
        Reservation.addWalletReservationKey(
            state,
            walletPubKeyHash,
            reservationKey
        );
    }

    function removeWalletReservationKey(
        bytes20 walletPubKeyHash,
        uint256 reservationKey
    ) external {
        Reservation.removeWalletReservationKey(
            state,
            walletPubKeyHash,
            reservationKey
        );
    }

    function getReservation(uint256 reservationKey)
        external
        view
        returns (Reservation.ReservationRequest memory)
    {
        return state.reservations[reservationKey];
    }

    function getAction(uint256 reservationKey, uint64 requestNonce)
        external
        view
        returns (Reservation.ReservationAction memory)
    {
        return
            state.reservationActions[
                Reservation.actionKey(reservationKey, requestNonce)
            ];
    }

    function getPendingReservedDeposit(uint256 reservationKey)
        external
        view
        returns (BridgeState.PendingReservedDeposit memory)
    {
        return state.pendingReservedDeposit[reservationKey];
    }

    function getDeposit(uint256 reservationKey)
        external
        view
        returns (Deposit.DepositRequest memory)
    {
        return state.deposits[reservationKey];
    }

    function getWalletReservationKeys(bytes20 walletPubKeyHash)
        external
        view
        returns (uint256[] memory)
    {
        return state.walletReservationKeys[walletPubKeyHash];
    }

    function getWalletReservationKeyIndex(uint256 reservationKey)
        external
        view
        returns (uint256)
    {
        return state.walletReservationKeyIndex[reservationKey];
    }

    function walletReservationsCount(bytes20 walletPubKeyHash)
        external
        view
        returns (uint32)
    {
        return state.walletReservationsCount[walletPubKeyHash];
    }

    function walletReservationsAmount(bytes20 walletPubKeyHash)
        external
        view
        returns (uint64)
    {
        return state.walletReservationsAmount[walletPubKeyHash];
    }

    function reservationTotalAmount() external view returns (uint64) {
        return state.reservationTotalAmount;
    }

    function activeReservationsCount() external view returns (uint32) {
        return state.activeReservationsCount;
    }

    function pendingReservedDeposits() external view returns (uint64) {
        return state.pendingReservedDeposits;
    }

    /// @notice Returns the three fields the slot-capacity invariant relates.
    function caps()
        external
        view
        returns (
            uint64 reservationMaxTotalAmount,
            uint64 reservationMaxSingleAmount,
            uint32 maxActiveReservations
        )
    {
        reservationMaxTotalAmount = state.reservationMaxTotalAmount;
        reservationMaxSingleAmount = state.reservationMaxSingleAmount;
        maxActiveReservations = state.maxActiveReservations;
    }

    function getReservationByAnchorUtxo(
        bytes32 anchorTxHash,
        uint32 anchorTxOutputIndex
    ) external view returns (uint256) {
        uint256 utxoKey = uint256(
            keccak256(abi.encodePacked(anchorTxHash, anchorTxOutputIndex))
        );
        return state.reservationsByAnchorUtxo[utxoKey];
    }

    function registeredWallets(bytes20 walletPubKeyHash)
        external
        view
        returns (Wallets.Wallet memory)
    {
        return state.registeredWallets[walletPubKeyHash];
    }

    function actionKey(uint256 reservationKey, uint64 requestNonce)
        external
        pure
        returns (uint256)
    {
        return Reservation.actionKey(reservationKey, requestNonce);
    }

    function anchorUtxoHash(uint256 reservationKey)
        external
        view
        returns (bytes32)
    {
        return Reservation.anchorUtxoHash(state.reservations[reservationKey]);
    }

    function parseSingleOutput(bytes memory outputVector)
        external
        pure
        returns (bytes memory)
    {
        return ReservationProofs.parseSingleOutput(outputVector);
    }

    function validateAnchorOutput(
        bytes memory outputVector,
        bytes20 targetWalletPubKeyHash,
        uint64 amount,
        uint64 txMaxFee
    ) external returns (uint64 anchorAmount) {
        // A throwaway action record keyed by a fixed slot: each call sets
        // it fresh, so tests never see stale state from a prior call.
        Reservation.ReservationAction storage action = state.reservationActions[
            0
        ];
        action.targetWalletPubKeyHash = targetWalletPubKeyHash;
        action.amount = amount;
        action.txMaxFee = txMaxFee;

        return
            ReservationProofs.validateAnchorOutput(state, outputVector, action);
    }

    function setActionSourceAnchorUtxoHash(
        uint256 reservationKey,
        uint64 requestNonce,
        bytes32 sourceAnchorUtxoHash
    ) external {
        Reservation.ReservationAction storage action = state.reservationActions[
            Reservation.actionKey(reservationKey, requestNonce)
        ];
        action.sourceAnchorUtxoHash = sourceAnchorUtxoHash;
    }

    function requireCurrentSourceAnchor(
        uint256 reservationKey,
        uint64 requestNonce
    ) external view {
        Reservation.ReservationRequest storage reservation = state.reservations[
            reservationKey
        ];
        Reservation.ReservationAction storage action = state.reservationActions[
            Reservation.actionKey(reservationKey, requestNonce)
        ];
        ReservationProofs.requireCurrentSourceAnchor(reservation, action);
    }

    function setReservationFullState(
        uint256 reservationKey,
        address owner,
        bytes20 walletPubKeyHash,
        uint64 anchorAmount,
        Reservation.ReservationState newState,
        uint64 requestNonce
    ) external {
        Reservation.ReservationRequest storage reservation = state.reservations[
            reservationKey
        ];
        reservation.owner = owner;
        reservation.walletPubKeyHash = walletPubKeyHash;
        reservation.anchorAmount = anchorAmount;
        reservation.state = newState;
        reservation.requestNonce = requestNonce;
    }

    function setWalletState(
        bytes20 walletPubKeyHash,
        Wallets.WalletState newState
    ) external {
        state.registeredWallets[walletPubKeyHash].state = newState;
    }

    function strandLateSettlementIfTargetWalletClosed(
        uint256 reservationKey,
        bool evidenceAlreadyEmitted
    ) external {
        Reservation.ReservationRequest storage reservation = state.reservations[
            reservationKey
        ];
        ReservationProofs.strandLateSettlementIfTargetWalletClosed(
            state,
            reservation,
            reservationKey,
            evidenceAlreadyEmitted
        );
    }

    function strandIfTargetWalletClosed(
        uint256 reservationKey,
        bytes20 targetWalletPubKeyHash
    ) external {
        Reservation.ReservationRequest storage reservation = state.reservations[
            reservationKey
        ];
        ReservationProofs.strandIfTargetWalletClosed(
            state,
            reservation,
            reservationKey,
            targetWalletPubKeyHash
        );
    }

    function prepareReservationForSettlement(uint256 reservationKey, bool late)
        external
    {
        Reservation.ReservationRequest storage reservation = state.reservations[
            reservationKey
        ];
        ReservationProofs.prepareReservationForSettlement(
            state,
            reservation,
            late
        );
    }

    function setWalletReservationsCounters(
        bytes20 walletPubKeyHash,
        uint32 count,
        uint64 amount
    ) external {
        state.walletReservationsCount[walletPubKeyHash] = count;
        state.walletReservationsAmount[walletPubKeyHash] = amount;
    }

    function setGlobalReservationCounters(
        uint64 totalAmount,
        uint32 activeCount
    ) external {
        state.reservationTotalAmount = totalAmount;
        state.activeReservationsCount = activeCount;
    }

    function setGovernanceParameters(
        uint64 minAmount,
        uint64 txMaxFee,
        uint32 actionTimeout,
        uint32 maxReservationsPerWallet
    ) external {
        state.reservationMinAmount = minAmount;
        state.reservationTxMaxFee = txMaxFee;
        state.reservationActionTimeout = actionTimeout;
        state.maxReservationsPerWallet = maxReservationsPerWallet;
    }

    function updateReservationParameters(
        address reservationVault,
        uint64 reservationMinAmount,
        uint64 reservationTxMaxFee,
        uint32 reservationTermSeconds,
        uint32 reservationDissolutionDelay,
        uint64 reservationMaxTotalAmount,
        uint32 maxReservationsPerWallet,
        uint32 reservationActionTimeout,
        uint32 reservationRenewalWindowSeconds
    ) external {
        Reservation.updateReservationParameters(
            state,
            reservationVault,
            reservationMinAmount,
            reservationTxMaxFee,
            reservationTermSeconds,
            reservationDissolutionDelay,
            reservationMaxTotalAmount,
            maxReservationsPerWallet,
            reservationActionTimeout,
            reservationRenewalWindowSeconds
        );
    }

    function updateReservationCaps(
        uint64 maxReservationsAmountPerWallet,
        uint64 reservationMaxSingleAmount,
        uint32 maxActiveReservations
    ) external {
        Reservation.updateReservationCaps(
            state,
            maxReservationsAmountPerWallet,
            reservationMaxSingleAmount,
            maxActiveReservations
        );
    }

    function seedPendingReservedDeposit(
        uint256 depositKey,
        bool isReserved,
        bytes20 walletPubKeyHash,
        uint32 refundDeadline
    ) external {
        state.pendingReservedDeposit[depositKey] = BridgeState
            .PendingReservedDeposit(
                isReserved,
                walletPubKeyHash,
                refundDeadline,
                true
            );
    }

    function setDeposit(
        uint256 depositKey,
        address depositor,
        uint64 amount,
        uint32 revealedAt,
        address vault
    ) external {
        state.deposits[depositKey].depositor = depositor;
        state.deposits[depositKey].amount = amount;
        state.deposits[depositKey].revealedAt = revealedAt;
        state.deposits[depositKey].vault = vault;
    }

    function reservationState(uint256 reservationKey)
        external
        view
        returns (Reservation.ReservationState)
    {
        return state.reservations[reservationKey].state;
    }

    function setFullAction(
        uint256 reservationKey,
        uint64 requestNonce,
        Reservation.ActionType actionType,
        Reservation.ActionState newActionState,
        uint32 timeoutAt,
        bytes20 targetWalletPubKeyHash,
        uint64 amount
    ) external {
        Reservation.ReservationAction storage action = state.reservationActions[
            Reservation.actionKey(reservationKey, requestNonce)
        ];
        action.actionType = actionType;
        action.state = newActionState;
        action.timeoutAt = timeoutAt;
        action.targetWalletPubKeyHash = targetWalletPubKeyHash;
        action.amount = amount;
    }

    function actionState(uint256 reservationKey, uint64 requestNonce)
        external
        view
        returns (Reservation.ActionState)
    {
        return
            state
                .reservationActions[
                    Reservation.actionKey(reservationKey, requestNonce)
                ]
                .state;
    }

    function loadSettleableAction(
        uint256 reservationKey,
        uint64 requestNonce,
        Reservation.ActionType expectedType
    ) external view returns (bool late) {
        (, late) = ReservationProofs.loadSettleableAction(
            state,
            reservationKey,
            requestNonce,
            expectedType
        );
    }

    function notifyReservationActionTimeout(
        uint256 reservationKey,
        uint32[] calldata walletMembersIDs
    ) external {
        Reservation.notifyReservationActionTimeout(
            state,
            reservationKey,
            walletMembersIDs
        );
    }

    function notifyReservationAcceptanceTimedOut(uint256 reservationKey)
        external
    {
        Reservation.notifyReservationAcceptanceTimedOut(state, reservationKey);
    }

    function setSpentMainUtxo(uint256 reservationKey, bool spent) external {
        Reservation.ReservationRequest storage reservation = state.reservations[
            reservationKey
        ];
        uint256 anchorUtxoKey = uint256(
            keccak256(
                abi.encodePacked(
                    reservation.anchorTxHash,
                    reservation.anchorTxOutputIndex
                )
            )
        );
        state.spentMainUTXOs[anchorUtxoKey] = spent;
    }
}
