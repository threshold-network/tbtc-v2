// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;
import "../bridge/BridgeState.sol";
import "../bridge/Deposit.sol";
import "../bridge/Reservation.sol";
import "../bridge/ReservationProofs.sol";
import "../bridge/Wallets.sol";
import "../bank/Bank.sol";
import {IWalletRegistry as EcdsaWalletRegistry} from "@keep-network/ecdsa/contracts/api/IWalletRegistry.sol";

/// @title Reservation stranding executor
/// @notice Helper contract exposing library functions from `Reservation.sol` and
///         `ReservationProofs.sol` for direct test-driven development and
///         coverage in isolation.
/// @dev This contract holds an isolated `BridgeState.Storage` reference, allowing
///      the library functions to run against local, pre-populated storage without
///      a full Bridge deployment. It provides forwarders to the library
///      functions and `seed*` helpers for pre-positioning storage state.
contract ReservationStrandingExecutor {
    using Reservation for BridgeState.Storage;
    using ReservationProofs for BridgeState.Storage;

    BridgeState.Storage internal self;

    // The library emits these events. They are redeclared here so the
    // executor's ABI carries the canonical signatures for the test
    // surface (filters and event parsing in Typechain / ethers).
    event ReservationStranded(
        uint256 indexed reservationKey,
        bytes20 indexed walletPubKeyHash,
        address indexed owner,
        uint64 anchorAmount
    );

    event ReservedDepositMarkedStale(uint256 indexed depositKey);

    event ReservationReanchorTimedOut(
        uint256 indexed reservationKey,
        uint64 requestNonce
    );
    event ReservationRedemptionTimedOut(
        uint256 indexed reservationKey,
        uint64 requestNonce
    );
    event ReservationDissolutionTimedOut(
        uint256 indexed reservationKey,
        uint64 requestNonce
    );
    event ReservationRetryCreditMinted(uint256 indexed reservationKey);

    /// @notice Forwards the `Reservation.notifyReservationStranded` library
    ///         function. Reverts with the library's exact message when the
    ///         reservation is not Active or the wallet is not Closing,
    ///         Closed, or Terminated.
    ///         "Wallet is not closing, closed or terminated" is the revert
    ///         message.
    function notifyReservationStranded(uint256 reservationKey) external {
        self.notifyReservationStranded(reservationKey);
    }

    /// @notice Forwards the `Reservation.notifyReservationActionTimeout`
    ///         library function (Reanchor timeout only).
    function notifyReservationActionTimeout(uint256 reservationKey) external {
        self.notifyReservationActionTimeout(reservationKey);
    }

    /// @notice Forwards `Reservation.notifyReservationRedemptionTimedOut`.
    ///         Reverts when the action is not a Redemption in the
    ///         `Pending` state, the reservation is not `ActionPending`, or
    ///         the snapshotted timeout has not yet elapsed.
    function notifyReservationRedemptionTimedOut(
        uint256 reservationKey,
        uint32[] calldata walletMembersIDs
    ) external {
        self.notifyReservationRedemptionTimedOut(
            reservationKey,
            walletMembersIDs
        );
    }

    /// @notice Forwards `Reservation.notifyReservationDissolutionTimedOut`.
    ///         Reverts when the action is not a Dissolution in the
    ///         `Pending` state, the reservation is not `ActionPending`, or
    ///         the snapshotted timeout has not yet elapsed.
    function notifyReservationDissolutionTimedOut(
        uint256 reservationKey,
        uint32[] calldata walletMembersIDs
    ) external {
        self.notifyReservationDissolutionTimedOut(
            reservationKey,
            walletMembersIDs
        );
    }

    function setBank(address bankAddress) external {
        self.bank = Bank(bankAddress);
    }

    function setEcdsaWalletRegistry(address registryAddress) external {
        self.ecdsaWalletRegistry = EcdsaWalletRegistry(registryAddress);
    }

    function submitReservationAcceptanceProof(
        BitcoinTx.Info calldata anchorTx,
        BitcoinTx.Proof calldata anchorProof,
        uint256 reservationKey,
        uint64 requestNonce
    ) external {
        self.submitReservationAcceptanceProof(
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
        self.submitReservationReanchorProof(
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
        self.notifyStaleReservedDeposit(depositKey);
    }

    function requestReservationAcceptance(
        uint256 reservationKey,
        bytes20 walletPubKeyHash
    ) external {
        self.requestReservationAcceptance(reservationKey, walletPubKeyHash);
    }

    function requestReservationReanchor(
        uint256 reservationKey,
        bytes20 targetWalletPubKeyHash,
        bool privileged
    ) external {
        self.requestReservationReanchor(
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
        Wallets.WalletState state
    ) external {
        Wallets.Wallet storage wallet = self.registeredWallets[
            walletPubKeyHash
        ];
        wallet.ecdsaWalletID = ecdsaWalletID;
        wallet.state = state;
        wallet.createdAt = uint32(block.timestamp); // solhint-disable-line not-rely-on-time
        if (state == Wallets.WalletState.Live) {
            self.liveWalletsCount++;
        }
    }

    /// @notice Seeds a wallet with a main UTXO hash, allowing moveFunds to route a Live wallet into MovingFunds.
    function seedWalletWithMainUtxo(
        bytes20 walletPubKeyHash,
        bytes32 ecdsaWalletID,
        Wallets.WalletState state,
        bytes32 mainUtxoHash
    ) external {
        Wallets.Wallet storage wallet = self.registeredWallets[
            walletPubKeyHash
        ];
        wallet.ecdsaWalletID = ecdsaWalletID;
        wallet.state = state;
        wallet.createdAt = uint32(block.timestamp); // solhint-disable-line not-rely-on-time
        wallet.mainUtxoHash = mainUtxoHash;
        if (state == Wallets.WalletState.Live) {
            self.liveWalletsCount++;
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
        Reservation.ReservationState state
    ) external {
        _seedReservation(
            reservationKey,
            owner,
            walletPubKeyHash,
            anchorAmount,
            anchorTxHash,
            anchorTxOutputIndex,
            state,
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
        Reservation.ReservationState state,
        uint64 requestNonce
    ) external {
        _seedReservation(
            reservationKey,
            owner,
            walletPubKeyHash,
            anchorAmount,
            anchorTxHash,
            anchorTxOutputIndex,
            state,
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
        Reservation.ReservationState state,
        uint64 requestNonce
    ) internal {
        Reservation.ReservationRequest storage reservation = self.reservations[
            reservationKey
        ];
        reservation.owner = owner;
        reservation.mintedAmount = anchorAmount;
        reservation.acceptedAt = uint32(block.timestamp); // solhint-disable-line not-rely-on-time
        reservation.walletPubKeyHash = walletPubKeyHash;
        reservation.anchorAmount = anchorAmount;
        reservation.anchorTxHash = anchorTxHash;
        reservation.anchorTxOutputIndex = anchorTxOutputIndex;
        reservation.state = state;
        reservation.requestNonce = requestNonce;
        reservation.expiresAt = uint32(block.timestamp) + 365 days; // solhint-disable-line not-rely-on-time
        reservation.dissolutionEligibleAt =
            uint32(block.timestamp) + // solhint-disable-line not-rely-on-time
            365 days +
            30 days;

        self.walletReservationKeys[walletPubKeyHash].push(reservationKey);
        self.walletReservationKeyIndex[reservationKey] = self
            .walletReservationKeys[walletPubKeyHash]
            .length;
        self.walletReservationsCount[walletPubKeyHash] += 1;
        self.walletReservationsAmount[walletPubKeyHash] += anchorAmount;
        self.reservationTotalAmount += anchorAmount;
        // `activeReservationsCount` is only ever freed by an acceptance
        // timeout or by `strandReservation` (see `Reservation.sol`); every
        // other state, including a normally-Closed reservation, still
        // occupies its slot. Mirror that here so tests seeding a
        // pre-Stranded reservation directly don't make `strandReservation`
        // underflow the counter on its unconditional decrement.
        if (state != Reservation.ReservationState.Stranded) {
            self.activeReservationsCount += 1;
        }

        self.reservationsByAnchorUtxo[
            uint256(
                keccak256(abi.encodePacked(anchorTxHash, anchorTxOutputIndex))
            )
        ] = reservationKey;
    }

    /// @notice Inserts a revealed-but-not-swept `DepositRequest`. Used by
    ///         `notifyStaleReservedDeposit` rejection paths that check
    ///         `sweptAt == 0`.
    function seedDeposit(uint256 depositKey, address depositor) external {
        Deposit.DepositRequest storage deposit = self.deposits[depositKey];
        deposit.depositor = depositor;
        deposit.amount = 1_000_000;
        deposit.revealedAt = uint32(block.timestamp); // solhint-disable-line not-rely-on-time
    }

    /// @notice Marks a revealed deposit as swept. Exercises the
    ///         "Deposit already swept" rejection path of
    ///         `notifyStaleReservedDeposit`.
    function seedSweptDeposit(uint256 depositKey) external {
        Deposit.DepositRequest storage deposit = self.deposits[depositKey];
        deposit.sweptAt = uint32(block.timestamp); // solhint-disable-line not-rely-on-time
    }

    /// @notice Inserts a pending reserved deposit with both the
    ///         reveal-ahead-validated and unvalidated shapes. The
    ///         `notifyStaleReservedDeposit` path branches on
    ///         `refundDeadlineValidated` so both shapes need coverage.
    function seedPendingReservedDeposit(
        uint256 depositKey,
        bytes20 walletPubKeyHash,
        uint32 refundDeadline,
        bool refundDeadlineValidated
    ) external {
        BridgeState.PendingReservedDeposit storage pending = self
            .pendingReservedDeposit[depositKey];
        pending.isReserved = true;
        pending.walletPubKeyHash = walletPubKeyHash;
        pending.refundDeadline = refundDeadline;
        pending.refundDeadlineValidated = refundDeadlineValidated;
        self.pendingReservedDeposits += 1;
    }

    /// @notice Inserts an `ActionState.Pending` reservation action so the
    ///         "Acceptance authorization pending" rejection path of
    ///         `notifyStaleReservedDeposit` fires.
    function seedPendingAction(uint256 reservationKey, uint64 requestNonce)
        external
    {
        Reservation.ReservationAction storage action = self.reservationActions[
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
        Reservation.ActionType actionType,
        Reservation.ActionState state
    ) external {
        Reservation.ReservationAction storage action = self.reservationActions[
            Reservation.actionKey(reservationKey, requestNonce)
        ];
        action.actionType = actionType;
        action.state = state;
    }

    function _seedPendingReservationAction(
        uint256 reservationKey,
        uint64 requestNonce,
        Reservation.ActionType actionType,
        bytes20 targetWalletPubKeyHash,
        uint64 amount,
        uint32 timeoutAt,
        bool feePaid,
        address redeemer,
        bool usedRetryCredit
    ) internal {
        Reservation.ReservationAction storage action = self.reservationActions[
            Reservation.actionKey(reservationKey, requestNonce)
        ];
        action.actionType = actionType;
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
        Reservation.ActionType actionType,
        bytes20 targetWalletPubKeyHash,
        uint64 amount,
        uint32 timeoutAt,
        bool feePaid,
        address redeemer
    ) external {
        _seedPendingReservationAction(
            reservationKey,
            requestNonce,
            actionType,
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
        Reservation.ActionType actionType,
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
            actionType,
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
        self.walletPendingDissolution[walletPubKeyHash] = reservationKey;
    }

    // --- read helpers used by tests ---------------------------------------

    function reservationState(uint256 reservationKey)
        external
        view
        returns (Reservation.ReservationState)
    {
        return self.reservations[reservationKey].state;
    }

    function retryCredit(uint256 reservationKey) external view returns (bool) {
        return self.reservations[reservationKey].retryCredit;
    }

    function reservationRetryCreditActionNonce(uint256 reservationKey)
        external
        view
        returns (uint64)
    {
        return self.reservationRetryCreditActionNonce[reservationKey];
    }

    function walletState(bytes20 walletPubKeyHash)
        external
        view
        returns (Wallets.WalletState)
    {
        return self.registeredWallets[walletPubKeyHash].state;
    }

    function walletPendingDissolution(bytes20 walletPubKeyHash)
        external
        view
        returns (uint256)
    {
        return self.walletPendingDissolution[walletPubKeyHash];
    }

    function walletReservationsCount(bytes20 walletPubKeyHash)
        external
        view
        returns (uint32)
    {
        return self.walletReservationsCount[walletPubKeyHash];
    }

    function walletReservationsAmount(bytes20 walletPubKeyHash)
        external
        view
        returns (uint64)
    {
        return self.walletReservationsAmount[walletPubKeyHash];
    }

    function reservationTotalAmount() external view returns (uint64) {
        return self.reservationTotalAmount;
    }

    function walletReservationKeysLength(bytes20 walletPubKeyHash)
        external
        view
        returns (uint256)
    {
        return self.walletReservationKeys[walletPubKeyHash].length;
    }

    function walletReservationKeyAt(bytes20 walletPubKeyHash, uint256 index)
        external
        view
        returns (uint256)
    {
        return self.walletReservationKeys[walletPubKeyHash][index];
    }

    function walletReservationKeyIndex(uint256 reservationKey)
        external
        view
        returns (uint256)
    {
        return self.walletReservationKeyIndex[reservationKey];
    }

    function reservationsByAnchorUtxo(bytes32 anchorUtxoHash)
        external
        view
        returns (uint256)
    {
        return self.reservationsByAnchorUtxo[uint256(anchorUtxoHash)];
    }

    function pendingReservedDepositWallet(uint256 depositKey)
        external
        view
        returns (bytes20)
    {
        return self.pendingReservedDeposit[depositKey].walletPubKeyHash;
    }

    function pendingReservedDepositDeadline(uint256 depositKey)
        external
        view
        returns (uint32)
    {
        return self.pendingReservedDeposit[depositKey].refundDeadline;
    }

    function pendingReservedDepositValidated(uint256 depositKey)
        external
        view
        returns (bool)
    {
        return self.pendingReservedDeposit[depositKey].refundDeadlineValidated;
    }

    function pendingReservedDeposits() external view returns (uint64) {
        return self.pendingReservedDeposits;
    }

    function actionState(uint256 reservationKey, uint64 requestNonce)
        external
        view
        returns (Reservation.ActionState)
    {
        return
            self
                .reservationActions[
                    Reservation.actionKey(reservationKey, requestNonce)
                ]
                .state;
    }
}
