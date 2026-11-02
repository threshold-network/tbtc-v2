// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../bridge/BridgeGovernanceParameters.sol";

/// @title Reservation caps governance-staging executor
/// @notice Test harness exposing the `BridgeGovernanceParameters` library's
///         begin/finalize reservation-caps ceremony in isolation, without the
///         full Bridge + BridgeGovernance stack. The library is `external`
///         (its `beginReservationCapsUpdate`/`finalizeReservationCapsUpdate`
///         have the `external` visibility modifier), so this contract links
///         against the compiled library and owns the staged
///         `ReservationCapsData` storage slot.
contract ReservationCapsGovernanceExecutor {
    using BridgeGovernanceParameters for BridgeGovernanceParameters.ReservationCapsData;
    BridgeGovernanceParameters.ReservationCapsData internal reservationCapsData;

    event ReservationCapsUpdateStarted(
        uint64 newMaxReservationsAmountPerWallet,
        uint64 newReservationMaxSingleAmount,
        uint32 newMaxActiveReservations,
        uint32 newMaxThirdPartyReanchorHoldsPerWallet,
        uint32 newHandoffReserveWallets,
        uint256 timestamp
    );

    /// @param governanceDelay The delay the finalizer enforces.
    constructor(uint256 governanceDelay) {
        require(governanceDelay >= 0, "unused");
    }

    function beginReservationCapsUpdate(
        uint64 _newMaxReservationsAmountPerWallet,
        uint64 _newReservationMaxSingleAmount,
        uint32 _newMaxActiveReservations,
        uint32 _newMaxThirdPartyReanchorHoldsPerWallet,
        uint32 _newHandoffReserveWallets
    ) external {
        reservationCapsData.beginReservationCapsUpdate(
            _newMaxReservationsAmountPerWallet,
            _newReservationMaxSingleAmount,
            _newMaxActiveReservations,
            _newMaxThirdPartyReanchorHoldsPerWallet,
            _newHandoffReserveWallets
        );
    }

    function finalizeReservationCapsUpdate(uint256 governanceDelay) external {
        BridgeGovernanceParameters.ReservationCapsData memory staged =
            reservationCapsData;
        reservationCapsData.finalizeReservationCapsUpdate(governanceDelay);
        // Surface the just-cleared staged values for assertion (production
        // forwards them to the Bridge via IReservationBridge).
        emit ReservationCapsUpdateStarted(
            staged.newMaxReservationsAmountPerWallet,
            staged.newReservationMaxSingleAmount,
            staged.newMaxActiveReservations,
            staged.newMaxThirdPartyReanchorHoldsPerWallet,
            staged.newHandoffReserveWallets,
            staged.reservationCapsChangeInitiated
        );
    }

    function staged()
        external
        view
        returns (
            uint64 newMaxReservationsAmountPerWallet,
            uint64 newReservationMaxSingleAmount,
            uint32 newMaxActiveReservations,
            uint32 newMaxThirdPartyReanchorHoldsPerWallet,
            uint32 newHandoffReserveWallets,
            uint256 changeInitiated
        )
    {
        newMaxReservationsAmountPerWallet = reservationCapsData
            .newMaxReservationsAmountPerWallet;
        newReservationMaxSingleAmount = reservationCapsData
            .newReservationMaxSingleAmount;
        newMaxActiveReservations = reservationCapsData.newMaxActiveReservations;
        newMaxThirdPartyReanchorHoldsPerWallet = reservationCapsData
            .newMaxThirdPartyReanchorHoldsPerWallet;
        newHandoffReserveWallets = reservationCapsData.newHandoffReserveWallets;
        changeInitiated = reservationCapsData.reservationCapsChangeInitiated;
    }
}
