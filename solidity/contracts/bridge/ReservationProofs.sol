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

import "./BitcoinTx.sol";
import "./BridgeState.sol";
import "./Deposit.sol";
import "./Redemption.sol";
import "./Reservation.sol";
import "./Wallets.sol";

import "../bank/Bank.sol";

/// @title Bridge UTXO reservations — settlement
/// @notice SPV settlement side of the two-phase reservation model (see
///         `Reservation` for the request/authorization side and RFC 13 for
///         the architecture, whose document ships with a later milestone PR (not yet in this branch's docs/rfc/)). Every proof settles one requested
///         *generation*, named explicitly by `(reservationKey,
///         requestNonce)`, and is validated exclusively against that
///         generation's snapshotted action record — never against live
///         parameters.
/// @dev Settlement rules shared by all action types (Milestone 1 wires only the acceptance branch; the redemption, re-anchor and dissolution rules described below land with later milestones.):
///
///      - A `Pending` generation settles normally. For redemptions the
///        proof additionally requires the watchtower delay of the
///        generation to have elapsed — a Byzantine wallet broadcasting
///        before authorization cannot finalize early, and if the
///        generation is vetoed its transaction is unprovable forever
///        (the fraud machinery handles the unauthorized signature).
///
///      - A `TimedOut` generation still settles ("late settlement"): the
///        Bitcoin transaction confirmed and the anchor is irrevocably
///        spent, so the registry records reality — consumed outpoints are
///        marked honestly spent (defeating fraud challenges against the
///        honest-but-late signature), the anchor lineage closes, and any
///        newer pending generation whose anchor no longer exists is
///        unwound (its escrow refunded). What late settlement never does
///        is repeat a Bank movement: the timeout already refunded the
///        escrow, so nothing is burned or paid again. If the position's
///        *current pending* redemption generation matches the transaction
///        as well, the proof must settle against it instead — the
///        deterministic, economically correct target.
///
///      - A `Vetoed` generation never settles.
library ReservationProofs {
    using BridgeState for BridgeState.Storage;
    using BitcoinTx for BridgeState.Storage;
    using Reservation for BridgeState.Storage;

    using BTCUtils for bytes;

    event ReservationAccepted(
        uint256 indexed reservationKey,
        uint64 requestNonce,
        bytes20 indexed walletPubKeyHash,
        address indexed owner,
        bytes32 anchorTxHash,
        uint64 anchorAmount,
        uint32 expiresAt
    );

    event ReservationActionSuperseded(
        uint256 indexed reservationKey,
        uint64 requestNonce
    );

    event ReservationRetryCreditMinted(uint256 indexed reservationKey);

    event ReservationLateSettled(
        uint256 indexed reservationKey,
        uint64 requestNonce,
        Reservation.ActionType actionType
    );

    /// @notice Represents the type of a reservation lifecycle SPV proof.
    ///         Zero-based; `ProofType(n)` corresponds to
    ///         `Reservation.ActionType(n + 1)` for `n` in `{0..3}` (`None`
    ///         has no `ProofType` counterpart).
    enum ProofType {
        Acceptance,
        Redemption,
        Reanchor,
        Dissolution
    }

    /// @notice Single entry point for all reservation lifecycle SPV proofs.
    ///         Dispatches to the appropriate handler based on `proofType`.
    /// @param proofType The type of the submitted proof, see `ProofType`.
    /// @param txInfo Bitcoin transaction data.
    /// @param proof Bitcoin proof data.
    /// @param reservationKey The key of the target reservation.
    /// @param requestNonce The generation being settled. Late settlements
    ///        name an older, timed-out generation.
    /// @dev Only `ProofType.Acceptance` is wired in milestone 1; the
    ///      trailing `UTXO` argument is reserved for later proof types and
    ///      is currently ignored.
    function submitReservationProof(
        BridgeState.Storage storage self,
        uint8 proofType,
        BitcoinTx.Info calldata txInfo,
        BitcoinTx.Proof calldata proof,
        BitcoinTx.UTXO calldata,
        uint256 reservationKey,
        uint64 requestNonce
    ) external {
        require(
            proofType < uint8(type(ProofType).max) + 1,
            "Unsupported reservation proof type"
        );
        ProofType parsedProofType = ProofType(proofType);

        if (parsedProofType == ProofType.Acceptance) {
            submitReservationAcceptanceProof(
                self,
                txInfo,
                proof,
                reservationKey,
                requestNonce
            );
            // Milestone 1 accepts only acceptance proofs. Redemption and
            // dissolution stay rejected for the entirety of m1. The
            // re-anchor branch lands with the re-anchor milestone PR as a
            // new `else if` placed ahead of this `else`; it does not exist
            // in this branch.
        } else {
            revert("Unsupported reservation proof type");
        }
    }

    /// @notice Loads the action record of the generation being settled and
    ///         validates it is settleable (`Pending` or `TimedOut`) and of
    ///         the expected type.
    /// @return action The action record.
    /// @return late True when settling a timed-out generation.
    function loadSettleableAction(
        BridgeState.Storage storage self,
        uint256 reservationKey,
        uint64 requestNonce,
        Reservation.ActionType expectedType
    )
        internal
        view
        returns (Reservation.ReservationAction storage action, bool late)
    {
        action = self.reservationActions[
            Reservation.actionKey(reservationKey, requestNonce)
        ];
        require(action.actionType == expectedType, "Action type mismatch");
        require(
            action.state == Reservation.ActionState.Pending ||
                action.state == Reservation.ActionState.TimedOut,
            "Action is not settleable"
        );
        late = action.state == Reservation.ActionState.TimedOut;
    }

    /// @notice Converts a settlement into the existing stranded-position
    ///         accounting when its target wallet can no longer manage the
    ///         newly settled anchor.
    /// @dev Live and MovingFunds wallets can still manage the anchor.
    ///      Closing, Closed, and Terminated wallets are stranded
    ///      immediately: the permissionless cleanup path
    ///      (`notifyReservationStranded`) lands with a later milestone PR
    ///      and does not exist in this branch, so there is no other route
    ///      to release a reservation settled against an already-terminated
    ///      wallet. `evidenceAlreadyEmitted` supports the future
    ///      `notifyReservationStranded` call site, which strands before any
    ///      settlement proof exists: when a lineage was already stranded by
    ///      that path before this proof arrives, restore the Stranded state
    ///      latch before cleanup so the reconstructed accounting is
    ///      released without emitting duplicate recovery evidence.
    function strandLateSettlementIfTargetWalletClosed(
        BridgeState.Storage storage self,
        Reservation.ReservationRequest storage reservation,
        uint256 reservationKey,
        bool evidenceAlreadyEmitted
    ) internal {
        Wallets.WalletState walletState = self
            .registeredWallets[reservation.walletPubKeyHash]
            .state;
        if (
            walletState == Wallets.WalletState.Closing ||
            walletState == Wallets.WalletState.Closed ||
            walletState == Wallets.WalletState.Terminated
        ) {
            if (evidenceAlreadyEmitted) {
                reservation.state = Reservation.ReservationState.Stranded;
            }
            self.strandReservation(reservation, reservationKey);
        }
    }

    /// @notice Used by the wallet to prove the BTC anchor transaction of an
    ///         authorized reserved deposit acceptance and to credit the
    ///         owner's balance accordingly.
    ///
    ///         The anchor transaction must spend exactly the revealed
    ///         reserved deposit as its sole input and create exactly one
    ///         P2(W)PKH output controlled by the wallet the acceptance
    ///         request authorized. Proving it marks the deposit as swept
    ///         (blocking any regular sweep and enabling fraud challenge
    ///         defeats for the deposit outpoint), registers the reservation
    ///         and credits the gross anchor value to the depositor through
    ///         the reservation vault.
    /// @dev Requirements:
    ///      - The named generation must be a settleable acceptance
    ///        authorization for the deposit,
    ///      - `anchorTx` must spend the revealed reserved deposit as its
    ///        sole input,
    ///      - `anchorTx` must have exactly one P2(W)PKH output locking
    ///        funds on the authorized wallet's public key hash,
    ///      - The Bitcoin miner fee must not exceed the authorization's
    ///        snapshotted fee bound. Together with the request-time check
    ///        `depositAmount >= minAmount + txMaxFee` this guarantees the
    ///        anchor value satisfies the reservation minimum without any
    ///        proof-time dependency on live parameters.
    function submitReservationAcceptanceProof(
        BridgeState.Storage storage self,
        BitcoinTx.Info calldata anchorTx,
        BitcoinTx.Proof calldata anchorProof,
        uint256 reservationKey,
        uint64 requestNonce
    ) internal {
        (
            Reservation.ReservationAction storage action,
            bool late
        ) = loadSettleableAction(
                self,
                reservationKey,
                requestNonce,
                Reservation.ActionType.Acceptance
            );

        require(
            self.reservations[reservationKey].state ==
                Reservation.ReservationState.Unknown,
            "Reservation already exists"
        );
        require(
            self.pendingReservedDeposit[reservationKey].isReserved,
            "Deposit was not revealed as reserved"
        );

        bytes32 anchorTxHash = self.validateProof(anchorTx, anchorProof);

        consumeAcceptedDeposit(self, anchorTx.inputVector, reservationKey);

        uint64 anchorAmount = validateAnchorOutput(
            self,
            anchorTx.outputVector,
            action
        );

        settleAcceptance(
            self,
            reservationKey,
            requestNonce,
            action,
            late,
            anchorTxHash,
            anchorAmount
        );
    }

    /// @notice Asserts the anchor transaction's sole input spends the
    ///         reserved deposit the generation was authorized for and marks
    ///         the deposit as swept: any regular sweep is blocked and the
    ///         deposit outpoint becomes recognized by the fraud challenge
    ///         defeat path.
    /// @dev The deposit was validated against the reservation vault at
    ///      request time; the routing-change gate is NOT yet
    ///      enforceable (no setter exists in this branch). The
    ///      governance setter lands later.
    function consumeAcceptedDeposit(
        BridgeState.Storage storage self,
        bytes memory inputVector,
        uint256 reservationKey
    ) internal {
        (bytes32 outpointTxHash, uint32 outpointIndex) = OutboundTx
            .parseWalletOutboundTxInput(inputVector);
        require(
            uint256(
                keccak256(abi.encodePacked(outpointTxHash, outpointIndex))
            ) == reservationKey,
            "Transaction input must spend the reserved deposit"
        );

        Deposit.DepositRequest storage deposit = self.deposits[reservationKey];
        require(deposit.sweptAt == 0, "Deposit already swept");

        /* solhint-disable-next-line not-rely-on-time */
        deposit.sweptAt = uint32(block.timestamp);

        BridgeState.PendingReservedDeposit storage reservedDeposit = self
            .pendingReservedDeposit[reservationKey];
        // Stale notification may already have released this pending marker
        // before a late acceptance proof arrives. Consume the marker and its
        // counter exactly once, while always recording the proven sweep and
        // preserving the immutable reveal-time reservation classification.
        if (reservedDeposit.walletPubKeyHash != bytes20(0)) {
            delete reservedDeposit.walletPubKeyHash;
            delete reservedDeposit.refundDeadline;
            delete reservedDeposit.refundDeadlineValidated;
            self.pendingReservedDeposits -= 1;
        }
    }

    /// @notice Parses the anchor transaction's single output, validates it
    ///         pays the authorized wallet within the snapshotted fee bound
    ///         and returns its value.
    function validateAnchorOutput(
        BridgeState.Storage storage self,
        bytes memory outputVector,
        Reservation.ReservationAction storage action
    ) internal view returns (uint64 anchorAmount) {
        bytes memory output = parseSingleOutput(outputVector);
        anchorAmount = output.extractValue();
        require(
            self.extractPubKeyHash(output) == action.targetWalletPubKeyHash,
            "Anchor output must pay the authorized wallet"
        );
        require(
            action.amount - anchorAmount <= action.txMaxFee,
            "Transaction fee is too high"
        );
        // Defense-in-depth: `action.amount - anchorAmount <= action.txMaxFee`
        // together with the request-time check
        // `depositAmount >= reservationMinAmount + txMaxFee` already implies
        // this, but that guarantee is indirect through two other
        // invariants; make the anchor minimum a direct revert guard so a
        // future caller or test harness mismatch that writes a smaller
        // `action.amount` cannot mint a below-minimum anchor silently.
        require(
            anchorAmount >= self.reservationMinAmount,
            "Anchor below reservation minimum"
        );
    }

    /// @notice Finalizes an acceptance settlement: adjusts the reserved
    ///         capacity, creates the reservation position, indexes the
    ///         anchor outpoint and credits the gross anchor value through
    ///         the reservation vault.
    function settleAcceptance(
        BridgeState.Storage storage self,
        uint256 reservationKey,
        uint64 requestNonce,
        Reservation.ReservationAction storage action,
        bool late,
        bytes32 anchorTxHash,
        uint64 anchorAmount
    ) internal {
        action.state = Reservation.ActionState.Settled;

        bytes20 targetWalletPubKeyHash = action.targetWalletPubKeyHash;

        if (late) {
            // A newer acceptance generation may have been authorized after
            // this one timed out via `Reservation.notifyReservationAcceptanceTimedOut`:
            // the position stayed Unknown, so re-authorization was
            // possible. Only the position's current generation is ever
            // reachable by proof submission, and this deposit is now
            // consumed, so a still-pending newer generation's reserved
            // capacity would leak permanently. Unwind it. (A newer
            // generation that already timed out released its own capacity
            // — nothing to unwind there.)
            Reservation.ReservationRequest storage pending = self.reservations[
                reservationKey
            ];
            if (pending.requestNonce != requestNonce) {
                Reservation.ReservationAction storage newer = self
                    .reservationActions[
                        Reservation.actionKey(
                            reservationKey,
                            pending.requestNonce
                        )
                    ];
                if (newer.state == Reservation.ActionState.Pending) {
                    unwindPendingAction(self, pending, reservationKey, false);
                }
            }

            // `notifyReservationAcceptanceTimedOut` released the capacity
            // reserved at request time when it marked this generation
            // `TimedOut`; re-take it here for the actual anchor value.
            // Deliberately no cap check: caps are request-time throttles
            // and the anchor is already confirmed on Bitcoin.
            self.reservationTotalAmount += anchorAmount;
            self.walletReservationsCount[targetWalletPubKeyHash] += 1;
            self.walletReservationsAmount[
                targetWalletPubKeyHash
            ] += anchorAmount;
            self.activeReservationsCount += 1;
            emit ReservationLateSettled(
                reservationKey,
                requestNonce,
                Reservation.ActionType.Acceptance
            );
        } else {
            // Release the difference between the reserved upper bound
            // (deposit value) and the actual anchor value (miner fee).
            uint64 feeDelta = action.amount - anchorAmount;
            self.reservationTotalAmount -= feeDelta;
            self.walletReservationsAmount[targetWalletPubKeyHash] -= feeDelta;
        }

        Reservation.ReservationRequest storage reservation = self.reservations[
            reservationKey
        ];
        Deposit.DepositRequest storage deposit = self.deposits[reservationKey];
        address depositor = deposit.depositor;

        /* solhint-disable-next-line not-rely-on-time */
        uint32 expiresAt = uint32(block.timestamp) + action.termSeconds;

        reservation.owner = depositor;
        reservation.mintedAmount = anchorAmount;
        /* solhint-disable-next-line not-rely-on-time */
        reservation.acceptedAt = uint32(block.timestamp);
        reservation.walletPubKeyHash = targetWalletPubKeyHash;
        reservation.anchorAmount = anchorAmount;
        reservation.expiresAt = expiresAt;
        reservation.anchorTxHash = anchorTxHash;
        reservation.anchorTxOutputIndex = 0;
        reservation.state = Reservation.ReservationState.Active;
        reservation.dissolutionEligibleAt = expiresAt + action.dissolutionDelay;

        self.reservationsByAnchorUtxo[
            uint256(keccak256(abi.encodePacked(anchorTxHash, uint32(0))))
        ] = reservationKey;
        Reservation.addWalletReservationKey(
            self,
            targetWalletPubKeyHash,
            reservationKey
        );

        // slither-disable-next-line reentrancy-events
        emit ReservationAccepted(
            reservationKey,
            requestNonce,
            targetWalletPubKeyHash,
            depositor,
            anchorTxHash,
            anchorAmount,
            expiresAt
        );

        // A timed-out authorization released the target wallet's reservation
        // count, so the wallet may have retired before this already-confirmed
        // anchor is proven. Closing, Closed, and Terminated wallets have no
        // cleanup path in this branch (`notifyReservationStranded` lands
        // with a later milestone PR); strand the newly registered position
        // immediately. This check runs unconditionally (not just for late
        // settlements): an on-time proof can equally race a wallet leaving
        // Live mid-flight.
        strandLateSettlementIfTargetWalletClosed(
            self,
            reservation,
            reservationKey,
            false
        );

        // Credit the gross anchored amount through the vault the deposit was
        // revealed to, but only if that vault is still trusted: governance
        // may have revoked trust between the acceptance request and this
        // (possibly late) proof. Using the deposit's immutable `vault`
        // (verified to equal the reservation vault when the acceptance was
        // requested) rather than the live `reservationVault` keeps a late
        // settlement routing to the depositor's chosen vault even if
        // governance re-pointed or disabled the reservation vault in the
        // interim. The per-deposit treasury fee computed at reveal time is
        // deliberately ignored: reservation claims are minted gross and all
        // protocol fees are charged as explicit transfers by the vault. All
        // reservation-position state above is finalized before this external
        // call, matching the checks-effects-interactions pattern.
        address[] memory depositors = new address[](1);
        depositors[0] = depositor;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = anchorAmount;

        address vault = deposit.vault;
        if (vault != address(0) && self.isVaultTrusted[vault]) {
            self.bank.increaseBalanceAndCall(vault, depositors, amounts);
        } else {
            self.bank.increaseBalances(depositors, amounts);
        }
    }

    /// @notice Unwinds the position's current pending generation during a
    ///         late settlement of an older generation: the anchor the
    ///         pending generation was authorized to spend has provably been
    ///         consumed, so the generation can never settle. Its escrow is
    ///         refunded (redemptions), its reserved capacity and locks are
    ///         released, and it is terminally marked `Superseded`. Retry
    ///         credit restoration is enabled only by the late-reanchor call
    ///         site, whose successful settlement leaves the reservation
    ///         Active on a replacement anchor.
    function unwindPendingAction(
        BridgeState.Storage storage self,
        Reservation.ReservationRequest storage reservation,
        uint256 reservationKey,
        bool restoreRetryCredit
    ) internal {
        uint64 pendingNonce = reservation.requestNonce;
        Reservation.ReservationAction storage pendingAction = self
            .reservationActions[
                Reservation.actionKey(reservationKey, pendingNonce)
            ];
        require(
            pendingAction.state == Reservation.ActionState.Pending,
            "No pending action to unwind"
        );

        pendingAction.state = Reservation.ActionState.Superseded;

        if (pendingAction.actionType == Reservation.ActionType.Redemption) {
            if (restoreRetryCredit && pendingAction.usedRetryCredit) {
                reservation.retryCredit = true;
                emit ReservationRetryCreditMinted(reservationKey);
            }

            // Return the escrowed balance: the redeemer surrendered it for
            // an anchor that no longer exists.
            self.bank.transferBalance(
                pendingAction.redeemer,
                pendingAction.amount
            );
        } else if (
            pendingAction.actionType == Reservation.ActionType.Reanchor
        ) {
            bytes20 targetWalletPubKeyHash = pendingAction
                .targetWalletPubKeyHash;
            self.walletReservationsCount[targetWalletPubKeyHash] -= 1;
            self.walletReservationsAmount[
                targetWalletPubKeyHash
            ] -= pendingAction.amount;
        } else if (
            pendingAction.actionType == Reservation.ActionType.Dissolution
        ) {
            if (
                self.walletPendingDissolution[reservation.walletPubKeyHash] ==
                reservationKey
            ) {
                delete self.walletPendingDissolution[
                    reservation.walletPubKeyHash
                ];
            }
        } else if (
            pendingAction.actionType == Reservation.ActionType.Acceptance
        ) {
            // A superseded acceptance authorization releases the capacity it
            // reserved against its target wallet at request time.
            bytes20 targetWalletPubKeyHash = pendingAction
                .targetWalletPubKeyHash;
            uint64 amount = pendingAction.amount;
            self.reservationTotalAmount -= amount;
            self.walletReservationsCount[targetWalletPubKeyHash] -= 1;
            self.walletReservationsAmount[targetWalletPubKeyHash] -= amount;
            self.activeReservationsCount -= 1;
        }

        // The Bank is a trusted protocol contract; the refund above cannot
        // reenter in a way that makes this event misleading.
        // slither-disable-next-line reentrancy-events
        emit ReservationActionSuperseded(reservationKey, pendingNonce);
    }

    /// @notice Parses the given output vector and returns its single output.
    ///         Reverts if the vector does not contain exactly one output.
    function parseSingleOutput(bytes memory outputVector)
        internal
        pure
        returns (bytes memory output)
    {
        (, uint256 outputsCount) = outputVector.parseVarInt();
        require(
            outputsCount == 1,
            "Reservation transaction must have a single output"
        );

        output = outputVector.extractOutputAtIndex(0);
    }
}
