// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import {BTCUtils} from "@keep-network/bitcoin-spv-sol/contracts/BTCUtils.sol";

import {Bank} from "../../contracts/bank/Bank.sol";
import {BitcoinTx} from "../../contracts/bridge/BitcoinTx.sol";
import {BridgeState} from "../../contracts/bridge/BridgeState.sol";
import {Deposit} from "../../contracts/bridge/Deposit.sol";
import {Reservation} from "../../contracts/bridge/Reservation.sol";
import {ReservationProofs} from "../../contracts/bridge/ReservationProofs.sol";
import {Wallets} from "../../contracts/bridge/Wallets.sol";
import {IReservationFeeFinancer} from "../../contracts/vault/IReservationFeeFinancer.sol";

import {ReservationHarnessState} from "./ReservationHarnessState.sol";

/// @notice Records the in-kind miner fees the re-anchor settlement finances.
contract FeeFinancerRecorder is IReservationFeeFinancer {
    uint256 public financedSat;

    function financeInKindFee(uint64 feeSat) external override {
        financedSat += feeSat;
    }
}

/// @notice Holds one `BridgeState.Storage` and drives the real `Reservation`
///         and `ReservationProofs` library code against it, so request,
///         timeout, settlement and stranding all act on the same state.
/// @dev Only two things are not production code paths:
///      - `revealReservedDeposit` writes the reveal-time records that
///        `Deposit.revealDeposit` produces for a deposit routed to the
///        reservation vault,
///      - the two `prove*` functions run the bodies of
///        `submitReservationAcceptanceProof` and
///        `submitReservationReanchorProof` without `validateProof`. The SPV
///        header and merkle check is not under test here; the transaction
///        input and output vectors are real and are parsed by the library.
///      Keep the `prove*` bodies in step with those two library functions.
contract ReservationInvariantHarness is ReservationHarnessState {
    using BitcoinTx for BridgeState.Storage;
    using BTCUtils for bytes;

    Bank public immutable bank;
    FeeFinancerRecorder public immutable feeVault;

    mapping(uint256 => bytes32) public fundingTxHashOf;

    constructor() {
        Bank newBank = new Bank();
        newBank.updateBridge(address(this));
        bank = newBank;
        state.bank = newBank;
        feeVault = new FeeFinancerRecorder();
    }

    // ---------------------------------------------------------------------
    // Setup that mirrors production writes outside the reservation library
    // ---------------------------------------------------------------------

    function registerLiveWallet(bytes20 walletPubKeyHash) external {
        state.registeredWallets[walletPubKeyHash].state = Wallets
            .WalletState
            .Live;
        state.liveWalletsCount += 1;
    }

    /// @dev Moves a wallet along its lifecycle. `Wallets` itself needs the
    ///      ECDSA registry and proofs for these transitions; the reservation
    ///      code reads only the resulting state.
    function setWalletState(
        bytes20 walletPubKeyHash,
        Wallets.WalletState newState
    ) external {
        Wallets.Wallet storage wallet = state.registeredWallets[
            walletPubKeyHash
        ];
        if (
            wallet.state == Wallets.WalletState.Live &&
            newState != Wallets.WalletState.Live
        ) {
            state.liveWalletsCount -= 1;
        }
        wallet.state = newState;
    }

    /// @dev The records `Deposit.revealDeposit` writes for a deposit routed
    ///      to the reservation vault.
    function revealReservedDeposit(
        bytes32 fundingTxHash,
        address depositor,
        uint64 amount,
        bytes20 walletPubKeyHash,
        uint32 refundDeadline
    ) external returns (uint256 depositKey) {
        depositKey = uint256(
            keccak256(abi.encodePacked(fundingTxHash, uint32(0)))
        );
        require(
            state.deposits[depositKey].revealedAt == 0,
            "Deposit already revealed"
        );
        fundingTxHashOf[depositKey] = fundingTxHash;

        state.deposits[depositKey] = Deposit.DepositRequest({
            depositor: depositor,
            amount: amount,
            /* solhint-disable-next-line not-rely-on-time */
            revealedAt: uint32(block.timestamp),
            vault: state.reservationVault,
            treasuryFee: 0,
            sweptAt: 0,
            extraData: bytes32(0)
        });
        state.pendingReservedDeposit[depositKey] = BridgeState
            .PendingReservedDeposit({
                isReserved: true,
                walletPubKeyHash: walletPubKeyHash,
                refundDeadline: refundDeadline,
                refundDeadlineValidated: true
            });
        state.pendingReservedDeposits += 1;
        state.reservations[depositKey].owner = depositor;
    }

    // ---------------------------------------------------------------------
    // Production library entry points
    // ---------------------------------------------------------------------

    function updateReservationCaps(
        uint64 maxReservationsAmountPerWallet,
        uint64 reservationMaxSingleAmount,
        uint32 maxActiveReservations,
        uint32 maxThirdPartyReanchorHoldsPerWallet
    ) external {
        Reservation.updateReservationCaps(
            state,
            maxReservationsAmountPerWallet,
            reservationMaxSingleAmount,
            maxActiveReservations,
            maxThirdPartyReanchorHoldsPerWallet
        );
    }

    function updateReservationParameters(
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
            address(feeVault),
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

    function notifyReservationAcceptanceTimedOut(
        uint256 reservationKey
    ) external {
        Reservation.notifyReservationAcceptanceTimedOut(state, reservationKey);
    }

    function requestReservationReanchor(
        uint256 reservationKey,
        bytes20 targetWalletPubKeyHash,
        bool privileged
    ) external {
        Reservation.requestReservationReanchor(
            state,
            reservationKey,
            targetWalletPubKeyHash,
            privileged,
            new uint32[](0),
            0
        );
    }

    function notifyReservationActionTimeout(uint256 reservationKey) external {
        Reservation.notifyReservationActionTimeout(state, reservationKey);
    }

    function notifyReservationStranded(uint256 reservationKey) external {
        Reservation.notifyReservationStranded(state, reservationKey);
    }

    function notifyStaleReservedDeposit(uint256 depositKey) external {
        Reservation.notifyStaleReservedDeposit(state, depositKey);
    }

    function forceStaleReservedDeposit(uint256 depositKey) external {
        Reservation.forceStaleReservedDeposit(state, depositKey);
    }

    function releaseReservedDepositToPool(uint256 depositKey) external {
        Reservation.releaseReservedDepositToPool(state, depositKey, address(0));
    }

    // ---------------------------------------------------------------------
    // Proof settlement without the SPV check
    // ---------------------------------------------------------------------

    /// @dev Body of `ReservationProofs.submitReservationAcceptanceProof`
    ///      with `validateProof` replaced by the given transaction hash.
    function proveAcceptance(
        uint256 reservationKey,
        uint64 requestNonce,
        bytes32 anchorTxHash,
        uint64 anchorAmount
    ) external returns (bool late) {
        Reservation.ReservationAction storage action;
        (action, late) = ReservationProofs.loadSettleableAction(
            state,
            reservationKey,
            requestNonce,
            Reservation.ActionType.Acceptance
        );
        require(
            state.reservations[reservationKey].state ==
                Reservation.ReservationState.Unknown,
            "Reservation already exists"
        );
        require(
            state.pendingReservedDeposit[reservationKey].isReserved,
            "Deposit was not revealed as reserved"
        );

        ReservationProofs.consumeAcceptedDeposit(
            state,
            singleInputVector(fundingTxHashOf[reservationKey], 0),
            reservationKey
        );
        uint64 provenAmount = ReservationProofs.validateAnchorOutput(
            state,
            singleP2WPKHOutputVector(
                anchorAmount,
                action.targetWalletPubKeyHash
            ),
            action
        );
        ReservationProofs.settleAcceptance(
            state,
            reservationKey,
            requestNonce,
            action,
            late,
            anchorTxHash,
            provenAmount
        );
    }

    /// @dev Body of `ReservationProofs.submitReservationReanchorProof` with
    ///      `validateProof` replaced by the given transaction hash.
    function proveReanchor(
        uint256 reservationKey,
        uint64 requestNonce,
        bytes32 reanchorTxHash,
        uint64 newAnchorAmount
    ) external returns (bool late) {
        Reservation.ReservationAction storage action;
        (action, late) = ReservationProofs.loadSettleableAction(
            state,
            reservationKey,
            requestNonce,
            Reservation.ActionType.Reanchor
        );
        Reservation.ReservationRequest storage reservation = state.reservations[
            reservationKey
        ];
        bool evidenceAlreadyEmitted =
            reservation.state == Reservation.ReservationState.Stranded;
        ReservationProofs.prepareReservationForSettlement(
            state,
            reservation,
            late
        );
        if (!late) {
            require(
                reservation.requestNonce == requestNonce,
                "Not the current generation"
            );
        }
        ReservationProofs.requireCurrentSourceAnchor(reservation, action);

        ReservationProofs.consumeAnchor(
            state,
            reservation,
            singleInputVector(
                reservation.anchorTxHash,
                reservation.anchorTxOutputIndex
            )
        );
        settleReanchor(
            reservationKey,
            action,
            late,
            evidenceAlreadyEmitted,
            reanchorTxHash,
            newAnchorAmount
        );
    }

    function settleReanchor(
        uint256 reservationKey,
        Reservation.ReservationAction storage action,
        bool late,
        bool evidenceAlreadyEmitted,
        bytes32 reanchorTxHash,
        uint64 newAnchorAmount
    ) internal {
        (
            bytes20 newWalletPubKeyHash,
            uint64 provenAmount
        ) = validateReanchorOutput(action, newAnchorAmount);
        Reservation.ReservationRequest storage reservation = state.reservations[
            reservationKey
        ];

        if (late) {
            state.walletReservationInfo[newWalletPubKeyHash].count += 1;
            state
                .walletReservationInfo[newWalletPubKeyHash]
                .amount += reservation.anchorAmount;
            if (
                reservation.state == Reservation.ReservationState.ActionPending
            ) {
                ReservationProofs.unwindPendingAction(
                    state,
                    reservation,
                    reservationKey,
                    true
                );
            }
        }

        uint64 minerFee = ReservationProofs.settleReanchorAccounting(
            state,
            reservation,
            reservationKey,
            newWalletPubKeyHash,
            provenAmount,
            reanchorTxHash
        );
        action.state = Reservation.ActionState.Settled;
        if (!late) {
            Reservation.releaseThirdPartyReanchorHold(
                state,
                action.targetWalletPubKeyHash,
                action.thirdPartyHold
            );
        }
        ReservationProofs.strandLateSettlementIfTargetWalletClosed(
            state,
            reservation,
            reservationKey,
            evidenceAlreadyEmitted
        );
        if (minerFee > 0) {
            IReservationFeeFinancer(state.deposits[reservationKey].vault)
                .financeInKindFee(minerFee);
        }
    }

    /// @dev The output checks of `submitReservationReanchorProof`.
    function validateReanchorOutput(
        Reservation.ReservationAction storage action,
        uint64 newAnchorAmount
    ) internal view returns (bytes20 newWalletPubKeyHash, uint64 provenAmount) {
        bytes memory output = ReservationProofs.parseSingleOutput(
            singleP2WPKHOutputVector(
                newAnchorAmount,
                action.targetWalletPubKeyHash
            )
        );
        newWalletPubKeyHash = state.extractPubKeyHash(output);
        provenAmount = output.extractValue();

        require(
            newWalletPubKeyHash == action.targetWalletPubKeyHash,
            "Output must pay the authorized target wallet"
        );
        require(
            action.amount - provenAmount <= action.txMaxFee,
            "Transaction fee is too high"
        );
        require(
            provenAmount > action.txMaxFee,
            "Re-anchor amount below the dust floor"
        );
    }

    // ---------------------------------------------------------------------
    // Bitcoin vector builders
    // ---------------------------------------------------------------------

    /// @dev One input spending `txHash:outputIndex`, empty script, final
    ///      sequence. The outpoint index is little-endian on the wire.
    function singleInputVector(
        bytes32 txHash,
        uint32 outputIndex
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                uint8(1),
                txHash,
                BTCUtils.reverseUint32(outputIndex),
                uint8(0),
                uint32(0xffffffff)
            );
    }

    /// @dev One P2WPKH output with a little-endian 8-byte value.
    function singleP2WPKHOutputVector(
        uint64 value,
        bytes20 walletPubKeyHash
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                uint8(1),
                reverseUint64(value),
                hex"160014",
                walletPubKeyHash
            );
    }

    function reverseUint64(uint64 value) internal pure returns (uint64 r) {
        for (uint256 i = 0; i < 8; i++) {
            r = (r << 8) | (value & 0xff);
            value >>= 8;
        }
    }
}
