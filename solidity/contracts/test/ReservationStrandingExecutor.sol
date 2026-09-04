// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "./TestReservation.sol";
import "../bridge/BridgeState.sol";
import "../bridge/Deposit.sol";
import "../bridge/Reservation.sol";
import "../bridge/ReservationProofs.sol";
import "../bridge/Wallets.sol";
import "../bridge/BitcoinTx.sol";

/// @title Reservation stranding executor
/// @notice Helper contract exposing library functions from `Reservation.sol` and
///         `ReservationProofs.sol` for direct test-driven development and
///         coverage in isolation.
/// @dev Inherits `TestReservation` to reuse shared storage and forwarders, adding
///      stranding/reanchor-specific forwarders and seed helpers for test positioning.
contract ReservationStrandingExecutor is TestReservation {
    using Reservation for BridgeState.Storage;
    using ReservationProofs for BridgeState.Storage;

    // The library emits these events. They are redeclared here so the
    // executor's ABI carries the canonical signatures for the test
    // surface (filters and event parsing in Typechain / ethers).
    event ReservedDepositMarkedStale(uint256 indexed depositKey);

    event ReservationReanchorTimedOut(
        uint256 indexed reservationKey,
        uint64 requestNonce
    );
    event ReservationRetryCreditMinted(uint256 indexed reservationKey);

    function submitReservationAcceptanceProof(
        BitcoinTx.Info calldata anchorTx,
        BitcoinTx.Proof calldata anchorProof,
        uint256 reservationKey,
        uint64 requestNonce
    ) external {
        ReservationProofs.submitReservationAcceptanceProof(
            state,
            anchorTx,
            anchorProof,
            reservationKey,
            requestNonce
        );
    }

    function submitReservationReanchorProof(
        BitcoinTx.Info calldata reanchorTx,
        BitcoinTx.Proof calldata reanchorProof,
        uint256 reservationKey,
        uint64 requestNonce
    ) external {
        ReservationProofs.submitReservationReanchorProof(
            state,
            reanchorTx,
            reanchorProof,
            reservationKey,
            requestNonce
        );
    }

    /// @notice Forwards the `Reservation.notifyStaleReservedDeposit` library
    ///         function. Reverts with the library's exact message when the
    ///         deposit is not a pending reserved deposit, when the
    ///         deposit's refund deadline has not elapsed, when the deposit
    ///         is already swept, or when an acceptance authorization is
    ///         pending.
    function notifyStaleReservedDeposit(uint256 depositKey) external {
        Reservation.notifyStaleReservedDeposit(state, depositKey);
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
            privileged
        );
    }

    // --- seed helpers used by tests ---------------------------------------

    /// @notice Inserts a wallet in any state. Used to verify the
    ///         "Wallet is not closing, closed or terminated" rejection path.
    function seedWallet(
        bytes20 walletPubKeyHash,
        bytes32 ecdsaWalletID,
        Wallets.WalletState walletStateVal
    ) external {
        Wallets.Wallet storage wallet = state.registeredWallets[
            walletPubKeyHash
        ];
        wallet.ecdsaWalletID = ecdsaWalletID;
        wallet.state = walletStateVal;
        wallet.createdAt = uint32(block.timestamp); // solhint-disable-line not-rely-on-time
        if (walletStateVal == Wallets.WalletState.Live) {
            state.liveWalletsCount++;
        }
    }

    /// @notice Seeds a wallet with a main UTXO hash, allowing moveFunds to route a Live wallet into MovingFunds.
    function seedWalletWithMainUtxo(
        bytes20 walletPubKeyHash,
        bytes32 ecdsaWalletID,
        Wallets.WalletState walletStateVal,
        bytes32 mainUtxoHash
    ) external {
        Wallets.Wallet storage wallet = state.registeredWallets[
            walletPubKeyHash
        ];
        wallet.ecdsaWalletID = ecdsaWalletID;
        wallet.state = walletStateVal;
        wallet.createdAt = uint32(block.timestamp); // solhint-disable-line not-rely-on-time
        wallet.mainUtxoHash = mainUtxoHash;
        if (walletStateVal == Wallets.WalletState.Live) {
            state.liveWalletsCount++;
        }
    }

    /// @notice Inserts a `ReservationRequest` with full lifecycle metadata
    ///         so the stranding paths can locate their cross-reference
    ///         counters and emit the canonical recovery evidence.
    function seedReservation(
        uint256 reservationKey,
        address owner,
        bytes20 walletPubKeyHash,
        uint64 anchorAmount,
        bytes32 anchorTxHash,
        uint32 anchorTxOutputIndex,
        Reservation.ReservationState reservationStateVal
    ) external {
        _seedReservation(
            reservationKey,
            owner,
            walletPubKeyHash,
            anchorAmount,
            anchorTxHash,
            anchorTxOutputIndex,
            reservationStateVal,
            0
        );
    }

    /// @notice Inserts a `ReservationRequest` with full lifecycle metadata
    ///         and an explicit `requestNonce`.
    function seedReservationWithNonce(
        uint256 reservationKey,
        address owner,
        bytes20 walletPubKeyHash,
        uint64 anchorAmount,
        bytes32 anchorTxHash,
        uint32 anchorTxOutputIndex,
        Reservation.ReservationState reservationStateVal,
        uint64 requestNonce
    ) external {
        _seedReservation(
            reservationKey,
            owner,
            walletPubKeyHash,
            anchorAmount,
            anchorTxHash,
            anchorTxOutputIndex,
            reservationStateVal,
            requestNonce
        );
    }

    function _seedReservation(
        uint256 reservationKey,
        address owner,
        bytes20 walletPubKeyHash,
        uint64 anchorAmount,
        bytes32 anchorTxHash,
        uint32 anchorTxOutputIndex,
        Reservation.ReservationState reservationStateVal,
        uint64 requestNonce
    ) internal {
        Reservation.ReservationRequest storage reservation = state.reservations[
            reservationKey
        ];
        reservation.owner = owner;
        reservation.mintedAmount = anchorAmount;
        reservation.acceptedAt = uint32(block.timestamp); // solhint-disable-line not-rely-on-time
        reservation.walletPubKeyHash = walletPubKeyHash;
        reservation.anchorAmount = anchorAmount;
        reservation.anchorTxHash = anchorTxHash;
        reservation.anchorTxOutputIndex = anchorTxOutputIndex;
        reservation.state = reservationStateVal;
        reservation.requestNonce = requestNonce;
        reservation.expiresAt = uint32(block.timestamp) + 365 days; // solhint-disable-line not-rely-on-time
        reservation.dissolutionEligibleAt =
            uint32(block.timestamp) + // solhint-disable-line not-rely-on-time
            365 days +
            30 days;

        state.walletReservationKeys[walletPubKeyHash].push(reservationKey);
        state.walletReservationKeyIndex[reservationKey] = state
            .walletReservationKeys[walletPubKeyHash]
            .length;
        state.walletReservationInfo[walletPubKeyHash].count += 1;
        state.walletReservationInfo[walletPubKeyHash].amount += anchorAmount;
        state.reservationTotalAmount += anchorAmount;
        // `activeReservationsCount` is only ever freed by an acceptance
        // timeout or by `strandReservation` (see `Reservation.sol`); every
        // other state, including a normally-Closed reservation, still
        // occupies its slot. Mirror that here so tests seeding a
        // pre-Stranded reservation directly don't make `strandReservation`
        // underflow the counter on its unconditional decrement.
        if (reservationStateVal != Reservation.ReservationState.Stranded) {
            state.activeReservationsCount += 1;
        }

        state.reservationsByAnchorUtxo[
            uint256(
                keccak256(abi.encodePacked(anchorTxHash, anchorTxOutputIndex))
            )
        ] = reservationKey;
    }

    /// @notice Inserts a revealed-but-not-swept `DepositRequest`. Used by
    ///         `notifyStaleReservedDeposit` rejection paths that check
    ///         `sweptAt == 0`.
    /// @dev Named distinctly from the inherited `seedDeposit` (5-arg) so the
    ///      harness surface has no overloads (typechain emits overloaded
    ///      methods under quoted signature names only).
    function seedDepositBasic(uint256 depositKey, address depositor) external {
        Deposit.DepositRequest storage deposit = state.deposits[depositKey];
        deposit.depositor = depositor;
        deposit.amount = 1_000_000;
        deposit.revealedAt = uint32(block.timestamp); // solhint-disable-line not-rely-on-time
    }

    /// @notice Marks a revealed deposit as swept. Exercises the
    ///         "Deposit already swept" rejection path of
    ///         `notifyStaleReservedDeposit`.
    function seedSweptDeposit(uint256 depositKey) external {
        Deposit.DepositRequest storage deposit = state.deposits[depositKey];
        deposit.sweptAt = uint32(block.timestamp); // solhint-disable-line not-rely-on-time
    }

    /// @notice Inserts a pending reserved deposit with both the
    ///         reveal-ahead-validated and unvalidated shapes.
    ///         `refundDeadlineValidated` is reveal-time provenance metadata
    ///         only; `notifyStaleReservedDeposit` does not branch on it, but
    ///         both shapes are seeded here for parity with reveal-time state.
    // Named distinctly from the inherited `seedPendingReservedDeposit`
    // (uint256,bool,bytes20,uint32) so the harness surface has no overloads
    // (typechain emits overloaded methods under quoted signature names only).
    function seedPendingReservedDepositBasic(
        uint256 depositKey,
        bytes20 walletPubKeyHash,
        uint32 refundDeadline,
        bool refundDeadlineValidated
    ) external {
        BridgeState.PendingReservedDeposit storage pending = state
            .pendingReservedDeposit[depositKey];
        pending.isReserved = true;
        pending.walletPubKeyHash = walletPubKeyHash;
        pending.refundDeadline = refundDeadline;
        pending.refundDeadlineValidated = refundDeadlineValidated;
        state.pendingReservedDeposits += 1;
    }

    /// @notice Inserts an `ActionState.Pending` reservation action so the
    ///         "Acceptance authorization pending" rejection path of
    ///         `notifyStaleReservedDeposit` fires.
    function seedPendingAction(uint256 reservationKey, uint64 requestNonce)
        external
    {
        Reservation.ReservationAction storage action = state.reservationActions[
            Reservation.actionKey(reservationKey, requestNonce)
        ];
        action.actionType = Reservation.ActionType.Acceptance;
        action.state = Reservation.ActionState.Pending;
        action.requestedAt = uint32(block.timestamp); // solhint-disable-line not-rely-on-time
    }

    /// @notice Sets an existing reservation action's type and state directly,
    ///         used to seed a terminal (Settled, Vetoed, or Superseded)
    ///         ActionState so tests can exercise the "Action is not
    ///         settleable" rejection path in `loadSettleableAction`.
    function seedReservationActionState(
        uint256 reservationKey,
        uint64 requestNonce,
        Reservation.ActionType actionTypeVal,
        Reservation.ActionState actionStateVal
    ) external {
        Reservation.ReservationAction storage action = state.reservationActions[
            Reservation.actionKey(reservationKey, requestNonce)
        ];
        action.actionType = actionTypeVal;
        action.state = actionStateVal;
    }

    function _seedPendingReservationAction(
        uint256 reservationKey,
        uint64 requestNonce,
        Reservation.ActionType actionTypeVal,
        bytes20 targetWalletPubKeyHash,
        uint64 amount,
        uint32 timeoutAt,
        bool feePaid,
        address redeemer,
        bool usedRetryCredit
    ) internal {
        Reservation.ReservationAction storage action = state.reservationActions[
            Reservation.actionKey(reservationKey, requestNonce)
        ];
        action.actionType = actionTypeVal;
        action.state = Reservation.ActionState.Pending;
        /* solhint-disable-next-line not-rely-on-time */
        action.requestedAt = uint32(block.timestamp);
        action.timeoutAt = timeoutAt;
        action.targetWalletPubKeyHash = targetWalletPubKeyHash;
        action.amount = amount;
        action.feePaid = feePaid;
        action.redeemer = redeemer;
        action.usedRetryCredit = usedRetryCredit;
    }

    function seedPendingReservationAction(
        uint256 reservationKey,
        uint64 requestNonce,
        Reservation.ActionType actionTypeVal,
        bytes20 targetWalletPubKeyHash,
        uint64 amount,
        uint32 timeoutAt,
        bool feePaid,
        address redeemer
    ) external {
        _seedPendingReservationAction(
            reservationKey,
            requestNonce,
            actionTypeVal,
            targetWalletPubKeyHash,
            amount,
            timeoutAt,
            feePaid,
            redeemer,
            false
        );
    }

    function seedPendingReservationActionWithRetryCredit(
        uint256 reservationKey,
        uint64 requestNonce,
        Reservation.ActionType actionTypeVal,
        bytes20 targetWalletPubKeyHash,
        uint64 amount,
        uint32 timeoutAt,
        bool feePaid,
        address redeemer,
        bool usedRetryCredit
    ) external {
        _seedPendingReservationAction(
            reservationKey,
            requestNonce,
            actionTypeVal,
            targetWalletPubKeyHash,
            amount,
            timeoutAt,
            feePaid,
            redeemer,
            usedRetryCredit
        );
    }

    function seedWalletPendingDissolution(
        bytes20 walletPubKeyHash,
        uint256 reservationKey
    ) external {
        state.walletPendingDissolution[walletPubKeyHash] = reservationKey;
    }

    function seedReservationCooldown(
        uint256 reservationKey,
        uint32 cooldownUntil
    ) external {
        state
            .reservations[reservationKey]
            .reanchorCooldownUntil = cooldownUntil;
    }

    // --- read helpers used by tests ---------------------------------------

    function retryCredit(uint256 reservationKey) external view returns (bool) {
        return state.reservations[reservationKey].retryCredit;
    }

    function reservationRetryCreditActionNonce(uint256 reservationKey)
        external
        view
        returns (uint64)
    {
        return state.reservationRetryCreditActionNonce[reservationKey];
    }

    function walletPendingDissolution(bytes20 walletPubKeyHash)
        external
        view
        returns (uint256)
    {
        return state.walletPendingDissolution[walletPubKeyHash];
    }

    function pendingReservedDepositWallet(uint256 depositKey)
        external
        view
        returns (bytes20)
    {
        return state.pendingReservedDeposit[depositKey].walletPubKeyHash;
    }

    function pendingReservedDepositDeadline(uint256 depositKey)
        external
        view
        returns (uint32)
    {
        return state.pendingReservedDeposit[depositKey].refundDeadline;
    }

    function pendingReservedDepositValidated(uint256 depositKey)
        external
        view
        returns (bool)
    {
        return state.pendingReservedDeposit[depositKey].refundDeadlineValidated;
    }
}
