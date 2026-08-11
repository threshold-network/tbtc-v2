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

import {BTCUtils} from "@keep-network/bitcoin-spv-sol/contracts/BTCUtils.sol";
import {BytesLib} from "@keep-network/bitcoin-spv-sol/contracts/BytesLib.sol";

import "./BitcoinTx.sol";
import "./BridgeState.sol";
import "./Deposit.sol";
import "./Redemption.sol";
import "./ReservationProofs.sol";
import "./Wallets.sol";

import "../bank/Bank.sol";

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
    using BridgeState for BridgeState.Storage;
    using Wallets for BridgeState.Storage;

    using BTCUtils for bytes;
    using BytesLib for bytes;

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
        ///      pooled claim; the anchor is no longer tracked.
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
        // times out through the wallet's fault. It is returned if a late
        // re-anchor supersedes the retry that consumed it. Consumed by the
        // next strictly pre-expiry retry request; voided by a dissolution
        // request.
        bool retryCredit;
        // UNIX timestamp the reservation becomes dissolvable at. Set to
        // `expiresAt + reservationDissolutionDelay` whenever a term is
        // granted (acceptance and each renewal), using the delay value
        // current at that moment — later governance changes never move
        // the eligibility time of a term already granted.
        // XXX: Unsigned 32-bit int unix seconds, will break February 7th 2106.
        uint32 dissolutionEligibleAt;
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
        // gross claim for redemptions, the capacity-reserved deposit value
        // for acceptances, the anchor value at request time otherwise.
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
        // a late re-anchor makes the generation impossible to settle.
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
    }

    event ReservationAcceptanceRequested(
        uint256 indexed reservationKey,
        uint64 requestNonce,
        bytes20 indexed walletPubKeyHash,
        uint64 depositAmount,
        uint64 txMaxFee,
        uint32 timeoutAt
    );

    event ReservationExtended(
        uint256 indexed reservationKey,
        uint32 oldExpiresAt,
        uint32 newExpiresAt,
        uint32 dissolutionEligibleAt
    );

    event ReservedRedemptionRequested(
        uint256 indexed reservationKey,
        uint64 requestNonce,
        address indexed redeemer,
        bytes redeemerOutputScript,
        uint64 mintedAmount,
        uint64 txMaxFee,
        bool feePaid
    );

    event ReservationReanchorRequested(
        uint256 indexed reservationKey,
        uint64 requestNonce,
        bytes20 indexed sourceWalletPubKeyHash,
        bytes20 indexed targetWalletPubKeyHash,
        uint64 txMaxFee
    );

    event ReservationDissolutionRequested(
        uint256 indexed reservationKey,
        uint64 requestNonce,
        bytes20 indexed walletPubKeyHash,
        uint64 txMaxFee,
        bytes32 expectedMainUtxoHash
    );

    event ReservationActionTimedOut(
        uint256 indexed reservationKey,
        uint64 requestNonce,
        ActionType actionType
    );

    event ReservedRedemptionVetoed(
        uint256 indexed reservationKey,
        uint64 requestNonce
    );

    event ReservationRetryCreditMinted(uint256 indexed reservationKey);

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
    ///      - No acceptance authorization for the deposit may be pending,
    ///      - The wallet must be Live,
    ///      - The deposit amount must satisfy the reservation minimum plus
    ///        the transaction fee allowance, so a compliant anchor always
    ///        satisfies the minimum after fees,
    ///      - The authorization window (now + action timeout) must end
    ///        before the deposit's exact reveal-time refund deadline, so an
    ///        authorized anchor can never race the depositor's refund,
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
            deposit.vault == self.reservationVault,
            "Deposit not routed to the reservation vault"
        );

        BridgeState.PendingReservedDeposit storage reservedDeposit = self
            .pendingReservedDeposit[reservationKey];
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

        // Use the exact refund locktime captured at reveal. A later
        // governance update of `depositRevealAheadPeriod` must neither
        // extend nor shorten this deposit's authorization window. Zero
        // means the reveal-ahead validation was disabled at reveal time.
        if (reservedDeposit.refundDeadline != 0) {
            require(
                timeoutAt <= reservedDeposit.refundDeadline,
                "Authorization window would overlap the deposit refund window"
            );
        }

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

    /// @notice Requests an in-kind redemption of a reservation: the wallet
    ///         is expected to spend exactly the reservation's anchor
    ///         outpoint to the redeemer output script in a 1-input-1-output
    ///         transaction, once the watchtower delay elapses without a
    ///         veto. The gross minted amount is taken from the reservation
    ///         vault's Bank balance and held by the Bridge until the
    ///         redemption is proven (burned) or times out (returned to the
    ///         redeemer).
    /// @param reservationKey The key of the reservation to redeem.
    /// @param redeemer The address able to claim the escrowed balance back
    ///        if the redemption times out.
    /// @param redeemerOutputScript The redeemer's length-prefixed output
    ///        script (P2PKH, P2WPKH, P2SH or P2WSH) that will be used to
    ///        lock the redeemed BTC.
    /// @param feePaid True when the vault collected the redemption fee for
    ///        this request; a fee-paid generation that times out mints the
    ///        single-use retry entitlement.
    /// @param useRetryCredit True when the request consumes the fee-free
    ///        retry entitlement instead of paying the fee.
    /// @dev Requirements:
    ///      - The caller must be the reservation vault, which must have
    ///        approved the Bridge in the Bank for the gross minted amount,
    ///      - The reservation must be Active and custodied by a Live or
    ///        MovingFunds wallet,
    ///      - The custody term plus (snapshotted) grace period must not
    ///        have elapsed — after grace only dissolution is possible, so
    ///        request/timeout cycling cannot defeat the stranding bound.
    ///        A retry-entitled request is exempt until a dissolution is
    ///        requested (which voids the entitlement),
    ///      - When `useRetryCredit` is set, the position must hold the
    ///        retry entitlement (consumed by this call),
    ///      - If the redemption watchtower is set, neither the owner nor
    ///        the redeemer may be banned,
    ///      - `redeemerOutputScript` must be a standard type and must not
    ///        pay to the custodying wallet's public key hash.
    function requestReservedRedemption(
        BridgeState.Storage storage self,
        uint256 reservationKey,
        address redeemer,
        bytes calldata redeemerOutputScript,
        bool feePaid,
        bool useRetryCredit
    ) external {
        require(
            msg.sender == self.reservationVault,
            "Caller is not the reservation vault"
        );
        require(
            redeemer != address(0),
            "Redeemer must not be the zero address"
        );

        ReservationRequest storage reservation = self.reservations[
            reservationKey
        ];
        require(
            reservation.state == ReservationState.Active,
            "Reservation is not active"
        );

        {
            Wallets.WalletState walletState = self
                .registeredWallets[reservation.walletPubKeyHash]
                .state;
            require(
                walletState == Wallets.WalletState.Live ||
                    walletState == Wallets.WalletState.MovingFunds,
                "Wallet must be in Live or MovingFunds state"
            );
        }

        // New redemption generations stop strictly at expiry — for the
        // retry path as well. The post-expiry dissolution delay exists for
        // orderly settlement, not as a late owner-action window, so no
        // owner action beginning at/after expiry can delay dissolution.
        require(
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp < reservation.expiresAt,
            "Reservation expired"
        );

        if (useRetryCredit) {
            require(reservation.retryCredit, "No retry entitlement");
            reservation.retryCredit = false;
        }

        if (self.redemptionWatchtower != address(0)) {
            require(
                IRedemptionWatchtower(self.redemptionWatchtower)
                    .isSafeReservedRedemption(reservation.owner, redeemer),
                "Redemption request rejected by the watchtower"
            );
        }

        bytes memory redeemerOutputScriptMem = redeemerOutputScript;

        // Validate the redeemer output script is a correct standard type
        // (P2PKH, P2WPKH, P2SH or P2WSH), the same way `Redemption` does.
        bytes memory redeemerOutputScriptPayload = redeemerOutputScriptMem
            .extractHashAt(0, redeemerOutputScriptMem.length);
        require(
            redeemerOutputScriptPayload.length > 0,
            "Redeemer output script must be a standard type"
        );
        require(
            redeemerOutputScriptPayload.length != 20 ||
                reservation.walletPubKeyHash !=
                redeemerOutputScriptPayload.slice20(0),
            "Redeemer output script must not point to the wallet PKH"
        );

        reservation.state = ReservationState.ActionPending;
        uint64 requestNonce = ++reservation.requestNonce;

        ReservationAction storage action = getAction(
            self,
            reservationKey,
            requestNonce
        );
        action.actionType = ActionType.Redemption;
        action.state = ActionState.Pending;
        /* solhint-disable-next-line not-rely-on-time */
        action.requestedAt = uint32(block.timestamp);
        /* solhint-disable-next-line not-rely-on-time */
        action.timeoutAt = uint32(block.timestamp) + self.redemptionTimeout;
        action.txMaxFee = self.reservationTxMaxFee;
        action.feePaid = feePaid;
        action.usedRetryCredit = useRetryCredit;
        action.redeemer = redeemer;
        action.amount = reservation.mintedAmount;
        action.actionDataHash = keccak256(redeemerOutputScriptMem);
        action.sourceAnchorUtxoHash = anchorUtxoHash(reservation);

        if (self.redemptionWatchtower != address(0)) {
            (
                action.watchtowerDefaultDelay,
                action.watchtowerLevelOneDelay,
                action.watchtowerLevelTwoDelay
            ) = IRedemptionWatchtower(self.redemptionWatchtower)
                .getReservedRedemptionDelaySchedule(reservation.mintedAmount);
        }

        // slither-disable-next-line reentrancy-events
        emit ReservedRedemptionRequested(
            reservationKey,
            requestNonce,
            redeemer,
            redeemerOutputScript,
            reservation.mintedAmount,
            action.txMaxFee,
            feePaid
        );

        self.bank.transferBalanceFrom(
            msg.sender,
            address(this),
            reservation.mintedAmount
        );
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
    ///      - The reservation must not yet be dissolution-eligible,
    ///      - The source wallet must be in the MovingFunds state (anyone
    ///        may then request — migration is the system's duty), or Live
    ///        with the governance as the caller (approved rotation),
    ///      - The target wallet must be Live and different from the source,
    ///      - The target wallet's reservation-count capacity must allow the
    ///        move; the capacity is reserved by this call and released if
    ///        the authorization times out.
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
        require(
            block.timestamp < reservation.dissolutionEligibleAt,
            "Reservation is dissolution-eligible"
        );
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
                    sourceState == Wallets.WalletState.MovingFunds,
                    "Source wallet must be in Live or MovingFunds state"
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

        // Reserve the target wallet's count capacity; the source wallet's
        // count is released at settlement (or kept on timeout).
        uint32 targetCount = self.walletReservationsCount[
            targetWalletPubKeyHash
        ] + 1;
        require(
            targetCount <= self.maxReservationsPerWallet,
            "Wallet reservations cap exceeded"
        );
        self.walletReservationsCount[targetWalletPubKeyHash] = targetCount;

        reservation.state = ReservationState.ActionPending;
        uint64 requestNonce = ++reservation.requestNonce;

        ReservationAction storage action = getAction(
            self,
            reservationKey,
            requestNonce
        );
        action.actionType = ActionType.Reanchor;
        action.state = ActionState.Pending;
        /* solhint-disable not-rely-on-time */
        action.requestedAt = uint32(block.timestamp);
        action.timeoutAt =
            uint32(block.timestamp) +
            self.reservationActionTimeout;
        /* solhint-enable not-rely-on-time */
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

    /// @notice Requests the dissolution of an expired reservation: the
    ///         authorization for the custodying wallet to merge the anchor
    ///         into its main UTXO. After dissolution the owner's minted
    ///         balance simply remains an ordinary pooled claim.
    /// @param reservationKey The key of the reservation to dissolve.
    /// @dev Requirements:
    ///      - The reservation must be Active,
    ///      - The custody term plus (snapshotted) grace period must have
    ///        elapsed,
    ///      - The custodying wallet must be in Live or MovingFunds state,
    ///      - No other dissolution may be in flight for the wallet (the
    ///        per-wallet main-UTXO action lock): concurrent dissolutions
    ///        of a no-main-UTXO wallet could otherwise all confirm on
    ///        Bitcoin with only the first being provable.
    ///
    ///      Requesting a dissolution voids the position's redemption retry
    ///      entitlement: dissolution is the terminal cleanup and the
    ///      stranding bound takes precedence.
    function requestReservationDissolution(
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
        require(
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp >= reservation.dissolutionEligibleAt,
            "Reservation not dissolution-eligible yet"
        );

        bytes20 walletPubKeyHash = reservation.walletPubKeyHash;
        Wallets.Wallet storage wallet = self.registeredWallets[
            walletPubKeyHash
        ];
        {
            Wallets.WalletState walletState = wallet.state;
            require(
                walletState == Wallets.WalletState.Live ||
                    walletState == Wallets.WalletState.MovingFunds,
                "Wallet must be in Live or MovingFunds state"
            );
        }

        require(
            self.walletPendingDissolution[walletPubKeyHash] == 0,
            "Another dissolution is pending for the wallet"
        );
        self.walletPendingDissolution[walletPubKeyHash] = reservationKey;

        reservation.state = ReservationState.ActionPending;
        uint64 requestNonce = ++reservation.requestNonce;

        ReservationAction storage action = getAction(
            self,
            reservationKey,
            requestNonce
        );
        action.actionType = ActionType.Dissolution;
        action.state = ActionState.Pending;
        /* solhint-disable not-rely-on-time */
        action.requestedAt = uint32(block.timestamp);
        action.timeoutAt =
            uint32(block.timestamp) +
            self.reservationActionTimeout;
        /* solhint-enable not-rely-on-time */
        action.txMaxFee = self.reservationTxMaxFee;
        action.targetWalletPubKeyHash = walletPubKeyHash;
        action.amount = reservation.anchorAmount;
        action.actionDataHash = wallet.mainUtxoHash;
        action.sourceAnchorUtxoHash = anchorUtxoHash(reservation);

        emit ReservationDissolutionRequested(
            reservationKey,
            requestNonce,
            walletPubKeyHash,
            action.txMaxFee,
            action.actionDataHash
        );
    }

    /// @notice Notifies that the pending action of the given reservation
    ///         has timed out. Writes the terminal `TimedOut` record —
    ///         which still accepts a late proof — releases the capacity
    ///         and locks reserved at request time, refunds the escrowed
    ///         claim for redemptions (minting the fee-free retry
    ///         entitlement when the generation had paid the fee), and
    ///         propagates wallet consequences: redemption and dissolution
    ///         timeouts slash the wallet operators exactly like a pooled
    ///         redemption timeout.
    /// @param reservationKey The key of the reservation with the timed out
    ///        action.
    /// @param walletMembersIDs Identifiers of the wallet signing group
    ///        members. Only consulted for redemption and dissolution
    ///        timeouts (the slashing path); pass an empty array otherwise.
    /// @dev Requirements:
    ///      - The reservation must have a pending action (or a pending
    ///        acceptance authorization),
    ///      - The action's timeout must have elapsed.
    function notifyReservationActionTimeout(
        BridgeState.Storage storage self,
        uint256 reservationKey,
        uint32[] calldata walletMembersIDs
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
        require(action.state == ActionState.Pending, "No pending action");
        require(
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp > action.timeoutAt,
            "Action has not timed out"
        );

        action.state = ActionState.TimedOut;

        ActionType actionType = action.actionType;

        if (actionType == ActionType.Acceptance) {
            // Release the capacity reserved at request time; the deposit
            // remains revealed and a new acceptance can be requested while
            // the refund-locktime margin allows.
            self.reservationTotalAmount -= action.amount;
            self.walletReservationsCount[action.targetWalletPubKeyHash] -= 1;
        } else if (actionType == ActionType.Redemption) {
            reservation.state = ReservationState.Active;

            if (action.feePaid) {
                reservation.retryCredit = true;
                emit ReservationRetryCreditMinted(reservationKey);
            }

            // Propagate timeout consequences to the wallet: slashing and
            // state transition follow the regular redemption timeout rules.
            self.notifyWalletRedemptionTimeout(
                reservation.walletPubKeyHash,
                walletMembersIDs
            );

            // Return the escrowed balance to the redeemer as Bank balance.
            self.bank.transferBalance(action.redeemer, action.amount);
        } else if (actionType == ActionType.Reanchor) {
            reservation.state = ReservationState.Active;
            // Release the target wallet's reserved count capacity.
            self.walletReservationsCount[action.targetWalletPubKeyHash] -= 1;
        } else {
            // Dissolution.
            reservation.state = ReservationState.Active;
            delete self.walletPendingDissolution[reservation.walletPubKeyHash];

            bool walletWasMovingFunds = self
                .registeredWallets[reservation.walletPubKeyHash]
                .state == Wallets.WalletState.MovingFunds;

            // A wallet failing its dissolution duty is slashed like a
            // wallet failing a redemption: dissolution is the mechanism
            // that makes term + grace a hard stranding bound.
            self.notifyWalletRedemptionTimeout(
                reservation.walletPubKeyHash,
                walletMembersIDs
            );

            // A Live wallet enters MovingFunds on its first failure and keeps
            // the ordinary moving-funds deadline. A wallet already in
            // MovingFunds has now also refused the terminal cleanup of its
            // residual anchor, so terminate it at the dissolution bound.
            if (walletWasMovingFunds) {
                self.terminateWallet(reservation.walletPubKeyHash);
            }
        }

        // slither-disable-next-line reentrancy-events
        emit ReservationActionTimedOut(
            reservationKey,
            requestNonce,
            actionType
        );
    }

    /// @notice Notifies that the pending reserved redemption of the given
    ///         reservation was vetoed in the redemption watchtower. The
    ///         escrowed balance is detained and passed to the watchtower
    ///         (as Bank balance) for penalty/freeze processing, the
    ///         generation becomes terminally `Vetoed` — a proof against it
    ///         is rejected forever — and the position returns to Active:
    ///         the anchor was not spent (an honest wallet does not sign
    ///         before authorization), so the in-kind claim survives.
    /// @param reservationKey The key of the reservation with the vetoed
    ///        redemption.
    /// @param requestNonce The generation being vetoed.
    /// @dev Requirements:
    ///      - The caller must be the redemption watchtower,
    ///      - The generation must be the position's pending redemption.
    function notifyReservedRedemptionVeto(
        BridgeState.Storage storage self,
        uint256 reservationKey,
        uint64 requestNonce
    ) external {
        require(
            msg.sender == self.redemptionWatchtower,
            "Caller is not the redemption watchtower"
        );

        ReservationRequest storage reservation = self.reservations[
            reservationKey
        ];
        require(
            reservation.requestNonce == requestNonce,
            "Not the current generation"
        );

        ReservationAction storage action = getAction(
            self,
            reservationKey,
            requestNonce
        );
        require(
            action.actionType == ActionType.Redemption &&
                action.state == ActionState.Pending,
            "No pending reserved redemption"
        );

        action.state = ActionState.Vetoed;
        reservation.state = ReservationState.Active;

        // slither-disable-next-line reentrancy-events
        emit ReservedRedemptionVetoed(reservationKey, requestNonce);

        self.bank.transferBalance(self.redemptionWatchtower, action.amount);
    }

    /// @notice Renews the custody term of a reservation: adds exactly one
    ///         current term to the expiry. Renewal is permissionless for
    ///         the owner (through the reservation vault, which collects
    ///         the fee and enforces the exceptional pause/block policy)
    ///         but strictly bounded: it is possible only inside the
    ///         renewal window immediately before expiry, and since the
    ///         window is shorter than the term, a fresh renewal is
    ///         immediately outside its next window — terms can never be
    ///         stacked. The maximum owner lookahead is one term plus the
    ///         window.
    /// @param reservationKey The key of the reservation to renew.
    /// @param expectedExpiresAt The expiry the caller observed; rejects
    ///        stale renewal transactions.
    /// @param expectedNewExpiresAt The new expiry the caller is paying
    ///        for; rejects renewals whose term parameter changed between
    ///        transaction construction and execution.
    /// @dev Requirements:
    ///      - The caller must be the reservation vault,
    ///      - The reservation must be Active (a pending action blocks
    ///        renewal),
    ///      - The stored expiry must equal `expectedExpiresAt`,
    ///      - The current parameters must satisfy `0 < window < term`,
    ///      - The execution time must lie in `[expiry - window, expiry)`
    ///        — at expiry, renewal is closed,
    ///      - `expiry + term` must equal `expectedNewExpiresAt`.
    ///
    ///      On success the expiry advances by exactly one current term and
    ///      the dissolution eligibility is re-snapshotted for the newly
    ///      purchased term using the current dissolution delay. No other
    ///      field changes.
    function extendReservation(
        BridgeState.Storage storage self,
        uint256 reservationKey,
        uint32 expectedExpiresAt,
        uint32 expectedNewExpiresAt
    ) external {
        require(
            msg.sender == self.reservationVault,
            "Caller is not the reservation vault"
        );

        ReservationRequest storage reservation = self.reservations[
            reservationKey
        ];
        require(
            reservation.state == ReservationState.Active,
            "Reservation is not active"
        );

        uint32 expiresAt = reservation.expiresAt;
        require(
            expiresAt == expectedExpiresAt,
            "Stale renewal: unexpected current expiry"
        );

        uint32 window = self.reservationRenewalWindowSeconds;
        uint32 term = self.reservationTermSeconds;
        require(
            window > 0 && window < term,
            "Renewal window must be shorter than the term"
        );

        require(
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp >= expiresAt - window &&
                /* solhint-disable-next-line not-rely-on-time */
                block.timestamp < expiresAt,
            "Outside the renewal window"
        );

        uint32 newExpiresAt = expiresAt + term;
        require(
            newExpiresAt == expectedNewExpiresAt,
            "Stale renewal: unexpected new expiry"
        );

        uint32 dissolutionEligibleAt = newExpiresAt +
            self.reservationDissolutionDelay;

        reservation.expiresAt = newExpiresAt;
        reservation.dissolutionEligibleAt = dissolutionEligibleAt;

        emit ReservationExtended(
            reservationKey,
            expiresAt,
            newExpiresAt,
            dissolutionEligibleAt
        );
    }

    /// @notice Updates the reservation parameters, including the
    ///         reservation vault address. Deposits revealed with the
    ///         reservation vault address are treated as reserved deposits.
    /// @dev Requirements:
    ///      - Reservation transaction max fee must be greater than zero,
    ///      - Reservation minimum amount must be greater than the
    ///        reservation transaction max fee,
    ///      - Reservation term must be within the protocol bounds
    ///        [MIN_RESERVATION_TERM, MAX_RESERVATION_TERM],
    ///      - The renewal window must be non-zero and strictly shorter
    ///        than the term (checked atomically here and re-checked at
    ///        renewal execution, so neither parameter change can reopen
    ///        term stacking),
    ///      - Reservation action timeout must be greater than zero,
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
            reservationActionTimeout > 0,
            "Reservation action timeout must be greater than zero"
        );

        if (reservationVault != self.reservationVault) {
            require(
                self.reservationTotalAmount == 0,
                "Active reservations exist"
            );
            self.reservationVault = reservationVault;
            emit ReservationVaultUpdated(reservationVault);
        }

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

    /// @notice Closes a reservation: adjusts the wallet reservation count
    ///         and the total reserved amount, and marks the reservation as
    ///         Closed.
    function closeReservation(
        BridgeState.Storage storage self,
        ReservationRequest storage reservation
    ) internal {
        self.walletReservationsCount[reservation.walletPubKeyHash] -= 1;
        self.reservationTotalAmount -= reservation.anchorAmount;
        reservation.state = ReservationState.Closed;
    }
}
