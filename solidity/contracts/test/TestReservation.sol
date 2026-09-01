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

    function setDeposit(
        uint256 reservationKey,
        Deposit.DepositRequest calldata deposit
    ) external {
        state.deposits[reservationKey] = deposit;
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
            ReservationProofs.validateAnchorOutput(
                state,
                outputVector,
                action
            );
    }
}
