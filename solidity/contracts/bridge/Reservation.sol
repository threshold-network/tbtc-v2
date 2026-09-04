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
import "./Wallets.sol";
import "./WalletProposalValidatorConstants.sol";

/// @title Bridge UTXO reservations — control plane
/// @notice The library handles the request/authorization side of UTXO
///         reservations: deposits custodied without ever being commingled
///         with the pooled supply and returned in-kind — with an unbroken
///         1-input-1-output lineage — upon redemption. The SPV settlement
///         side will live in the future `ReservationProofs` companion
///         library (not yet implemented).
/// @dev Every Bitcoin action of a reservation's life — the acceptance
///      anchor, an in-kind redemption, a re-anchor to another wallet, and
///      the post-term dissolution — follows a *two-phase,
///      authorize-then-prove* model, as described in tbtc-v2 PR #1108:
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
///         snapshotted authorization parameters; term and
///         dissolution-delay grants at settlement additionally read live
///         governance parameters current at that moment. A generation that
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
    using Wallets for BridgeState.Storage;

    /// @notice Hard protocol bounds on the custody term length. The
    ///         governable term must stay within them; they bound the
    ///         maximum owner lookahead (one term plus the renewal window)
    ///         and keep the carry economics of a term meaningful.
    // Bounds enforced by the governance term-update setter that ships in the
    // bounded-renewal PR; unused in milestone 1.
    // slither-disable-next-line unused-state
    uint32 internal constant MIN_RESERVATION_TERM = 90 days;
    // slither-disable-next-line unused-state
    uint32 internal constant MAX_RESERVATION_TERM = 730 days;
    /// @notice Represents the state of a reservation position.
    enum ReservationState {
        /// @dev The reservation is unknown to the Bridge. Acceptance
        ///      requests are made against positions in this state. An
        ///      acceptance authorization pending settlement is tracked
        ///      exclusively via the action record
        ///      (`reservationActions[actionKey(reservationKey, requestNonce)]`
        ///      `.state == Pending`); the position itself stays `Unknown`
        ///      and `ActionPending` is not set for acceptance in
        ///      milestone 1.
        Unknown,
        /// @dev The reservation was accepted (anchor proven, balance
        ///      credited) and its anchor outpoint is under wallet custody,
        ///      with no action in flight.
        Active,
        /// @dev An action (redemption, re-anchor or dissolution) has been
        ///      requested for the position and is not yet settled. The
        ///      pending action record is
        ///      `reservationActions[actionKey(reservationKey, requestNonce)]`.
        ///      Not used for a pending acceptance authorization; see
        ///      `Unknown`.
        ActionPending,
        /// @dev The reservation was closed as a terminal position outcome:
        ///      redeemed in-kind or dissolved into the wallet's main UTXO.
        ///      Late settlement of a timed-out acceptance generation does
        ///      not produce this state — it settles into `Active` (see
        ///      `ReservationProofs.settleAcceptance`).
        Closed,
        /// @dev The custodying wallet was terminated while the anchor was
        ///      outstanding. The owner's minted balance remains an ordinary
        ///      pooled claim; the anchor is no longer tracked unless a
        ///      previously timed-out generation later settles against it.
        Stranded
    }

    /// @notice Type of a reservation action generation.
    /// @dev Redemption and Dissolution values are kept for m2 storage/layout stability.
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
        // The reservation owner holding the in-kind redemption right.
        // Initialized at reveal time by the deposit-reveal producer stub
        // (`reservations[key].owner = depositor`) and reaffirmed here at
        // acceptance time; must remain meaningless to any reader before
        // acceptance settles.
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
        // XXX: Unsigned 32-bit int unix seconds. Computed as `acceptedAt +
        // reservationTermSeconds`; Solidity's checked arithmetic reverts
        // this addition (rather than silently wrapping) once the sum would
        // exceed the uint32 ceiling - starting up to MAX_RESERVATION_TERM
        // (730 days) before the raw February 7th 2106 date, not at it.
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
        // XXX: Unsigned 32-bit int unix seconds. Computed as `expiresAt +
        // reservationDissolutionDelay`; Solidity's checked arithmetic
        // reverts this addition (rather than silently wrapping) once the
        // sum would exceed the uint32 ceiling - starting somewhat before
        // February 7th 2106, proportional to the delay applied on top of
        // expiresAt's own margin.
        // As of this milestone, this field's only on-chain reader —
        // re-anchor's `< dissolutionEligibleAt` gate in
        // `requestReservationReanchor` — has been removed. The field is
        // written by `settleAcceptance` (ReservationProofs.sol:579) but
        // read by nothing in m1. It must continue to be written anyway: per
        // m1-b-implementation.md §4.4, storage-complete means written, not
        // merely declared, and this field is a commitment held in storage
        // for m2's dissolution feature to honour. m2 must independently
        // decide whether to restore an eligibility gate on re-anchor when
        // dissolution ships; this PR's removal defers that design decision
        // without answering it.
        uint32 dissolutionEligibleAt;
        // Cumulative satoshi lost to Bitcoin miner fees across all
        // re-anchor hops of this reservation. Will be written on every
        // re-anchor settlement; not read in milestone 1 because the
        // re-anchor path lands with a later milestone. It will be written
        // from the first re-anchor hop onward because the re-anchor
        // settlement path writes the claim down on every hop, so the
        // original anchor value is not recoverable afterwards and this
        // total cannot be reconstructed from later state — the
        // `ReservationReanchored` event carries only the new anchor
        // amount, not the per-hop delta. Accumulating now means a
        // post-milestone-1 cap reads the true lifetime total instead of
        // only post-upgrade hops. Appended to the end of the struct: since
        // the struct is stored in a mapping, fields can be appended safely
        // without gap-scarcity (see the note below on why this struct has
        // no `__gap`).
        uint64 cumulativeReanchorFee;
        // Appended to the end of the struct so the existing field layout
        // is unchanged.
        uint32 reanchorCooldownUntil;
        // This struct doesn't contain `__gap` property as the structure is
        // stored in a mapping, mappings store values in different slots and
        // they are not contiguous with other values.
    }

    /// @notice Represents one requested generation of a reservation action.
    ///         All fields the proof and settlement paths consult are
    ///         snapshotted here at request time; live parameters are never
    ///         read at settlement, with the exception of term and dissolution
    ///         delay grants.
    struct ReservationAction {
        // 20-byte public key hash of the wallet the action's single
        // wallet-controlled output must pay to: the designated custodian
        // for acceptances, the migration target for re-anchors, the
        // custodying wallet itself for dissolutions. Zero for redemptions.
        bytes20 targetWalletPubKeyHash;
        // UNIX timestamp the action was requested at.
        // XXX: Unsigned 32-bit int unix seconds, will break February 7th 2106.
        uint32 requestedAt;
        // UNIX timestamp after which the action can be reported timed out.
        // XXX: Unsigned 32-bit int unix seconds. Computed by adding a
        // timeout duration to requestedAt; Solidity's checked arithmetic
        // reverts this addition (rather than silently wrapping) once the
        // sum would exceed the uint32 ceiling - starting somewhat before
        // February 7th 2106, proportional to the timeout applied.
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
        // Amount in satoshi associated with the generation: the escrowed
        // gross claim for redemptions (the full claim for a whole
        // redemption, the redeemed portion for a partial), the
        // capacity-reserved deposit value for acceptances, the anchor
        // value at request time otherwise.
        uint64 amount;
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
        // Fee-paid redemption generation that originated the retry credit
        // consumed by this action. Zero when `usedRetryCredit` is false.
        // Kept on the action so a late re-anchor or partial redemption can
        // restore the exact amount/shape binding after superseding the retry.
        uint64 retryCreditSourceNonce;
        // True when a redemption generation is partial: it redeems only
        // `amount` of the reservation's claim in a 1-input-2-output spend
        // (redeemer output + re-anchored remainder) and leaves the
        // reservation open with a reduced anchor. False for a whole
        // redemption (1-input-1-output, closes the reservation) and for
        // every non-redemption action.
        bool isPartial;
        // Snapshotted `reservationTermSeconds` at acceptance request time.
        // Zero for every non-acceptance action type. Used by
        // `settleAcceptance` to compute `expiresAt` from the generation
        // record instead of the live governance parameter, matching this
        // struct's snapshot-at-request invariant.
        uint32 termSeconds;
        // Snapshotted `reservationDissolutionDelay` at acceptance request
        // time. Zero for every non-acceptance action type. Used by
        // `settleAcceptance` to compute `dissolutionEligibleAt` from the
        // generation record instead of the live governance parameter.
        uint32 dissolutionDelay;
    }

    event ReservationAcceptanceRequested(
        uint256 indexed reservationKey,
        uint64 requestNonce,
        bytes20 indexed walletPubKeyHash,
        uint64 depositAmount,
        uint64 txMaxFee,
        uint32 timeoutAt
    );

    event ReservationReanchorRequested(
        uint256 indexed reservationKey,
        uint64 requestNonce,
        bytes20 indexed sourceWalletPubKeyHash,
        bytes20 indexed targetWalletPubKeyHash,
        uint64 txMaxFee
    );

    event ReservationStranded(
        uint256 indexed reservationKey,
        bytes20 indexed walletPubKeyHash,
        address indexed owner,
        uint64 anchorAmount
    );

    event ReservationReanchorTimedOut(
        uint256 indexed reservationKey,
        uint64 requestNonce
    );

    event ReservationAcceptanceTimedOut(
        uint256 indexed reservationKey,
        uint64 requestNonce
    );

    event ReservationParametersUpdated(
        uint64 reservationMinAmount,
        uint64 reservationTxMaxFee,
        uint32 reservationTermSeconds,
        uint32 reservationDissolutionDelay,
        uint64 reservationMaxTotalAmount,
        uint32 maxReservationsPerWallet,
        uint32 reservationActionTimeout,
        uint32 reservationRenewalWindowSeconds
    );

    event ReservationVaultUpdated(address reservationVault);

    event ReservationCapsUpdated(
        uint64 maxReservationsAmountPerWallet,
        uint64 reservationMaxSingleAmount,
        uint32 maxActiveReservations
    );

    event ReservationRetryCreditMinted(uint256 indexed reservationKey);
    event ReservedDepositMarkedStale(uint256 indexed depositKey);

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

    /// @notice Returns the action record of the given reservation
    ///         generation.
    function getAction(
        BridgeState.Storage storage self,
        uint256 reservationKey,
        uint64 requestNonce
    ) internal view returns (ReservationAction storage) {
        return self.reservationActions[actionKey(reservationKey, requestNonce)];
    }

    /// @notice Returns the canonical hash of a reservation anchor outpoint.
    ///         Action generations snapshot this value so a late proof can
    ///         only consume the exact anchor that generation authorized.
    function anchorUtxoHash(ReservationRequest storage reservation)
        internal
        view
        returns (bytes32)
    {
        return
            keccak256(
                abi.encodePacked(
                    reservation.anchorTxHash,
                    reservation.anchorTxOutputIndex
                )
            );
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
    ///      - Caller must be the deposit's depositor,
    ///      - No acceptance authorization for the deposit may be pending,
    ///      - Wallet must be the deposit's designated wallet,
    ///      - No reservation may already exist for the key,
    ///      - The wallet must be Live,
    ///      - The deposit amount must satisfy the reservation minimum plus
    ///        the transaction fee allowance, so a compliant anchor always
    ///        satisfies the minimum after fees,
    ///      - Deposit amount must not exceed the single-reservation cap
    ///        (`reservationMaxSingleAmount`; 0 disables the cap),
    ///      - Wallet's reserved amount after this deposit must not exceed
    ///        the per-wallet amount cap (`maxReservationsAmountPerWallet`;
    ///        0 disables the cap),
    ///      - Active reservations count must remain below the max active
    ///        reservations cap (`maxActiveReservations`; 0 disables the
    ///        cap),
    ///      - At least one integer timestamp must remain after the deposit
    ///        minimum age and before both the action-timeout and exact
    ///        reveal-time refund safety margins, so every created action has
    ///        a proposal the wallet validator (see PR #B) can sign,
    ///      - The authorization window (now + action timeout) must end at or
    ///        before the exact refund deadline, so an authorized anchor can never
    ///        race the depositor's refund,
    ///      - The single-reservation amount must not exceed the cap,
    ///      - The active-position cap must not be exceeded,
    ///      - The global reserved-amount cap must not be exceeded,
    ///      - The per-wallet reservation-count cap must not be exceeded,
    ///      - The per-wallet amount cap must not be exceeded.
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
        require(
            msg.sender == deposit.depositor,
            "Caller is not the deposit's depositor"
        );
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
        // because the margin is enforced on-chain.
        require(
            uint256(timeoutAt) +
                WalletProposalValidatorConstants.DEPOSIT_REFUND_SAFETY_MARGIN <=
                uint256(reservedDeposit.refundDeadline),
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

        // Occupancy: number of open reservation positions across all
        // wallets. Zero disables the cap until governance sets it.
        require(
            self.maxActiveReservations == 0 ||
                self.activeReservationsCount < self.maxActiveReservations,
            "Active reservations cap exceeded"
        );
        self.activeReservationsCount += 1;

        // Reserve capacity using the deposit value as the upper bound of
        // the anchor value; the settlement releases the miner-fee delta.
        uint64 newTotal = self.reservationTotalAmount + deposit.amount;
        require(
            self.reservationMaxTotalAmount == 0 ||
                newTotal <= self.reservationMaxTotalAmount,
            "Total reserved amount cap exceeded"
        );
        self.reservationTotalAmount = newTotal;

        uint32 walletCount = self.walletReservationInfo[walletPubKeyHash].count + 1;
        require(
            self.maxReservationsPerWallet == 0 ||
                walletCount <= self.maxReservationsPerWallet,
            "Wallet reservations cap exceeded"
        );
        self.walletReservationInfo[walletPubKeyHash].count = walletCount;

        uint64 walletAmount = self.walletReservationInfo[walletPubKeyHash].amount +
            deposit.amount;
        require(
            self.maxReservationsAmountPerWallet == 0 ||
                walletAmount <= self.maxReservationsAmountPerWallet,
            "Wallet reserved amount cap exceeded"
        );
        self.walletReservationInfo[walletPubKeyHash].amount = walletAmount;

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
        action.termSeconds = self.reservationTermSeconds;
        action.dissolutionDelay = self.reservationDissolutionDelay;

        emit ReservationAcceptanceRequested(
            reservationKey,
            requestNonce,
            walletPubKeyHash,
            deposit.amount,
            action.txMaxFee,
            timeoutAt
        );
    }

    /// @notice Permissionlessly reports a pending acceptance authorization
    ///         as timed out once its authorization window has elapsed,
    ///         releasing the capacity it reserved so a fresh generation can
    ///         be requested for the deposit. The timed-out generation
    ///         remains settleable: if its anchor transaction later confirms
    ///         on Bitcoin, `submitReservationAcceptanceProof` settles it as
    ///         a late acceptance instead of reverting.
    /// @param reservationKey The deposit key of the revealed reserved
    ///        deposit, which doubles as the reservation key.
    /// @dev Requirements:
    ///      - The reservation's current generation must be a pending
    ///        acceptance authorization (`ActionType.Acceptance`,
    ///        `ActionState.Pending`),
    ///      - `block.timestamp` must be at or after the generation's
    ///        `timeoutAt`.
    function notifyReservationAcceptanceTimedOut(
        BridgeState.Storage storage self,
        uint256 reservationKey
    ) external {
        ReservationRequest storage reservation = self.reservations[
            reservationKey
        ];
        uint64 requestNonce = reservation.requestNonce;
        ReservationAction storage action = getAction(
            self,
            reservationKey,
            requestNonce
        );

        require(
            action.actionType == ActionType.Acceptance,
            "Action type mismatch"
        );
        require(action.state == ActionState.Pending, "Action is not pending");
        require(
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp >= action.timeoutAt,
            "Action has not timed out"
        );

        action.state = ActionState.TimedOut;

        // Mirrors `ReservationProofs.unwindPendingAction`'s acceptance
        // branch: a superseded or timed-out acceptance authorization
        // releases the capacity it reserved against its target wallet at
        // request time.
        bytes20 targetWalletPubKeyHash = action.targetWalletPubKeyHash;
        uint64 amount = action.amount;
        self.reservationTotalAmount -= amount;
        self.walletReservationInfo[targetWalletPubKeyHash].count -= 1;
        self.walletReservationInfo[targetWalletPubKeyHash].amount -= amount;
        self.activeReservationsCount -= 1;

        emit ReservationAcceptanceTimedOut(reservationKey, requestNonce);
    }

    /// @notice Requests the re-anchoring of a reservation to another
    ///         wallet: the authorization for the source wallet to spend the
    ///         anchor in a 1-input-1-output transaction paying the target
    ///         wallet. Used during wallet migration so reservations never
    ///         pin retiring wallets, and for governance-approved rotations.
    /// @param reservationKey The key of the reservation to re-anchor.
    /// @param targetWalletPubKeyHash 20-byte public key hash of the target
    ///        wallet.
    /// @param privileged True when the call is made by the governance
    ///        (checked by the calling contract), which may rotate anchors
    ///        away from Live wallets.
    /// @dev Requirements:
    ///      - The reservation must be Active,
    ///      - The source wallet must be in the MovingFunds or Closing state
    ///        (the primary re-anchor path for MovingFunds/Closing is
    ///        permissionless by design, not gated), or Live with the
    ///        governance as the caller (approved rotation),
    ///      - The target wallet must be Live and different from the source,
    ///      - At least one integer timestamp must remain between now and the
    ///        action-timeout safety margin, so every created action has a
    ///        proposal the wallet validator (see PR #B) can sign,
    ///      - The target wallet's reservation-count capacity must allow the
    ///        move; the capacity is reserved by this call and released if
    ///        the authorization times out,
    ///      - The target wallet's amount capacity must allow the move.
    /// @dev Re-anchor is intentionally unbounded in time in milestone 1,
    ///      with no dissolution path available yet. Milestone 2 must
    ///      decide whether to reintroduce a time-based eligibility gate on
    ///      re-anchor when dissolution ships (see m1-b-implementation.md §6).
    function requestReservationReanchor(
        BridgeState.Storage storage self,
        uint256 reservationKey,
        bytes20 targetWalletPubKeyHash,
        bool privileged
    ) external {
        ReservationRequest storage reservation = self.reservations[
            reservationKey
        ];
        require(
            reservation.state == ReservationState.Active,
            "Reservation is not active"
        );
        /* solhint-disable not-rely-on-time */
        if (!privileged) {
            require(
                block.timestamp >= reservation.reanchorCooldownUntil,
                "Reanchor cooldown in effect"
            );
        }
        /* solhint-enable not-rely-on-time */

        {
            Wallets.WalletState sourceState = self
                .registeredWallets[reservation.walletPubKeyHash]
                .state;
            if (sourceState == Wallets.WalletState.Live) {
                require(
                    privileged,
                    "Only governance can rotate a Live wallet's anchor"
                );
            } else {
                require(
                    sourceState == Wallets.WalletState.MovingFunds ||
                        sourceState == Wallets.WalletState.Closing,
                    "Source wallet must be in MovingFunds or Closing state"
                );
            }
        }

        require(
            targetWalletPubKeyHash != reservation.walletPubKeyHash,
            "Target wallet must differ from the source wallet"
        );
        require(
            self.registeredWallets[targetWalletPubKeyHash].state ==
                Wallets.WalletState.Live,
            "Target wallet must be in Live state"
        );

        /* solhint-disable-next-line not-rely-on-time */
        uint32 timeoutAt = uint32(block.timestamp) +
            self.reservationActionTimeout;

        // A re-anchor authorization carries no deposit-reveal age floor
        // (unlike acceptance): the earliest admissible signing timestamp is
        // simply the next integer second after this request. Require a
        // non-empty window before the safety-margined deadline so every
        // created action has a proposal the wallet validator (see PR #B)
        // can sign.
        require(
            uint256(timeoutAt) >
                WalletProposalValidatorConstants
                    .REQUEST_TIMEOUT_SAFETY_MARGIN &&
                /* solhint-disable-next-line not-rely-on-time */
                uint256(block.timestamp) + 1 <
                uint256(timeoutAt) -
                    WalletProposalValidatorConstants
                        .REQUEST_TIMEOUT_SAFETY_MARGIN,
            "Reanchor authorization has no signing window"
        );
        require(
            reservation.anchorAmount >
                self.reservationTxMaxFee + self.reservationMinAmount,
            "Reanchor would fall below the minimum reservation amount"
        );

        // Reserve the target wallet's count and amount capacity; the
        // source wallet's are released at settlement (or kept on timeout).
        uint32 targetCount = self.walletReservationInfo[
            targetWalletPubKeyHash
        ].count + 1;
        require(
            self.maxReservationsPerWallet == 0 ||
                targetCount <= self.maxReservationsPerWallet,
            "Wallet reservations cap exceeded"
        );
        self.walletReservationInfo[targetWalletPubKeyHash].count = targetCount;

        uint64 targetAmount = self.walletReservationInfo[
            targetWalletPubKeyHash
        ].amount + reservation.anchorAmount;
        require(
            self.maxReservationsAmountPerWallet == 0 ||
                targetAmount <= self.maxReservationsAmountPerWallet,
            "Wallet reserved amount cap exceeded"
        );
        self.walletReservationInfo[targetWalletPubKeyHash].amount = targetAmount;

        reservation.state = ReservationState.ActionPending;
        uint64 requestNonce = ++reservation.requestNonce;

        ReservationAction storage action = getAction(
            self,
            reservationKey,
            requestNonce
        );
        action.actionType = ActionType.Reanchor;
        action.state = ActionState.Pending;
        /* solhint-disable-next-line not-rely-on-time */
        action.requestedAt = uint32(block.timestamp);
        action.timeoutAt = timeoutAt;
        action.txMaxFee = self.reservationTxMaxFee;
        action.targetWalletPubKeyHash = targetWalletPubKeyHash;
        action.amount = reservation.anchorAmount;
        action.sourceAnchorUtxoHash = anchorUtxoHash(reservation);

        emit ReservationReanchorRequested(
            reservationKey,
            requestNonce,
            reservation.walletPubKeyHash,
            targetWalletPubKeyHash,
            action.txMaxFee
        );
    }

    /// @param walletMembersIDs Identifiers of the wallet signing group
    ///        members; only consulted on the slashing paths (redemption and
    ///        dissolution timeouts). Unreachable in milestone 1 (redemption
    ///        and dissolution timeouts do not occur); unused until those
    ///        paths land.
    function notifyReservationActionTimeout(
        BridgeState.Storage storage self,
        uint256 reservationKey,
        // solhint-disable-next-line no-unused-vars
        uint32[] calldata walletMembersIDs
    ) external {
        ReservationRequest storage reservation = self.reservations[
            reservationKey
        ];
        ReservationAction storage action = getAction(
            self,
            reservationKey,
            reservation.requestNonce
        );

        require(
            action.actionType == ActionType.Reanchor,
            "Unsupported action type for timeout"
        );
        require(
            reservation.state == ReservationState.ActionPending,
            "Reservation is not in ActionPending state"
        );
        require(action.state == ActionState.Pending, "Action is not pending");
        /* solhint-disable not-rely-on-time */
        require(
            block.timestamp >= action.timeoutAt,
            "Action has not timed out"
        );
        /* solhint-enable not-rely-on-time */

        action.state = ActionState.TimedOut;

        // Release the target wallet's capacity reserved at request time;
        // the source wallet's capacity is untouched because the
        // reservation stays custodied there. A late proof of this
        // generation re-takes the released target capacity (see
        // `ReservationProofs.submitReservationReanchorProof`).
        self.walletReservationInfo[action.targetWalletPubKeyHash].count -= 1;
        self.walletReservationInfo[action.targetWalletPubKeyHash].amount -= action
            .amount;

        reservation.state = ReservationState.Active;

        /* solhint-disable not-rely-on-time */
        reservation.reanchorCooldownUntil =
            uint32(block.timestamp) +
            self.reservationActionTimeout;
        /* solhint-enable not-rely-on-time */

        emit ReservationReanchorTimedOut(
            reservationKey,
            reservation.requestNonce
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

    /// @notice Strands a reservation: releases its tracked capacity and
    ///         emits the canonical recovery evidence. The caller decides
    ///         whether the anchor was honestly spent before invoking this
    ///         accounting transition.
    function strandReservation(
        BridgeState.Storage storage self,
        ReservationRequest storage reservation,
        uint256 reservationKey
    ) internal {
        bool evidenceAlreadyEmitted = reservation.state ==
            ReservationState.Stranded;
        bytes20 walletPubKeyHash = reservation.walletPubKeyHash;
        uint64 anchorAmount = reservation.anchorAmount;

        if (!evidenceAlreadyEmitted) {
            self.walletReservationInfo[walletPubKeyHash].count -= 1;
            self.walletReservationInfo[walletPubKeyHash].amount -= anchorAmount;
            self.reservationTotalAmount -= anchorAmount;
            self.activeReservationsCount -= 1; // The stranded reservation was counted at request time.
            removeWalletReservationKey(self, walletPubKeyHash, reservationKey);
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
        }
        reservation.state = ReservationState.Stranded;

        // A late dissolution proof can reconstruct and then release the
        // accounting of an already-stranded position. Preserve the original
        // recovery evidence instead of emitting a second compensation claim.
        if (!evidenceAlreadyEmitted) {
            // slither-disable-next-line reentrancy-events
            emit ReservationStranded(
                reservationKey,
                walletPubKeyHash,
                reservation.owner,
                anchorAmount
            );
        }
    }

    /// @notice Marks a reservation custodied by a terminated or closed
    ///         wallet as stranded: an idle position closes, capacity
    ///         is released and the owner's minted balance remains an ordinary
    ///         pooled claim. Pending actions remain proof-eligible and
    ///         cannot be stranded.
    /// @param reservationKey The key of the stranded reservation.
    /// @dev Requirements:
    ///      - The custodying wallet must be in the Terminated or Closed state,
    ///        or in the Closing state once the reservation's
    ///        `dissolutionEligibleAt` has passed (i.e., `block.timestamp >=
    ///        reservation.dissolutionEligibleAt`). Closing is excluded before
    ///        that point: `requestReservationReanchor` accepts a Closing source
    ///        wallet, so allowing a Closing wallet to also be stranded here
    ///        would race a legitimate reanchor with a permissionless strand.
    ///        Once `dissolutionEligibleAt` passes, `requestReservationReanchor`
    ///        itself blocks reanchor (see `requestReservationReanchor` lines
    ///        753-756), so no race remains and Closing becomes eligible for
    ///        stranding, providing a milestone-1 release path.
    function notifyReservationStranded(
        BridgeState.Storage storage self,
        uint256 reservationKey
    ) external {
        ReservationRequest storage reservation = self.reservations[
            reservationKey
        ];
        require(
            reservation.state == ReservationState.Active,
            "Reservation is not active"
        );

        Wallets.WalletState walletState = self
            .registeredWallets[reservation.walletPubKeyHash]
            .state;
        require(
            walletState == Wallets.WalletState.Terminated ||
                walletState == Wallets.WalletState.Closed ||
                (walletState == Wallets.WalletState.Closing &&
                    /* solhint-disable-next-line not-rely-on-time */
                    block.timestamp >= reservation.dissolutionEligibleAt),
            "Wallet is not terminated, closed, or a dissolution-eligible closing wallet"
        );

        strandReservation(self, reservation, reservationKey);
    }

    /// @notice Marks a revealed reserved deposit as stale so it stops
    ///         counting against the pending-reserved-deposit guard and can
    ///         no longer be authorized for acceptance.
    /// @param depositKey The deposit key of the reserved deposit.
    /// @dev Requirements:
    ///      - The deposit must be a pending reserved deposit (revealed to
    ///        the reservation vault, not accepted, not already stale),
    ///      - No acceptance authorization may be pending for it,
    ///      - The exact Bitcoin refund deadline snapshotted at reveal must
    ///        have elapsed.
    function notifyStaleReservedDeposit(
        BridgeState.Storage storage self,
        uint256 depositKey
    ) external {
        BridgeState.PendingReservedDeposit storage pendingDeposit = self
            .pendingReservedDeposit[depositKey];
        require(
            pendingDeposit.walletPubKeyHash != bytes20(0),
            "Not a pending reserved deposit"
        );
        // A non-zero designated wallet implies reveal-time reservation
        // routing, and no path clears `isReserved` once reveal sets it. Lock
        // the implication here so a future refactor that re-purposes the flag
        // - for instance as a not-yet-stale marker - fails loudly instead of
        // silently redrawing the stale/acceptable partition.
        assert(pendingDeposit.isReserved);

        Deposit.DepositRequest storage deposit = self.deposits[depositKey];
        require(deposit.sweptAt == 0, "Deposit already swept");
        require(
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp > pendingDeposit.refundDeadline,
            "Deposit refund deadline has not elapsed"
        );

        ReservationRequest storage reservation = self.reservations[depositKey];
        require(
            getAction(self, depositKey, reservation.requestNonce).state !=
                ActionState.Pending,
            "Acceptance authorization pending"
        );

        delete pendingDeposit.walletPubKeyHash;
        delete pendingDeposit.refundDeadline;
        delete pendingDeposit.refundDeadlineValidated;
        self.pendingReservedDeposits -= 1;

        emit ReservedDepositMarkedStale(depositKey);
    }

    /// @notice Validates the Decision-1 relational invariant between the
    ///         total amount cap and slot capacity.
    /// @dev Requires that `reservationMaxTotalAmount` does not exceed the
    ///      worst-case slot capacity `maxActiveReservations * reservationMaxSingleAmount`.
    ///      Skipped if either operand is zero (disabled).
    function validateReservationCapsInvariant(
        uint64 reservationMaxTotalAmount,
        uint64 reservationMaxSingleAmount,
        uint32 maxActiveReservations
    ) internal pure {
        require(
            reservationMaxSingleAmount == 0 ||
                maxActiveReservations == 0 ||
                reservationMaxTotalAmount <=
                uint256(maxActiveReservations) * reservationMaxSingleAmount,
            "Amount cap exceeds slot capacity"
        );
    }

    /// @notice Updates parameters of reservations, including the
    ///         reservation vault address. Deposits revealed with the
    ///         reservation vault address are treated as UTXO reservations.
    /// @dev Requirements:
    ///      - `reservationTxMaxFee` must be greater than zero,
    ///      - `reservationMinAmount` must be greater than
    ///        `reservationTxMaxFee`,
    ///      - `reservationTermSeconds` must stay within
    ///        [MIN_RESERVATION_TERM, MAX_RESERVATION_TERM],
    ///      - `reservationRenewalWindowSeconds` must be greater than zero
    ///        and strictly shorter than the term (written in milestone 1
    ///        for storage completeness; unread until renewal lands),
    ///      - `reservationActionTimeout` must exceed the wallet
    ///        validator's final signing safety margin,
    ///      - `maxReservationsPerWallet` must be greater than zero, so the
    ///        per-wallet count cap cannot be silently disabled by a
    ///        parameter update,
    ///      - `reservationMaxTotalAmount` must not exceed the slot capacity
    ///        `maxActiveReservations * reservationMaxSingleAmount` (skipped
    ///        when either operand is zero/disabled),
    ///      - The reservation vault can only be changed while there are no
    ///        active reservations (total reserved amount is zero).
    ///
    ///      Term, dissolution delay and fee bounds are snapshotted into
    ///      positions and action records when terms are granted or actions
    ///      requested; updates apply prospectively only.
    function updateReservationParameters(
        BridgeState.Storage storage self,
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
        require(
            reservationTxMaxFee > 0,
            "Reservation transaction max fee must be greater than zero"
        );
        require(
            reservationMinAmount > reservationTxMaxFee,
            "Reservation minimum amount must be greater than the reservation TX max fee"
        );
        require(
            reservationTermSeconds >= MIN_RESERVATION_TERM &&
                reservationTermSeconds <= MAX_RESERVATION_TERM,
            "Reservation term out of protocol bounds"
        );
        require(
            reservationRenewalWindowSeconds > 0 &&
                reservationRenewalWindowSeconds < reservationTermSeconds,
            "Renewal window must be shorter than the term"
        );
        require(
            reservationActionTimeout >
                WalletProposalValidatorConstants.REQUEST_TIMEOUT_SAFETY_MARGIN,
            "Reservation action timeout must exceed the safety margin"
        );
        require(
            maxReservationsPerWallet > 0,
            "Max reservations per wallet must be greater than zero"
        );

        if (reservationVault != self.reservationVault) {
            require(
                self.reservationTotalAmount == 0,
                "Active reservations exist"
            );
            require(
                self.pendingReservedDeposits == 0,
                "Pending reserved deposits exist"
            );
            self.reservationVault = reservationVault;
            emit ReservationVaultUpdated(reservationVault);
        }

        // Decision 1 (option 2): the total amount cap may not exceed
        // worst-case slot capacity. `maxActiveReservations` bounds the
        // number of open positions and `reservationMaxSingleAmount` bounds
        // any single position's amount, so their product is the most that
        // can ever be reserved at once; a higher `reservationMaxTotalAmount`
        // is unreachable dead configuration because the position-count cap
        // saturates first. Either of those two set to zero means that cap
        // is disabled, so there is no ceiling to violate and the check is
        // skipped — this also covers the pre-launch state where
        // `updateReservationCaps` has not run yet. Mirrored in
        // `updateReservationCaps`, which owns the two operands read here.
        validateReservationCapsInvariant(
            reservationMaxTotalAmount,
            self.reservationMaxSingleAmount,
            self.maxActiveReservations
        );
        self.reservationMinAmount = reservationMinAmount;
        self.reservationTxMaxFee = reservationTxMaxFee;
        self.reservationTermSeconds = reservationTermSeconds;
        self.reservationDissolutionDelay = reservationDissolutionDelay;
        self.reservationMaxTotalAmount = reservationMaxTotalAmount;
        self.maxReservationsPerWallet = maxReservationsPerWallet;
        self.reservationActionTimeout = reservationActionTimeout;
        self.reservationRenewalWindowSeconds = reservationRenewalWindowSeconds;

        emit ReservationParametersUpdated(
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

    /// @notice Updates the amount-denominated reservation caps and the
    ///         global open-position occupancy cap. Amount caps are checked
    ///         and reserved at request/authorization time, never at proof
    ///         time; a zero amount-cap value disables that amount cap.
    ///         `maxActiveReservations` must be greater than zero — it is
    ///         the milestone 1 launch gate.
    /// @dev Requirements:
    ///      - `maxActiveReservations` must be greater than zero,
    ///      - Stored `reservationMaxTotalAmount` must not exceed the slot
    ///        capacity `maxActiveReservations * reservationMaxSingleAmount`
    ///        (skipped when either operand is zero/disabled).
    ///
    ///      Deploy-ordering recommendation (see
    ///      `docs/RESERVATION_CAPS_DEPLOYMENT.md`): the M3/M8 runbook
    ///      recommends running `updateReservationCaps` before
    ///      `updateReservationParameters` so that when
    ///      `updateReservationParameters`'s own slot-capacity check runs,
    ///      `self.reservationMaxSingleAmount` and `self.maxActiveReservations`
    ///      are already set to real (non-zero) values instead of relying on
    ///      the zero-disjunct short-circuit.
    function updateReservationCaps(
        BridgeState.Storage storage self,
        uint64 maxReservationsAmountPerWallet,
        uint64 reservationMaxSingleAmount,
        uint32 maxActiveReservations
    ) external {
        require(
            maxActiveReservations > 0,
            "Active reservations cap must be greater than zero"
        );

        // Decision 1 (option 2): mirror of the invariant enforced in
        // `updateReservationParameters`, evaluated from this function's new
        // operands against the stored `reservationMaxTotalAmount` that the
        // other setter owns. `maxActiveReservations == 0` needs no disjunct
        // here — the require above already rejects it.
        validateReservationCapsInvariant(
            self.reservationMaxTotalAmount,
            reservationMaxSingleAmount,
            maxActiveReservations
        );
        self.maxReservationsAmountPerWallet = maxReservationsAmountPerWallet;
        self.reservationMaxSingleAmount = reservationMaxSingleAmount;
        self.maxActiveReservations = maxActiveReservations;

        emit ReservationCapsUpdated(
            maxReservationsAmountPerWallet,
            reservationMaxSingleAmount,
            maxActiveReservations
        );
    }
}
