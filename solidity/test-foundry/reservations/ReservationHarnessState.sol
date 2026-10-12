// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import {BridgeState} from "../../contracts/bridge/BridgeState.sol";
import {Deposit} from "../../contracts/bridge/Deposit.sol";
import {Reservation} from "../../contracts/bridge/Reservation.sol";
import {Wallets} from "../../contracts/bridge/Wallets.sol";

/// @notice The Bridge storage the reservation harness acts on, its read
///         views, and the corruption hooks the property fire tests use.
abstract contract ReservationHarnessState {
    BridgeState.Storage internal state;

    function reservation(
        uint256 reservationKey
    ) external view returns (Reservation.ReservationRequest memory) {
        return state.reservations[reservationKey];
    }

    function action(
        uint256 reservationKey,
        uint64 requestNonce
    ) external view returns (Reservation.ReservationAction memory) {
        return
            state.reservationActions[
                Reservation.actionKey(reservationKey, requestNonce)
            ];
    }

    function deposit(
        uint256 depositKey
    ) external view returns (Deposit.DepositRequest memory) {
        return state.deposits[depositKey];
    }

    function pendingReservedDepositWallet(
        uint256 depositKey
    ) external view returns (bytes20) {
        return state.pendingReservedDeposit[depositKey].walletPubKeyHash;
    }

    function walletReservationInfo(
        bytes20 walletPubKeyHash
    ) external view returns (uint32 count, uint64 amount) {
        BridgeState.WalletReservationInfo storage info = state
            .walletReservationInfo[walletPubKeyHash];
        return (info.count, info.amount);
    }

    function walletState(
        bytes20 walletPubKeyHash
    ) external view returns (Wallets.WalletState) {
        return state.registeredWallets[walletPubKeyHash].state;
    }

    function totals()
        external
        view
        returns (
            uint32 activeReservationsCount,
            uint64 reservationTotalAmount,
            uint64 pendingReservedDeposits
        )
    {
        return (
            state.activeReservationsCount,
            state.reservationTotalAmount,
            state.pendingReservedDeposits
        );
    }

    function pendingThirdPartyReanchorHolds(
        bytes20 walletPubKeyHash
    ) external view returns (uint32) {
        return state.pendingThirdPartyReanchorHolds[walletPubKeyHash];
    }

    function reservationByAnchorUtxo(
        bytes32 anchorTxHash,
        uint32 outputIndex
    ) external view returns (uint256) {
        return
            state.reservationsByAnchorUtxo[
                uint256(keccak256(abi.encodePacked(anchorTxHash, outputIndex)))
            ];
    }

    function caps()
        external
        view
        returns (
            uint64 maxReservationsAmountPerWallet,
            uint64 reservationMaxSingleAmount,
            uint32 maxActiveReservations,
            uint32 maxThirdPartyReanchorHoldsPerWallet,
            uint64 reservationMaxTotalAmount,
            uint32 maxReservationsPerWallet
        )
    {
        return (
            state.maxReservationsAmountPerWallet,
            state.reservationMaxSingleAmount,
            state.maxActiveReservations,
            state.maxThirdPartyReanchorHoldsPerWallet,
            state.reservationMaxTotalAmount,
            state.maxReservationsPerWallet
        );
    }

    function parameters()
        external
        view
        returns (
            uint64 reservationMinAmount,
            uint64 reservationTxMaxFee,
            uint32 reservationActionTimeout
        )
    {
        return (
            state.reservationMinAmount,
            state.reservationTxMaxFee,
            state.reservationActionTimeout
        );
    }

    // ---------------------------------------------------------------------
    // Corruption hooks, used only to prove each property can fail. The
    // fuzz handler never calls them.
    // ---------------------------------------------------------------------

    function corruptTotals(uint32 activeCount, uint64 totalAmount) external {
        state.activeReservationsCount = activeCount;
        state.reservationTotalAmount = totalAmount;
    }

    function corruptWalletInfo(
        bytes20 walletPubKeyHash,
        uint32 count,
        uint64 amount
    ) external {
        state.walletReservationInfo[walletPubKeyHash].count = count;
        state.walletReservationInfo[walletPubKeyHash].amount = amount;
    }

    function corruptThirdPartyHolds(
        bytes20 walletPubKeyHash,
        uint32 holds
    ) external {
        state.pendingThirdPartyReanchorHolds[walletPubKeyHash] = holds;
    }

    function corruptPendingReservedDeposits(uint64 count) external {
        state.pendingReservedDeposits = count;
    }

    function corruptAnchorIndex(uint256 reservationKey) external {
        Reservation.ReservationRequest storage r = state.reservations[
            reservationKey
        ];
        delete state.reservationsByAnchorUtxo[
            uint256(
                keccak256(
                    abi.encodePacked(r.anchorTxHash, r.anchorTxOutputIndex)
                )
            )
        ];
    }

    function corruptActionState(
        uint256 reservationKey,
        uint64 requestNonce,
        Reservation.ActionState newState
    ) external {
        state
            .reservationActions[
                Reservation.actionKey(reservationKey, requestNonce)
            ]
            .state = newState;
    }
}
