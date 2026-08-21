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

/// @notice Consumer-facing subset of the UTXO-reservation surface observable
///         at the Bridge address -- the functions `RedemptionWatchtower`,
///         `WalletProposalValidator` and `ReservationVault` need. The
///         functions listed here are implemented by the `ReservationRouter`
///         and reached through the Bridge's fallback via `delegatecall`, so
///         callers use this interface against the Bridge address itself --
///         the Bridge contract type does not declare them.
///
///         `BridgeGovernance` additionally needs the privileged
///         `updateReservationParameters` call; see
///         `IReservationBridgeGovernance`, which extends this interface
///         rather than widening it here, so consumers that only ever read
///         or exercise reservation lifecycle calls are not handed a type
///         that can also reach the governance-only mutator.
interface IReservationBridge {
    /// @notice See `ReservationRouter.requestReservedRedemption`.
    function requestReservedRedemption(
        uint256 reservationKey,
        address redeemer,
        bytes calldata redeemerOutputScript
    ) external;

    /// @notice See `ReservationRouter.extendReservation`.
    function extendReservation(uint256 reservationKey) external;

    /// @notice See `ReservationRouter.notifyReservedRedemptionVeto`.
    function notifyReservedRedemptionVeto(uint256 reservationKey) external;

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

    /// @notice See `ReservationRouter.reservationParameters`.
    function reservationParameters()
        external
        view
        returns (
            address reservationVault,
            uint64 reservationMinAmount,
            uint64 reservationTxMaxFee,
            uint64 reservationDissolutionTxMaxFee,
            uint32 reservationTermSeconds,
            uint32 reservationGracePeriod,
            uint64 reservationMaxTotalAmount,
            uint64 reservationTotalAmount,
            uint32 maxReservationsPerWallet,
            uint64 maxCumulativeReanchorFee
        );
}

/// @notice Wide, privileged extension of `IReservationBridge` used solely by
///         `BridgeGovernance`, which additionally needs to call the
///         governance-only `updateReservationParameters` mutator. Kept
///         separate from the narrow interface so `ReservationVault`,
///         `RedemptionWatchtower` and `WalletProposalValidator` are never
///         handed a handle that can also reach a governance-only mutator.
interface IReservationBridgeGovernance is IReservationBridge {
    /// @notice See `ReservationRouter.updateReservationParameters`.
    function updateReservationParameters(
        address reservationVault,
        uint64 reservationMinAmount,
        uint64 reservationTxMaxFee,
        uint64 reservationDissolutionTxMaxFee,
        uint32 reservationTermSeconds,
        uint32 reservationGracePeriod,
        uint64 reservationMaxTotalAmount,
        uint32 maxReservationsPerWallet,
        uint64 maxCumulativeReanchorFee
    ) external;
}
