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
interface IReservationBridge {
    /// @notice See `ReservationRouter.requestReservationAcceptance`.
    function requestReservationAcceptance(
        uint256 reservationKey,
        bytes20 walletPubKeyHash
    ) external;

    /// @notice See `ReservationRouter.requestReservedRedemption`.
    function requestReservedRedemption(
        uint256 reservationKey,
        address redeemer,
        bytes calldata redeemerOutputScript,
        bool feePaid,
        bool useRetryCredit
    ) external;

    /// @notice See `ReservationRouter.requestReservationReanchor`.
    function requestReservationReanchor(
        uint256 reservationKey,
        bytes20 targetWalletPubKeyHash
    ) external;

    /// @notice See `ReservationRouter.requestReservationDissolution`.
    function requestReservationDissolution(uint256 reservationKey) external;

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

    /// @notice See `ReservationRouter.extendReservation`.
    function extendReservation(uint256 reservationKey) external;

    /// @notice See `ReservationRouter.notifyReservedRedemptionVeto`.
    function notifyReservedRedemptionVeto(
        uint256 reservationKey,
        uint64 requestNonce
    ) external;

    /// @notice See `ReservationRouter.updateReservationParameters`.
    function updateReservationParameters(
        address reservationVault,
        uint64 reservationMinAmount,
        uint64 reservationTxMaxFee,
        uint32 reservationTermSeconds,
        uint32 reservationGracePeriod,
        uint64 reservationMaxTotalAmount,
        uint32 maxReservationsPerWallet,
        uint32 reservationActionTimeout
    ) external;

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
            uint32 reservationGracePeriod,
            uint64 reservationMaxTotalAmount,
            uint64 reservationTotalAmount,
            uint32 maxReservationsPerWallet,
            uint32 reservationActionTimeout
        );
}
