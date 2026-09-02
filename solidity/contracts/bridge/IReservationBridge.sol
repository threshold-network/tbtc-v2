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

import "./Reservation.sol";

/// @notice Interface of the UTXO-reservation surface observable at the
///         Bridge address. The functions listed here are implemented by the
///         `ReservationRouter` and reached through the Bridge's fallback via
///         `delegatecall`, so callers use this interface against the Bridge
///         address itself — the Bridge contract type does not declare them.
/// @dev Milestone 1 trims the `#1094` interface: redemption, dissolution,
///      veto and renewal entry points are deferred. Adds the genuinely new
///      `activeReservationsCount` view.
interface IReservationBridge {
    /// @notice See `ReservationRouter.requestReservationAcceptance`.
    function requestReservationAcceptance(
        uint256 reservationKey,
        bytes20 walletPubKeyHash
    ) external;

    /// @notice See `ReservationRouter.requestReservationReanchor`.
    function requestReservationReanchor(
        uint256 reservationKey,
        bytes20 targetWalletPubKeyHash
    ) external;

    /// @notice See `ReservationRouter.submitReservationProof`.
    function submitReservationProof(
        uint8 proofType,
        BitcoinTx.Info calldata txInfo,
        BitcoinTx.Proof calldata proof,
        BitcoinTx.UTXO calldata mainUtxo,
        uint256 reservationKey,
        uint64 requestNonce
    ) external;

    /// @notice See `ReservationRouter.notifyReservationActionTimeout`.
    function notifyReservationActionTimeout(
        uint256 reservationKey,
        uint32[] calldata walletMembersIDs
    ) external;

    /// @notice See `ReservationRouter.updateReservationParameters`.
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
    ) external;

    /// @notice See `ReservationRouter.notifyStaleReservedDeposit`.
    function notifyStaleReservedDeposit(uint256 depositKey) external;

    /// @notice See `ReservationRouter.notifyReservationStranded`.
    function notifyReservationStranded(uint256 reservationKey) external;

    /// @notice See `ReservationRouter.updateReservationCaps`.
    function updateReservationCaps(
        uint64 maxReservationsAmountPerWallet,
        uint64 reservationMaxSingleAmount,
        uint32 maxActiveReservations
    ) external;

    /// @notice See `ReservationRouter.reservationCaps`.
    function reservationCaps()
        external
        view
        returns (
            uint64 maxReservationsAmountPerWallet,
            uint64 reservationMaxSingleAmount
        );

    /// @notice Bridge treasury address. Declared by the Bridge contract
    ///         itself (not the router); included here so reservation
    ///         consumers can use a single interface against the Bridge
    ///         address.
    function treasury() external view returns (address);

    /// @notice See `ReservationRouter.reservations`.
    function reservations(uint256 reservationKey)
        external
        view
        returns (Reservation.ReservationRequest memory);

    /// @notice See `ReservationRouter.reservationActions`.
    function reservationActions(uint256 reservationKey, uint64 requestNonce)
        external
        view
        returns (Reservation.ReservationAction memory);

    /// @notice See `ReservationRouter.reservationParameters`.
    function reservationParameters()
        external
        view
        returns (
            address reservationVault,
            uint64 reservationMinAmount,
            uint64 reservationTxMaxFee,
            uint32 reservationTermSeconds,
            uint32 reservationDissolutionDelay,
            uint64 reservationMaxTotalAmount,
            uint64 reservationTotalAmount,
            uint32 maxReservationsPerWallet,
            uint32 reservationActionTimeout,
            uint32 reservationRenewalWindowSeconds
        );

    /// @notice See `ReservationRouter.walletReservationsAmount`.
    function walletReservationsAmount(bytes20 walletPubKeyHash)
        external
        view
        returns (uint64);

    /// @notice See `ReservationRouter.walletReservationsCount`.
    function walletReservationsCount(bytes20 walletPubKeyHash)
        external
        view
        returns (uint32);

    /// @notice See `ReservationRouter.walletReservations`.
    function walletReservations(bytes20 walletPubKeyHash)
        external
        view
        returns (uint256[] memory);

    /// @notice See `ReservationRouter.reservationByAnchorUtxo`.
    function reservationByAnchorUtxo(
        bytes32 anchorTxHash,
        uint32 anchorTxOutputIndex
    ) external view returns (uint256);

    /// @notice See `ReservationRouter.reservedDepositWallet`.
    function reservedDepositWallet(uint256 depositKey)
        external
        view
        returns (bytes20);

    /// @notice See `ReservationRouter.pendingReservedDeposits`.
    function pendingReservedDeposits() external view returns (uint64);

    /// @notice See `ReservationRouter.activeReservationsCount`.
    function activeReservationsCount()
        external
        view
        returns (uint32 count, uint32 maxActive);

    /// @notice See `ReservationRouter.reservationRouter`.
    function reservationRouter() external view returns (address);
}
