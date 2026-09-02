// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../bridge/BridgeState.sol";
import "../bridge/Reservation.sol";
import "../bridge/Wallets.sol";
import "../bridge/Deposit.sol";

/// @title Reservation test harness
/// @notice Exposes the Reservation library's governance setters and
///         externally-callable mutation sites without the router's
///         `onlyGovernance` guard, so the amount-cap vs slot-capacity
///         invariant and the activeReservationsCount lifecycle can be
///         unit-tested.
/// @dev Test-only, and deliberately minimal: it declares the storage anchor
///      and forwards, nothing else.
///
///      The accounting lives in the `Reservation` library, which is the only
///      unit reachable today. `ReservationRouter` cannot be exercised
///      standalone — its `governance` is unset by design, so every
///      state-changing entry point reverts — and the Bridge seams that wire
///      the router in arrive with the Bridge-integration PR. Retire this
///      stub once those seams exist and the mutation sites can be driven
///      through Bridge governance.
///
///      The three internal `ReservationProofs` sites
///      (`prepareReservationForSettlement`, `settleAcceptance`, and
///      `unwindPendingAction`) require a full SPV proof harness and are
///      covered with TODO markers in the test file rather than stubbed.
contract ReservationStub {
    using Reservation for BridgeState.Storage;

    BridgeState.Storage internal self;

    // Re-declaration of the library events so they appear in this stub's
    // ABI. Library events are not part of any contract ABI under solc 0.8.17,
    // but the underlying Reservation/ReservationProofs calls do emit them on
    // every state-changing write; re-declaring here lets the test harness
    // observe the emits with `.to.emit(stub, ...)`.
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

    // ---- Externally-callable Reservation mutation sites ----

    function requestReservationAcceptance(
        uint256 reservationKey,
        bytes20 walletPubKeyHash
    ) external {
        self.requestReservationAcceptance(reservationKey, walletPubKeyHash);
    }

    function notifyReservationActionTimeout(
        uint256 reservationKey,
        uint32[] calldata walletMembersIDs
    ) external {
        self.notifyReservationActionTimeout(reservationKey, walletMembersIDs);
    }

    function notifyReservationStranded(uint256 reservationKey) external {
        self.notifyReservationStranded(reservationKey);
    }

    // ---- Governance setters (bypass onlyGovernance) ----

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
        self.updateReservationParameters(
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
        self.updateReservationCaps(
            maxReservationsAmountPerWallet,
            reservationMaxSingleAmount,
            maxActiveReservations
        );
    }

    // ---- Getters ----

    function getActiveReservationsCount() external view returns (uint32) {
        return self.activeReservationsCount;
    }

    function getReservationState(uint256 reservationKey)
        external
        view
        returns (Reservation.ReservationState)
    {
        return self.reservations[reservationKey].state;
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
        reservationMaxTotalAmount = self.reservationMaxTotalAmount;
        reservationMaxSingleAmount = self.reservationMaxSingleAmount;
        maxActiveReservations = self.maxActiveReservations;
    }

    // ---- Storage seams for test setup ----

    function seedReservation(
        uint256 reservationKey,
        address owner,
        uint64 mintedAmount,
        uint32 acceptedAt,
        bytes20 walletPubKeyHash,
        Reservation.ReservationState state
    ) external {
        self.reservations[reservationKey] = Reservation.ReservationRequest({
            owner: owner,
            mintedAmount: mintedAmount,
            acceptedAt: acceptedAt,
            walletPubKeyHash: walletPubKeyHash,
            anchorAmount: mintedAmount,
            expiresAt: acceptedAt + 1000,
            anchorTxHash: bytes32(0),
            anchorTxOutputIndex: 0,
            state: state,
            requestNonce: 1,
            retryCredit: false,
            dissolutionEligibleAt: acceptedAt + 2000,
            cumulativeReanchorFee: 0
        });
    }

    function seedWalletState(
        bytes20 walletPubKeyHash,
        Wallets.WalletState state
    ) external {
        self.registeredWallets[walletPubKeyHash].state = state;
    }

    function seedDeposit(
        uint256 reservationKey,
        address depositor,
        uint64 amount,
        uint32 revealedAt,
        address vault
    ) external {
        self.deposits[reservationKey] = Deposit.DepositRequest({
            depositor: depositor,
            amount: amount,
            revealedAt: revealedAt,
            vault: vault,
            treasuryFee: 0,
            sweptAt: 0,
            extraData: bytes32(0)
        });
    }

    function seedPendingReservedDeposit(
        uint256 reservationKey,
        bool isReservedFlag,
        bytes20 walletPubKeyHash,
        uint32 refundDeadline,
        bool refundDeadlineValidated
    ) external {
        self.pendingReservedDeposit[reservationKey] = BridgeState
            .PendingReservedDeposit({
                isReserved: isReservedFlag,
                walletPubKeyHash: walletPubKeyHash,
                refundDeadline: refundDeadline,
                refundDeadlineValidated: refundDeadlineValidated
            });
    }

    function setMaxActiveReservations(uint32 maxActiveReservations) external {
        self.maxActiveReservations = maxActiveReservations;
    }

    function setReservationVault(address reservationVault) external {
        self.reservationVault = reservationVault;
    }

    function setActiveReservationsCount(uint32 count) external {
        self.activeReservationsCount = count;
    }

    function setReservationTotalAmount(uint64 amount) external {
        self.reservationTotalAmount = amount;
    }

    function setWalletReservationsCount(bytes20 walletPubKeyHash, uint32 count)
        external
    {
        self.walletReservationsCount[walletPubKeyHash] = count;
    }

    function setWalletReservationsAmount(
        bytes20 walletPubKeyHash,
        uint64 amount
    ) external {
        self.walletReservationsAmount[walletPubKeyHash] = amount;
    }
}
