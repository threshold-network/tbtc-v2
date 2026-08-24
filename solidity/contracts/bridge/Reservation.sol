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

import "./BitcoinTx.sol";
import "./BridgeState.sol";
import "./Deposit.sol";
import "./ReservationProofs.sol";
import "./Wallets.sol";
import "./WalletProposalValidatorConstants.sol";

/// @title Bridge UTXO reservations — control plane
/// @notice The library handles the request/authorization side of UTXO
///         reservations: deposits custodied without ever being commingled
///         with the pooled supply and returned in-kind — with an unbroken
///         1-input-1-output lineage — upon redemption. The SPV settlement
///         side lives in the `ReservationProofs` companion library.
/// @dev Every Bitcoin action of a reservation's life — the acceptance
///      anchor, an in-kind redemption, a re-anchor to another wallet, and
///      the post-term dissolution — follows a *two-phase,
///      authorize-then-prove* model (see RFC 13):
///
///      1. An explicit *request* increments the position's monotonic
///         request nonce, performs every capacity and lifecycle check and
///         *reserves* what it checks, and *snapshots* every proof- and
///         settlement-critical parameter into a per-generation
///         `ReservationAction` record keyed by `(reservationKey, nonce)`.
///         A wallet signs only requested (and, for redemptions,
///         watchtower-authorized) generations, and nothing that changes
///         after the request can make the signed transaction unprovable.
///
///      2. The SPV *proof* settles the generation against the record's
///         snapshots — never against live parameters. A generation that
///         times out leaves a terminal record that still accepts a late
///         proof (closing the anchor lineage without a second refund); a
///         generation vetoed by the redemption watchtower never accepts a
///         proof, leaving an early-signing wallet exposed to the fraud
///         machinery — the intended consequence of signing an unauthorized
///         action.
///
///      Claim accounting: the amount credited (`mintedAmount`) is the gross
///      anchor output value. All protocol fees are charged by the
///      reservation vault as explicit transfers; Bitcoin miner fees are the
///      only in-kind deductions.
library Reservation {
    /// @notice Hard protocol bounds on the custody term length. The
    ///         governable term must stay within them; they bound the
    ///         maximum owner lookahead (one term plus the renewal window)
    ///         and keep the carry economics of a term meaningful.
    uint32 internal constant MIN_RESERVATION_TERM = 90 days;
    uint32 internal constant MAX_RESERVATION_TERM = 730 days;

    /// @notice Represents the state of a reservation position.
    enum ReservationState {
        /// @dev The reservation is unknown to the Bridge. Acceptance
        ///      requests are made against positions in this state.
        Unknown,
        /// @dev The reservation was accepted (anchor proven, balance
        ///      credited) and its anchor outpoint is under wallet custody,
        ///      with no action in flight.
        Active,
        /// @dev An action (redemption, re-anchor or dissolution) has been
        ///      requested for the position and is not yet settled. The
        ///      pending action record is
        ///      `reservationActions[actionKey(reservationKey, requestNonce)]`.
        ActionPending,
        /// @dev The reservation was closed: redeemed in-kind, dissolved
        ///      into the wallet's main UTXO, or settled late after a
        ///      timeout.
        Closed,
        /// @dev The custodying wallet was terminated while the anchor was
        ///      outstanding. The owner's minted balance remains an ordinary
        ///      pooled claim; the anchor is no longer tracked unless a
        ///      previously timed-out generation later settles against it.
        Stranded
    }

    /// @notice Type of a reservation action generation.
    enum ActionType {
        None,
        Acceptance,
        Redemption,
        Reanchor,
        Dissolution
    }

    /// @notice Settlement state of a reservation action generation.
    enum ActionState {
        /// @dev No action was ever requested under this key.
        Unknown,
        /// @dev The action is requested and awaiting its SPV proof. For
        ///      redemptions, the wallet may only sign once the watchtower
        ///      delay has elapsed without a veto; the proof path enforces
        ///      this.
        Pending,
        /// @dev The action was proven and settled.
        Settled,
        /// @dev The action timed out. Terminal for the generation, but a
        ///      late proof of the (already confirmed) Bitcoin transaction
        ///      is still accepted against this record: it closes the anchor
        ///      lineage and marks the consumed outpoints as honestly spent,
        ///      without repeating the refund performed at timeout.
        TimedOut,
        /// @dev The action was vetoed by the redemption watchtower.
        ///      Terminal; a proof against this generation is rejected
        ///      forever.
        Vetoed,
        /// @dev The action's anchor was consumed by a late settlement of an
        ///      older timed-out generation. Terminal; the escrowed claim
        ///      was refunded during the late settlement.
        Superseded
    }

    /// @notice Represents a UTXO reservation position.
    struct ReservationRequest {
        // The reservation owner holding the in-kind redemption right. Set
        // to the deposit's depositor at acceptance time.
        address owner;
        // Gross amount in satoshi credited to the owner via the reservation
        // vault at acceptance time. This is the amount that must be
        // surrendered and burned when the reservation is redeemed in-kind.
        uint64 mintedAmount;
        // UNIX timestamp the reservation was accepted at.
        // XXX: Unsigned 32-bit int unix seconds, will break February 7th 2106.
        uint32 acceptedAt;
        // 20-byte public key hash of the wallet custodying the current
        // anchor outpoint.
        bytes20 walletPubKeyHash;
        // Value in satoshi of the current anchor outpoint. Starts equal to
        // `mintedAmount` and decreases by the Bitcoin miner fee on each
        // re-anchor hop.
        uint64 anchorAmount;
        // UNIX timestamp the custody term expires at. Purely a contract
        // layer fact -- the anchor output carries no timelock.
        // XXX: Unsigned 32-bit int unix seconds, will break February 7th 2106.
        uint32 expiresAt;
        // Hash of the Bitcoin transaction holding the current anchor output.
        bytes32 anchorTxHash;
        // Output index of the current anchor output. Always 0 given anchor
        // transactions have a single output; kept for auditability.
        uint32 anchorTxOutputIndex;
        // Current state of the reservation position.
        ReservationState state;
        // Monotonic generation counter. Incremented by every action
        // request (including acceptance requests); all action state is
        // keyed by `(reservationKey, requestNonce)` so a stale generation
        // can never be confused with a newer one.
        uint64 requestNonce;
        // True when the owner holds a single-use, fee-free redemption
        // retry entitlement, minted when a fee-paid redemption request
        // times out through the wallet's fault. The source generation is
        // stored separately and binds partial retries to its exact amount
        // and whole retries to no more than its original full claim. It is
        // returned if a late re-anchor or partial redemption supersedes the
        // retry that consumed it while leaving the reservation open. A late
        // partial settlement retires the entitlement when it settles that
        // entitlement's source generation. Consumed by the next strictly
        // pre-expiry retry request; voided by a dissolution request.
        bool retryCredit;
        // UNIX timestamp the reservation becomes dissolvable at. Set to
        // `expiresAt + reservationDissolutionDelay` whenever a term is
        // granted (acceptance and each renewal), using the delay value
        // current at that moment — later governance changes never move
        // the eligibility time of a term already granted.
        // XXX: Unsigned 32-bit int unix seconds, will break February 7th 2106.
        uint32 dissolutionEligibleAt;
        // Cumulative satoshi lost to Bitcoin miner fees across all
        // re-anchor hops of this reservation. Written on every re-anchor
        // settlement but never read in milestone 1: no ceiling is enforced
        // yet, and a structural bound is deferred to post-milestone-1
        // work. It is written from milestone 1 because the re-anchor
        // settlement path writes the claim down on every hop, so the
        // original anchor value is not recoverable afterwards and this
        // total cannot be reconstructed from later state — the
        // `ReservationReanchored` event carries only the new anchor
        // amount, not the per-hop delta. Accumulating now means a
        // post-milestone-1 cap reads the true lifetime total instead of
        // only post-upgrade hops. A position field a later milestone reads
        // cannot be added while reservations are live.
        // Appended to the end of the struct so the existing field layout
        // is unchanged.
        uint64 cumulativeReanchorFee;
        // This struct doesn't contain `__gap` property as the structure is
        // stored in a mapping, mappings store values in different slots and
        // they are not contiguous with other values.
    }

    /// @notice Represents one requested generation of a reservation action.
    ///         All fields the proof and settlement paths consult are
    ///         snapshotted here at request time; live parameters are never
    ///         read at settlement.
    struct ReservationAction {
        // 20-byte public key hash of the wallet the action's single
        // wallet-controlled output must pay to: the designated custodian
        // for acceptances, the migration target for re-anchors, the
        // custodying wallet itself for dissolutions. Zero for redemptions.
        bytes20 targetWalletPubKeyHash;
        // UNIX timestamp the action was requested at.
        uint32 requestedAt;
        // UNIX timestamp after which the action can be reported timed out.
        uint32 timeoutAt;
        // Snapshotted maximum Bitcoin miner fee for the action transaction.
        uint64 txMaxFee;
        // Action type of this generation.
        ActionType actionType;
        // Settlement state of this generation.
        ActionState state;
        // True when the generation was created through a fee-paying vault
        // entry point; a fee-paid redemption generation that times out
        // mints the retry entitlement.
        bool feePaid;
        // The address able to claim the escrowed balance back should a
        // redemption generation time out. Zero for other action types.
        address redeemer;
        // Amount in satoshi associated with the generation: the escrowed
        // gross claim for redemptions (the full claim for a whole
        // redemption, the redeemed portion for a partial), the
        // capacity-reserved deposit value for acceptances, the anchor
        // value at request time otherwise.
        uint64 amount;
        // Action-specific authorization data: the keccak256 hash of the
        // length-prefixed redeemer output script for redemptions, or the
        // wallet main UTXO hash snapshotted for dissolutions. Zero for
        // acceptances and re-anchors, and for dissolutions of wallets with
        // no main UTXO.
        bytes32 actionDataHash;
        // Hash of the reservation anchor outpoint this generation was
        // authorized to spend. Zero only for acceptance generations, which
        // spend the revealed deposit rather than an existing anchor.
        bytes32 sourceAnchorUtxoHash;
        // True when this redemption generation consumed the reservation's
        // single-use retry entitlement. Needed to return the entitlement if
        // a late action consumes the expected anchor while leaving the
        // reservation open and makes this generation impossible to settle.
        bool usedRetryCredit;
        // Reserved-redemption veto delay with no guardian objections,
        // snapshotted from the watchtower policy at request time. Zero when
        // the watchtower is absent, not enabled, disabled, or the amount is
        // waived.
        uint32 watchtowerDefaultDelay;
        // Reserved-redemption veto delay after one guardian objection,
        // snapshotted from the watchtower policy at request time.
        uint32 watchtowerLevelOneDelay;
        // Reserved-redemption veto delay after two guardian objections,
        // snapshotted from the watchtower policy at request time.
        uint32 watchtowerLevelTwoDelay;
        // True when a redemption generation is partial: it redeems only
        // `amount` of the reservation's claim in a 1-input-2-output spend
        // (redeemer output + re-anchored remainder) and leaves the
        // reservation open with a reduced anchor. False for a whole
        // redemption (1-input-1-output, closes the reservation) and for
        // every non-redemption action. Appended to the end of the struct so
        // the existing field layout is unchanged.
        bool isPartial;
        // Fee-paid redemption generation that originated the retry credit
        // consumed by this action. Zero when `usedRetryCredit` is false.
        // Kept on the action so a late re-anchor or partial redemption can
        // restore the exact amount/shape binding after superseding the retry.
        uint64 retryCreditSourceNonce;
    }

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

    /// @notice Computes the storage key of the action record of the given
    ///         reservation generation.
    function actionKey(uint256 reservationKey, uint64 requestNonce)
        internal
        pure
        returns (uint256)
    {
        return
            uint256(keccak256(abi.encodePacked(reservationKey, requestNonce)));
    }

    /// @notice Single entry point for all reservation lifecycle SPV proofs.
    ///         Forwards to the `ReservationProofs` settlement library. The
    ///         forwarding hop exists so the `ReservationRouter` links
    ///         exactly one external library; see the router for the
    ///         architecture.
    function submitReservationProof(
        BridgeState.Storage storage self,
        uint8 proofType,
        BitcoinTx.Info calldata txInfo,
        BitcoinTx.Proof calldata proof,
        BitcoinTx.UTXO calldata mainUtxo,
        uint256 reservationKey,
        uint64 requestNonce
    ) external {
        ReservationProofs.submitReservationProof(
            self,
            proofType,
            txInfo,
            proof,
            mainUtxo,
            reservationKey,
            requestNonce
        );
    }

    /// @notice Returns the action record of the given reservation
    ///         generation.
    function getAction(
        BridgeState.Storage storage self,
        uint256 reservationKey,
        uint64 requestNonce
    ) internal view returns (ReservationAction storage) {
        return self.reservationActions[actionKey(reservationKey, requestNonce)];
    }

    /// @notice Requests the acceptance of a revealed reserved deposit: the
    ///         authorization for the designated wallet to perform the
    ///         1-input-1-output anchor spend killing the deposit's refund
    ///         path. Checks and reserves capacity so that the anchor, once
    ///         signed, can always be proven.
    /// @param reservationKey The deposit key of the revealed reserved
    ///        deposit (`keccak256(fundingTxHash | fundingOutputIndex)`),
    ///        which doubles as the reservation key.
    /// @param walletPubKeyHash 20-byte public key hash of the wallet that
    ///        will anchor the deposit. Must be the wallet the deposit was
    ///        revealed for.
    /// @dev Requirements:
    ///      - The reservation vault must be set,
    ///      - The deposit must be revealed to the reservation vault and not
    ///        swept,
    ///      - No acceptance authorization for the deposit may be pending,
    ///      - The wallet must be Live,
    ///      - The deposit amount must satisfy the reservation minimum plus
    ///        the transaction fee allowance, so a compliant anchor always
    ///        satisfies the minimum after fees,
    ///      - At least one integer timestamp must remain after the deposit
    ///        minimum age and before both the action-timeout and exact
    ///        reveal-time refund safety margins, so every created action has
    ///        a proposal the wallet validator can sign,
    ///      - The authorization window (now + action timeout) must end before
    ///        the exact refund deadline, so an authorized anchor can never
    ///        race the depositor's refund,
    ///      - Reservation capacity (total amount, per-wallet count) must
    ///        allow the deposit; both are reserved by this call and
    ///        released if the authorization times out.
    function requestReservationAcceptance(
        BridgeState.Storage storage self,
        uint256 reservationKey,
        bytes20 walletPubKeyHash
    ) external {
        require(
            self.reservationVault != address(0),
            "Reservations are disabled"
        );

        Deposit.DepositRequest storage deposit = self.deposits[reservationKey];
        require(deposit.revealedAt != 0, "Deposit not revealed");
        require(deposit.sweptAt == 0, "Deposit already swept");
        require(
            self.pendingReservedDeposit[reservationKey].isReserved,
            "Deposit was not revealed as reserved"
        );
        require(
            deposit.vault == self.reservationVault,
            "Deposit not routed to the reservation vault"
        );

        BridgeState.PendingReservedDeposit storage reservedDeposit = self
            .pendingReservedDeposit[reservationKey];
        // NOTE: This exact require repeats below, after the reservation
        // state and pending-action checks. Neither operand is mutated in
        // between (`walletPubKeyHash` is calldata, `reservedDeposit` is a
        // storage pointer, and the checks between only read), so the
        // second copy can never revert when this one passes. The
        // duplication is inherited verbatim from #1094 and kept
        // deliberately: this stack's extraction PRs stay faithful to the
        // audited source. Do not "fix" one copy without the other.
        require(
            reservedDeposit.walletPubKeyHash == walletPubKeyHash,
            "Wallet is not the deposit's designated wallet"
        );

        ReservationRequest storage reservation = self.reservations[
            reservationKey
        ];
        require(
            reservation.state == ReservationState.Unknown,
            "Reservation already exists"
        );
        require(
            getAction(self, reservationKey, reservation.requestNonce).state !=
                ActionState.Pending,
            "Acceptance already pending"
        );

        // The anchor must be bound to the wallet the deposit was revealed
        // for: only that wallet's key can spend the deposit, and only it
        // may become the custodian. The mapping doubles as the pending
        // marker — a deposit marked stale (or already accepted) cannot be
        // re-authorized.
        require(
            reservedDeposit.walletPubKeyHash == walletPubKeyHash,
            "Wallet is not the deposit's designated wallet"
        );

        require(
            self.registeredWallets[walletPubKeyHash].state ==
                Wallets.WalletState.Live,
            "Wallet must be in Live state"
        );

        require(
            deposit.amount >=
                self.reservationMinAmount + self.reservationTxMaxFee,
            "Deposit amount too small for a reservation"
        );

        /* solhint-disable-next-line not-rely-on-time */
        uint32 timeoutAt = uint32(block.timestamp) +
            self.reservationActionTimeout;

        // Proposal timestamps are integer seconds and must be later than both
        // the strict deposit-age boundary and the block creating the action.
        // The first admissible timestamp is therefore one second after the
        // greater of those two lower bounds.
        uint256 signingLowerBound = uint256(deposit.revealedAt) +
            WalletProposalValidatorConstants.DEPOSIT_MIN_AGE;
        /* solhint-disable-next-line not-rely-on-time */
        if (signingLowerBound < block.timestamp) {
            /* solhint-disable-next-line not-rely-on-time */
            signingLowerBound = block.timestamp;
        }
        uint256 earliestSigningAt = signingLowerBound + 1;

        uint256 actionSigningDeadline = uint256(timeoutAt) -
            WalletProposalValidatorConstants.REQUEST_TIMEOUT_SAFETY_MARGIN;
        require(
            earliestSigningAt < actionSigningDeadline,
            "Acceptance authorization has no signing window"
        );

        // Use the exact refund locktime captured at reveal. A later
        // governance update of `depositRevealAheadPeriod` must neither
        // extend nor shorten this deposit's authorization window. The raw
        // deadline is retained even when reveal-ahead validation is disabled
        // because the wallet validator always enforces its refund margin.
        require(
            timeoutAt <= reservedDeposit.refundDeadline,
            "Authorization window would overlap the deposit refund window"
        );
        require(
            uint256(reservedDeposit.refundDeadline) >
                WalletProposalValidatorConstants.DEPOSIT_REFUND_SAFETY_MARGIN &&
                earliestSigningAt <
                uint256(reservedDeposit.refundDeadline) -
                    WalletProposalValidatorConstants
                        .DEPOSIT_REFUND_SAFETY_MARGIN,
            "Acceptance authorization has no signing window"
        );

        require(
            self.reservationMaxSingleAmount == 0 ||
                deposit.amount <= self.reservationMaxSingleAmount,
            "Reservation exceeds the single-reservation cap"
        );

        // Reserve capacity using the deposit value as the upper bound of
        // the anchor value; the settlement releases the miner-fee delta.
        uint64 newTotal = self.reservationTotalAmount + deposit.amount;
        require(
            newTotal <= self.reservationMaxTotalAmount,
            "Total reserved amount cap exceeded"
        );
        self.reservationTotalAmount = newTotal;

        uint32 walletCount = self.walletReservationsCount[walletPubKeyHash] + 1;
        require(
            walletCount <= self.maxReservationsPerWallet,
            "Wallet reservations cap exceeded"
        );
        self.walletReservationsCount[walletPubKeyHash] = walletCount;

        uint64 walletAmount = self.walletReservationsAmount[walletPubKeyHash] +
            deposit.amount;
        require(
            self.maxReservationsAmountPerWallet == 0 ||
                walletAmount <= self.maxReservationsAmountPerWallet,
            "Wallet reserved amount cap exceeded"
        );
        self.walletReservationsAmount[walletPubKeyHash] = walletAmount;

        uint64 requestNonce = ++reservation.requestNonce;

        ReservationAction storage action = getAction(
            self,
            reservationKey,
            requestNonce
        );
        action.actionType = ActionType.Acceptance;
        action.state = ActionState.Pending;
        /* solhint-disable-next-line not-rely-on-time */
        action.requestedAt = uint32(block.timestamp);
        action.timeoutAt = timeoutAt;
        action.txMaxFee = self.reservationTxMaxFee;
        action.targetWalletPubKeyHash = walletPubKeyHash;
        action.amount = deposit.amount;

        emit ReservationAcceptanceRequested(
            reservationKey,
            requestNonce,
            walletPubKeyHash,
            deposit.amount,
            action.txMaxFee,
            timeoutAt
        );
    }

    /// @notice Appends a reservation key to a wallet's enumeration list.
    function addWalletReservationKey(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash,
        uint256 reservationKey
    ) internal {
        self.walletReservationKeys[walletPubKeyHash].push(reservationKey);
        self.walletReservationKeyIndex[reservationKey] = self
            .walletReservationKeys[walletPubKeyHash]
            .length;
    }

    /// @notice Swap-removes a reservation key from a wallet's enumeration
    ///         list.
    function removeWalletReservationKey(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash,
        uint256 reservationKey
    ) internal {
        uint256 indexPlusOne = self.walletReservationKeyIndex[reservationKey];
        if (indexPlusOne == 0) {
            return;
        }
        uint256[] storage keys = self.walletReservationKeys[walletPubKeyHash];
        uint256 lastIndex = keys.length - 1;
        if (indexPlusOne - 1 != lastIndex) {
            uint256 movedKey = keys[lastIndex];
            keys[indexPlusOne - 1] = movedKey;
            self.walletReservationKeyIndex[movedKey] = indexPlusOne;
        }
        keys.pop();
        delete self.walletReservationKeyIndex[reservationKey];
    }

    /// @notice Strands a reservation: releases its tracked capacity, removes
    ///         it from wallet enumeration and emits the canonical recovery
    ///         evidence. The caller decides whether the anchor was honestly
    ///         spent before invoking this accounting transition.
    function strandReservation(
        BridgeState.Storage storage self,
        ReservationRequest storage reservation,
        uint256 reservationKey
    ) internal {
        bool evidenceAlreadyEmitted = reservation.state ==
            ReservationState.Stranded;

        self.walletReservationsCount[reservation.walletPubKeyHash] -= 1;
        self.walletReservationsAmount[
            reservation.walletPubKeyHash
        ] -= reservation.anchorAmount;
        self.reservationTotalAmount -= reservation.anchorAmount;
        removeWalletReservationKey(
            self,
            reservation.walletPubKeyHash,
            reservationKey
        );
        reservation.state = ReservationState.Stranded;

        delete self.reservationsByAnchorUtxo[
            uint256(
                keccak256(
                    abi.encodePacked(
                        reservation.anchorTxHash,
                        reservation.anchorTxOutputIndex
                    )
                )
            )
        ];

        // A late dissolution proof can reconstruct and then release the
        // accounting of an already-stranded position. Preserve the original
        // recovery evidence instead of emitting a second compensation claim.
        if (!evidenceAlreadyEmitted) {
            // slither-disable-next-line reentrancy-events
            emit ReservationStranded(
                reservationKey,
                reservation.walletPubKeyHash,
                reservation.owner,
                reservation.anchorAmount
            );
        }
    }
}
