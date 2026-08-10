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
import "./MovingFunds.sol";
import "./Redemption.sol";
import "./Reservation.sol";
import "./Wallets.sol";

import "../bank/Bank.sol";
import "../vault/IReservationFeeFinancer.sol";

/// @title Bridge UTXO reservations — settlement
/// @notice SPV settlement side of the two-phase reservation model (see
///         `Reservation` for the request/authorization side and RFC 13 for
///         the architecture). Every proof settles one requested
///         *generation*, named explicitly by `(reservationKey,
///         requestNonce)`, and is validated exclusively against that
///         generation's snapshotted action record — never against live
///         parameters.
/// @dev Settlement rules shared by all action types:
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
    using BytesLib for bytes;

    event ReservationAccepted(
        uint256 indexed reservationKey,
        uint64 requestNonce,
        bytes20 indexed walletPubKeyHash,
        address indexed owner,
        bytes32 anchorTxHash,
        uint64 anchorAmount,
        uint32 expiresAt
    );

    event ReservedRedemptionCompleted(
        uint256 indexed reservationKey,
        uint64 requestNonce,
        bytes32 redemptionTxHash
    );

    event ReservationReanchored(
        uint256 indexed reservationKey,
        uint64 requestNonce,
        bytes20 indexed newWalletPubKeyHash,
        bytes32 newAnchorTxHash,
        uint64 newAnchorAmount
    );

    event ReservationDissolved(
        uint256 indexed reservationKey,
        uint64 requestNonce,
        bytes20 indexed walletPubKeyHash,
        bytes32 dissolutionTxHash
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
    ///         Numbering matches `Reservation.ActionType` minus `None`.
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
    /// @param mainUtxo Data of the main UTXO expected by a `Dissolution`
    ///        generation; ignored otherwise.
    /// @param reservationKey The key of the target reservation.
    /// @param requestNonce The generation being settled. Late settlements
    ///        name an older, timed-out generation.
    function submitReservationProof(
        BridgeState.Storage storage self,
        uint8 proofType,
        BitcoinTx.Info calldata txInfo,
        BitcoinTx.Proof calldata proof,
        BitcoinTx.UTXO calldata mainUtxo,
        uint256 reservationKey,
        uint64 requestNonce
    ) external {
        ProofType parsedProofType = ProofType(proofType);

        if (parsedProofType == ProofType.Acceptance) {
            submitReservationAcceptanceProof(
                self,
                txInfo,
                proof,
                reservationKey,
                requestNonce
            );
        } else if (parsedProofType == ProofType.Redemption) {
            submitReservedRedemptionProof(
                self,
                txInfo,
                proof,
                reservationKey,
                requestNonce
            );
        } else if (parsedProofType == ProofType.Reanchor) {
            submitReservationReanchorProof(
                self,
                txInfo,
                proof,
                reservationKey,
                requestNonce
            );
        } else {
            submitReservationDissolutionProof(
                self,
                txInfo,
                proof,
                mainUtxo,
                reservationKey,
                requestNonce
            );
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

    /// @notice Converts a late settlement into the existing stranded-position
    ///         accounting when its target wallet can no longer manage the
    ///         newly settled anchor.
    /// @dev Live and MovingFunds wallets can still manage the anchor.
    ///      Closing and Closed wallets are stranded immediately. Terminated
    ///      wallets retain the permissionless `notifyReservationStranded`
    ///      cleanup path unless this lineage was already stranded before the
    ///      proof. In that case, restore the Stranded state latch before
    ///      cleanup so the reconstructed accounting is released without
    ///      emitting duplicate recovery evidence.
    function strandLateSettlementIfTargetWalletClosed(
        BridgeState.Storage storage self,
        Reservation.ReservationRequest storage reservation,
        uint256 reservationKey,
        bool late,
        bool evidenceAlreadyEmitted
    ) internal {
        if (!late) {
            return;
        }

        Wallets.WalletState walletState = self
            .registeredWallets[reservation.walletPubKeyHash]
            .state;
        if (
            walletState == Wallets.WalletState.Closing ||
            walletState == Wallets.WalletState.Closed ||
            (evidenceAlreadyEmitted &&
                walletState == Wallets.WalletState.Terminated)
        ) {
            if (evidenceAlreadyEmitted) {
                reservation.state = Reservation.ReservationState.Stranded;
            }
            self.strandReservation(reservation, reservationKey);
        }
    }

    /// @notice Validates the position can settle the loaded action and, for a
    ///         timed-out generation whose position was already stranded,
    ///         reconstructs the source anchor's tracking before settlement.
    /// @dev Stranding releases the global and wallet accounting, enumeration,
    ///      and reverse anchor index. A transaction confirmed before stranding
    ///      must still settle, so the proof transaction atomically restores
    ///      those surfaces before the ordinary settlement path consumes or
    ///      moves them. Caps are request-time throttles and are deliberately
    ///      not re-checked for an already-confirmed Bitcoin transaction.
    function prepareReservationForSettlement(
        BridgeState.Storage storage self,
        Reservation.ReservationRequest storage reservation,
        uint256 reservationKey,
        bool late
    ) internal {
        bool stranded = reservation.state ==
            Reservation.ReservationState.Stranded;
        require(
            reservation.state == Reservation.ReservationState.Active ||
                reservation.state ==
                Reservation.ReservationState.ActionPending ||
                (stranded && late),
            "Reservation is not settleable"
        );

        if (!stranded) {
            return;
        }

        uint256 anchorUtxoKey = uint256(
            keccak256(
                abi.encodePacked(
                    reservation.anchorTxHash,
                    reservation.anchorTxOutputIndex
                )
            )
        );
        // Multiple timed-out generations can describe the same Bitcoin
        // transaction. Once one proof consumes the anchor, do not let another
        // generation reconstruct the position or finance the miner fee again.
        require(
            !self.spentMainUTXOs[anchorUtxoKey],
            "Reservation anchor already spent"
        );

        self.reservationTotalAmount += reservation.anchorAmount;
        self.walletReservationsCount[reservation.walletPubKeyHash] += 1;
        self.walletReservationsAmount[
            reservation.walletPubKeyHash
        ] += reservation.anchorAmount;
        Reservation.addWalletReservationKey(
            self,
            reservation.walletPubKeyHash,
            reservationKey
        );
        self.reservationsByAnchorUtxo[anchorUtxoKey] = reservationKey;
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
    ///      request time; the routing cannot change while the total
    ///      reserved amount (which includes this authorization's reserved
    ///      capacity) is non-zero.
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
        // Stale notification may already have released this pending marker
        // before a late acceptance proof arrives. Consume the marker and its
        // counter exactly once, while always recording the proven sweep.
        if (
            self.pendingReservedDeposit[reservationKey].walletPubKeyHash !=
            bytes20(0)
        ) {
            delete self.pendingReservedDeposit[reservationKey];
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

        if (late) {
            // A newer acceptance generation may have been authorized after
            // this one timed out: the position stayed Unknown, so
            // re-authorization was possible. Only the position's current
            // generation is ever reachable by notifyReservationActionTimeout
            // and this deposit is now consumed, so a still-pending newer
            // generation's reserved capacity would leak permanently. Unwind
            // it. (A newer generation that already timed out released its
            // own capacity — nothing to unwind there.)
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

            // The timeout released the capacity reserved at request time;
            // re-take it for the actual anchor value. Deliberately no cap
            // check: caps are request-time throttles and the anchor is
            // already confirmed on Bitcoin.
            self.reservationTotalAmount += anchorAmount;
            self.walletReservationsCount[action.targetWalletPubKeyHash] += 1;
            self.walletReservationsAmount[
                action.targetWalletPubKeyHash
            ] += anchorAmount;
            emit ReservationLateSettled(
                reservationKey,
                requestNonce,
                Reservation.ActionType.Acceptance
            );
        } else {
            // Release the difference between the reserved upper bound
            // (deposit value) and the actual anchor value (miner fee).
            self.reservationTotalAmount -= (action.amount - anchorAmount);
            self.walletReservationsAmount[
                action.targetWalletPubKeyHash
            ] -= (action.amount - anchorAmount);
        }

        address depositor = self.deposits[reservationKey].depositor;

        Reservation.ReservationRequest storage reservation = self.reservations[
            reservationKey
        ];

        /* solhint-disable-next-line not-rely-on-time */
        uint32 expiresAt = uint32(block.timestamp) +
            self.reservationTermSeconds;

        reservation.owner = depositor;
        reservation.mintedAmount = anchorAmount;
        /* solhint-disable-next-line not-rely-on-time */
        reservation.acceptedAt = uint32(block.timestamp);
        reservation.walletPubKeyHash = action.targetWalletPubKeyHash;
        reservation.anchorAmount = anchorAmount;
        reservation.expiresAt = expiresAt;
        reservation.anchorTxHash = anchorTxHash;
        reservation.anchorTxOutputIndex = 0;
        reservation.state = Reservation.ReservationState.Active;
        reservation.dissolutionEligibleAt =
            expiresAt +
            self.reservationDissolutionDelay;

        self.reservationsByAnchorUtxo[
            uint256(keccak256(abi.encodePacked(anchorTxHash, uint32(0))))
        ] = reservationKey;
        Reservation.addWalletReservationKey(
            self,
            action.targetWalletPubKeyHash,
            reservationKey
        );

        // slither-disable-next-line reentrancy-events
        emit ReservationAccepted(
            reservationKey,
            requestNonce,
            action.targetWalletPubKeyHash,
            depositor,
            anchorTxHash,
            anchorAmount,
            expiresAt
        );

        // Credit the gross anchored amount through the vault the deposit
        // was revealed to. Using the deposit's immutable `vault` (verified
        // to equal the reservation vault when the acceptance was requested)
        // rather than the live `reservationVault` keeps a late settlement
        // routing to the depositor's chosen vault even if governance
        // re-pointed or disabled the reservation vault in the interim. The
        // per-deposit treasury fee computed at reveal time is deliberately
        // ignored: reservation claims are minted gross and all protocol
        // fees are charged as explicit transfers by the vault.
        address[] memory depositors = new address[](1);
        depositors[0] = depositor;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = anchorAmount;
        self.bank.increaseBalanceAndCall(
            self.deposits[reservationKey].vault,
            depositors,
            amounts
        );
    }

    /// @notice Used by the wallet to prove the BTC reserved redemption
    ///         transaction of a generation and settle it. The transaction
    ///         must spend exactly the reservation's anchor outpoint as its
    ///         sole input and pay the generation's redeemer output script
    ///         as its sole output.
    /// @dev Requirements:
    ///      - The named generation must be a settleable redemption,
    ///      - For a pending generation, the watchtower delay applicable to
    ///        the generation must have elapsed (the on-chain enforcement
    ///        of the authorize-before-signing rule),
    ///      - `redemptionTx` must spend the reservation's current anchor
    ///        outpoint as its sole input,
    ///      - `redemptionTx` must have a single output paying the
    ///        generation's redeemer script with a value within the
    ///        snapshotted range,
    ///      - A late settlement is rejected when the position's current
    ///        pending redemption generation matches the transaction as
    ///        well; the proof must then settle the pending generation.
    function submitReservedRedemptionProof(
        BridgeState.Storage storage self,
        BitcoinTx.Info calldata redemptionTx,
        BitcoinTx.Proof calldata redemptionProof,
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
                Reservation.ActionType.Redemption
            );

        Reservation.ReservationRequest storage reservation = self.reservations[
            reservationKey
        ];
        prepareReservationForSettlement(
            self,
            reservation,
            reservationKey,
            late
        );

        if (!late) {
            require(
                reservation.requestNonce == requestNonce,
                "Not the current generation"
            );

            // On-chain authorization enforcement: the wallet may only sign
            // once the watchtower delay of this generation has elapsed
            // without a veto, and the proof path verifies it — an early
            // broadcast cannot finalize before the guardians' window
            // closes.
            if (self.redemptionWatchtower != address(0)) {
                require(
                    /* solhint-disable-next-line not-rely-on-time */
                    block.timestamp >=
                        uint256(action.requestedAt) +
                            IRedemptionWatchtower(self.redemptionWatchtower)
                                .getReservedRedemptionDelay(
                                    reservationKey,
                                    requestNonce
                                ),
                    "Watchtower delay has not elapsed"
                );
            }
        }

        bytes32 redemptionTxHash = self.validateProof(
            redemptionTx,
            redemptionProof
        );

        consumeAnchor(self, reservation, redemptionTx.inputVector);

        bytes memory output = parseSingleOutput(redemptionTx.outputVector);
        uint64 outputValue = output.extractValue();

        {
            bytes memory outputScript = output.slice(8, output.length - 8);
            require(
                keccak256(outputScript) == action.redeemerOutputScriptHash,
                "Output does not pay the requested redeemer script"
            );
        }

        // Underflow-safe range check against the position's anchor value
        // (unchanged since the generation was requested: the anchor can
        // only be consumed by proving a transaction that spends it) and
        // the generation's snapshotted fee bound.
        require(
            outputValue <= reservation.anchorAmount &&
                reservation.anchorAmount - outputValue <= action.txMaxFee,
            "Output value is not within the acceptable range"
        );

        if (late) {
            resolveLateRedemptionAgainstPending(
                self,
                reservation,
                reservationKey,
                action,
                outputValue
            );

            emit ReservationLateSettled(
                reservationKey,
                requestNonce,
                Reservation.ActionType.Redemption
            );
            // No Bank movement: the timeout already refunded the escrowed
            // claim and slashed the wallet. The registry records the
            // confirmed spend and closes the lineage.
        }

        action.state = Reservation.ActionState.Settled;
        self.closeReservation(reservation, reservationKey);

        // slither-disable-next-line reentrancy-events
        emit ReservedRedemptionCompleted(
            reservationKey,
            requestNonce,
            redemptionTxHash
        );

        if (!late) {
            // Burn the gross minted amount held by the Bridge since the
            // redemption request.
            self.bank.decreaseBalance(action.amount);
        }
    }

    /// @notice Used by the wallet to prove a re-anchor transaction moving a
    ///         reservation's anchor outpoint to the authorized target
    ///         wallet in a 1-input-1-output spend.
    /// @dev Requirements:
    ///      - The named generation must be a settleable re-anchor,
    ///      - `reanchorTx` must spend the current anchor outpoint as its
    ///        sole input and create a single P2(W)PKH output paying the
    ///        generation's authorized target wallet,
    ///      - The miner fee must respect the snapshotted bound and the
    ///        re-anchored value must stay above the dust floor (the
    ///        snapshotted fee bound), preserving positive redemption
    ///        value.
    function submitReservationReanchorProof(
        BridgeState.Storage storage self,
        BitcoinTx.Info calldata reanchorTx,
        BitcoinTx.Proof calldata reanchorProof,
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
                Reservation.ActionType.Reanchor
            );

        Reservation.ReservationRequest storage reservation = self.reservations[
            reservationKey
        ];
        bool evidenceAlreadyEmitted = reservation.state ==
            Reservation.ReservationState.Stranded;
        prepareReservationForSettlement(
            self,
            reservation,
            reservationKey,
            late
        );
        if (!late) {
            require(
                reservation.requestNonce == requestNonce,
                "Not the current generation"
            );
        }

        bytes32 reanchorTxHash = self.validateProof(reanchorTx, reanchorProof);

        consumeAnchor(self, reservation, reanchorTx.inputVector);

        bytes memory output = parseSingleOutput(reanchorTx.outputVector);
        bytes20 newWalletPubKeyHash = self.extractPubKeyHash(output);
        uint64 newAnchorAmount = output.extractValue();

        require(
            newWalletPubKeyHash == action.targetWalletPubKeyHash,
            "Output must pay the authorized target wallet"
        );

        // `newAnchorAmount <= anchorAmount` is guaranteed by Bitcoin
        // consensus (the re-anchor output cannot exceed its input).
        require(
            reservation.anchorAmount - newAnchorAmount <= action.txMaxFee,
            "Transaction fee is too high"
        );

        // Dust floor: the re-anchored amount must stay strictly above the
        // snapshotted per-transaction fee bound, keeping the anchor clear
        // of dust and preserving positive redemption value.
        require(
            newAnchorAmount > action.txMaxFee,
            "Re-anchor amount below the dust floor"
        );

        if (late) {
            // The timeout released the target wallet's reserved count and
            // amount; re-take them. Deliberately no cap check (see
            // acceptance).
            self.walletReservationsCount[newWalletPubKeyHash] += 1;
            self.walletReservationsAmount[newWalletPubKeyHash] += reservation
                .anchorAmount;

            // A newer pending generation references an anchor this
            // transaction just consumed; unwind it.
            if (
                reservation.state == Reservation.ReservationState.ActionPending
            ) {
                unwindPendingAction(self, reservation, reservationKey, true);
            }

            // slither-disable-next-line reentrancy-events
            emit ReservationLateSettled(
                reservationKey,
                requestNonce,
                Reservation.ActionType.Reanchor
            );
        }

        // The source wallet's count and amount are released now; the
        // target wallet's were reserved at request time (or re-taken
        // above). The target reserved the pre-hop anchor value; release
        // the miner-fee delta.
        self.walletReservationsCount[reservation.walletPubKeyHash] -= 1;
        self.walletReservationsAmount[
            reservation.walletPubKeyHash
        ] -= reservation.anchorAmount;
        self.walletReservationsAmount[newWalletPubKeyHash] -= (reservation
            .anchorAmount - newAnchorAmount);

        uint64 minerFee = reservation.anchorAmount - newAnchorAmount;

        // The miner fee reduces the on-chain earmarked amount.
        self.reservationTotalAmount -= minerFee;

        Reservation.removeWalletReservationKey(
            self,
            reservation.walletPubKeyHash,
            reservationKey
        );
        Reservation.addWalletReservationKey(
            self,
            newWalletPubKeyHash,
            reservationKey
        );

        reservation.walletPubKeyHash = newWalletPubKeyHash;
        reservation.anchorAmount = newAnchorAmount;
        // The claim always equals the anchor: the miner fee is financed
        // from the vault's custody-fee reserve (which burns supply in
        // lockstep with the backing loss), and the claim is written down
        // to the new anchor value. The owner's redemption surrender
        // shrinks accordingly — rotation costs are borne by the custody
        // fee that was priced for them, not by the owner and not by the
        // peg.
        reservation.mintedAmount = newAnchorAmount;
        reservation.anchorTxHash = reanchorTxHash;
        reservation.anchorTxOutputIndex = 0;
        reservation.state = Reservation.ReservationState.Active;

        if (minerFee > 0) {
            IReservationFeeFinancer(self.deposits[reservationKey].vault)
                .financeInKindFee(minerFee);
        }

        action.state = Reservation.ActionState.Settled;

        self.reservationsByAnchorUtxo[
            uint256(keccak256(abi.encodePacked(reanchorTxHash, uint32(0))))
        ] = reservationKey;

        // slither-disable-next-line reentrancy-events
        emit ReservationReanchored(
            reservationKey,
            requestNonce,
            newWalletPubKeyHash,
            reanchorTxHash,
            newAnchorAmount
        );

        strandLateSettlementIfTargetWalletClosed(
            self,
            reservation,
            reservationKey,
            late,
            evidenceAlreadyEmitted
        );
    }

    /// @notice Used by the wallet to prove a dissolution transaction
    ///         merging an expired reservation's anchor outpoint into the
    ///         wallet's main UTXO, per the generation's authorization.
    /// @dev Requirements:
    ///      - The named generation must be a settleable dissolution,
    ///      - If the generation's snapshot recorded a main UTXO,
    ///        `dissolutionTx` must spend exactly the anchor outpoint
    ///        (first input) and that main UTXO (second input, matching the
    ///        `mainUtxo` parameter); otherwise it must spend exactly the
    ///        anchor outpoint,
    ///      - `dissolutionTx` must have a single P2(W)PKH output locking
    ///        funds back on the custodying wallet's public key hash.
    ///
    ///      If the wallet's registry main UTXO still equals the snapshot,
    ///      the output becomes the wallet's new main UTXO. If it drifted —
    ///      possible only for no-main-UTXO snapshots, when e.g. a deposit
    ///      sweep landed first — the output is registered as a moved-funds
    ///      sweep request so the wallet later consolidates it, keeping the
    ///      backing tracked either way.
    function submitReservationDissolutionProof(
        BridgeState.Storage storage self,
        BitcoinTx.Info calldata dissolutionTx,
        BitcoinTx.Proof calldata dissolutionProof,
        BitcoinTx.UTXO calldata mainUtxo,
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
                Reservation.ActionType.Dissolution
            );

        Reservation.ReservationRequest storage reservation = self.reservations[
            reservationKey
        ];
        prepareReservationForSettlement(
            self,
            reservation,
            reservationKey,
            late
        );
        if (!late) {
            require(
                reservation.requestNonce == requestNonce,
                "Not the current generation"
            );
        }

        bytes32 dissolutionTxHash = self.validateProof(
            dissolutionTx,
            dissolutionProof
        );

        uint64 inputsTotalValue = processDissolutionInputs(
            self,
            reservation,
            dissolutionTx.inputVector,
            action.expectedMainUtxoHash,
            mainUtxo
        );

        uint64 outputValue = validateDissolutionOutput(
            self,
            dissolutionTx.outputVector,
            reservation.walletPubKeyHash,
            inputsTotalValue,
            action.txMaxFee
        );

        settleDissolution(
            self,
            reservationKey,
            requestNonce,
            action,
            late,
            dissolutionTxHash,
            outputValue
        );

        // The dissolution miner fee is a backing loss no party surrenders
        // TBTC for (the owner keeps their minted balance as an ordinary
        // pooled claim): finance it from the vault's custody-fee reserve
        // so total supply reconciles with the net backing added,
        // atomically with the settlement.
        uint64 dissolutionFee = inputsTotalValue - outputValue;
        if (dissolutionFee > 0) {
            IReservationFeeFinancer(self.deposits[reservationKey].vault)
                .financeInKindFee(dissolutionFee);
        }
    }

    /// @notice Parses the dissolution transaction's single output, validates
    ///         it pays the custodying wallet within the snapshotted fee
    ///         bound and returns its value.
    function validateDissolutionOutput(
        BridgeState.Storage storage self,
        bytes memory outputVector,
        bytes20 walletPubKeyHash,
        uint64 inputsTotalValue,
        uint64 txMaxFee
    ) internal view returns (uint64 outputValue) {
        bytes memory output = parseSingleOutput(outputVector);
        outputValue = output.extractValue();
        require(
            self.extractPubKeyHash(output) == walletPubKeyHash,
            "Dissolution output must pay to the custodying wallet"
        );
        require(
            inputsTotalValue - outputValue <= txMaxFee,
            "Transaction fee is too high"
        );
    }

    /// @notice Finalizes a dissolution settlement: registers the output as
    ///         the wallet's new main UTXO (or as a moved-funds sweep
    ///         request when the registry drifted), unless the wallet was
    ///         terminated after authorization. In that case, settles the
    ///         confirmed spend as stranded recovery evidence instead.
    ///         Releases the per-wallet main-UTXO action lock, unwinds a
    ///         superseded pending generation on late settlements and closes
    ///         or strands the position.
    function settleDissolution(
        BridgeState.Storage storage self,
        uint256 reservationKey,
        uint64 requestNonce,
        Reservation.ReservationAction storage action,
        bool late,
        bytes32 dissolutionTxHash,
        uint64 outputValue
    ) internal {
        Reservation.ReservationRequest storage reservation = self.reservations[
            reservationKey
        ];
        bytes20 walletPubKeyHash = reservation.walletPubKeyHash;

        Wallets.Wallet storage wallet = self.registeredWallets[
            walletPubKeyHash
        ];
        bool walletTerminated = wallet.state == Wallets.WalletState.Terminated;

        if (wallet.mainUtxoHash == action.expectedMainUtxoHash) {
            // A timed-out dissolution may settle after a different
            // reservation acquired the wallet lock against the same main
            // UTXO. This proof consumes that shared snapshot, so the newer
            // generation can no longer confirm and must be superseded now.
            if (late && action.expectedMainUtxoHash != bytes32(0)) {
                supersedeConflictingDissolution(
                    self,
                    walletPubKeyHash,
                    reservationKey
                );
            }

            if (walletTerminated) {
                // A nonzero snapshot was consumed by the proven transaction.
                // Do not leave the terminated wallet pointing at that spent
                // UTXO. The dissolution output is deliberately not installed
                // as a replacement: Bridge spending paths reject Terminated
                // wallets and their registry group is already closed.
                if (action.expectedMainUtxoHash != bytes32(0)) {
                    delete wallet.mainUtxoHash;
                }
            } else {
                // The dissolution output becomes the wallet's new main UTXO:
                // the reserved backing rejoins the pooled supply.
                wallet.mainUtxoHash = keccak256(
                    abi.encodePacked(dissolutionTxHash, uint32(0), outputValue)
                );
                Wallets.rearmMovingFundsTimeout(self, walletPubKeyHash);
            }
        } else {
            require(
                action.expectedMainUtxoHash == bytes32(0),
                "Recorded main UTXO can no longer be spent"
            );

            if (!walletTerminated) {
                // Registry drift: another transaction (e.g. a deposit sweep)
                // registered a main UTXO after this no-main-UTXO dissolution
                // was authorized. The confirmed dissolution output is a
                // wallet-held UTXO the registry must keep tracking; register
                // it for the moved-funds sweep machinery to consolidate.
                MovingFunds.MovedFundsSweepRequest storage sweepRequest = self
                    .movedFundsSweepRequests[
                        uint256(
                            keccak256(
                                abi.encodePacked(dissolutionTxHash, uint32(0))
                            )
                        )
                    ];
                sweepRequest.walletPubKeyHash = walletPubKeyHash;
                sweepRequest.value = outputValue;
                /* solhint-disable-next-line not-rely-on-time */
                sweepRequest.createdAt = uint32(block.timestamp);
                sweepRequest.state = MovingFunds
                    .MovedFundsSweepRequestState
                    .Pending;
                wallet.pendingMovedFundsSweepRequestsCount++;
            }
        }

        if (late) {
            if (
                reservation.state == Reservation.ReservationState.ActionPending
            ) {
                unwindPendingAction(self, reservation, reservationKey, false);
            }
            // slither-disable-next-line reentrancy-events
            emit ReservationLateSettled(
                reservationKey,
                requestNonce,
                Reservation.ActionType.Dissolution
            );
        } else {
            // Release the per-wallet main-UTXO action lock taken at
            // request time (a timed-out generation released it already,
            // and it may have been re-taken by another reservation since).
            if (
                self.walletPendingDissolution[walletPubKeyHash] ==
                reservationKey
            ) {
                delete self.walletPendingDissolution[walletPubKeyHash];
            }
        }

        action.state = Reservation.ActionState.Settled;
        if (walletTerminated) {
            // Use the same accounting and evidence transition as direct
            // Terminated-wallet stranding. The dissolution proof has already
            // marked the consumed anchor honestly spent; the owner's minted
            // balance remains an ordinary pooled claim.
            self.strandReservation(reservation, reservationKey);
        } else {
            self.closeReservation(reservation, reservationKey);
        }

        // slither-disable-next-line reentrancy-events
        emit ReservationDissolved(
            reservationKey,
            requestNonce,
            walletPubKeyHash,
            dissolutionTxHash
        );
    }

    /// @notice Supersedes another reservation's pending dissolution when a
    ///         late proof consumes the wallet main UTXO it snapshotted.
    function supersedeConflictingDissolution(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash,
        uint256 settledReservationKey
    ) internal {
        uint256 pendingReservationKey = self.walletPendingDissolution[
            walletPubKeyHash
        ];
        if (
            pendingReservationKey == 0 ||
            pendingReservationKey == settledReservationKey
        ) {
            return;
        }

        Reservation.ReservationRequest storage pendingReservation = self
            .reservations[pendingReservationKey];
        Reservation.ReservationAction storage pendingAction = self
            .reservationActions[
                Reservation.actionKey(
                    pendingReservationKey,
                    pendingReservation.requestNonce
                )
            ];
        require(
            pendingReservation.state ==
                Reservation.ReservationState.ActionPending &&
                pendingAction.actionType ==
                Reservation.ActionType.Dissolution &&
                pendingAction.state == Reservation.ActionState.Pending,
            "Invalid wallet dissolution lock"
        );

        unwindPendingAction(
            self,
            pendingReservation,
            pendingReservationKey,
            false
        );
        pendingReservation.state = Reservation.ReservationState.Active;
    }

    /// @notice Resolves a late redemption settlement against the position's
    ///         current pending generation. If the pending generation is a
    ///         redemption that matches the proven transaction as well, the
    ///         proof must settle against it instead (the pending settlement
    ///         burns the escrow — the correct accounting whenever both
    ///         generations can claim the transaction); otherwise the
    ///         pending generation's anchor is provably gone and it is
    ///         unwound.
    function resolveLateRedemptionAgainstPending(
        BridgeState.Storage storage self,
        Reservation.ReservationRequest storage reservation,
        uint256 reservationKey,
        Reservation.ReservationAction storage action,
        uint64 outputValue
    ) internal {
        if (reservation.state != Reservation.ReservationState.ActionPending) {
            return;
        }

        Reservation.ReservationAction storage pendingAction = self
            .reservationActions[
                Reservation.actionKey(reservationKey, reservation.requestNonce)
            ];
        if (
            pendingAction.actionType == Reservation.ActionType.Redemption &&
            pendingAction.redeemerOutputScriptHash ==
            action.redeemerOutputScriptHash &&
            reservation.anchorAmount - outputValue <= pendingAction.txMaxFee
        ) {
            revert("Must settle the pending generation");
        }

        // The pending generation cannot claim the transaction; its anchor
        // is gone, so unwind it.
        unwindPendingAction(self, reservation, reservationKey, false);
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
            self.walletReservationsCount[
                pendingAction.targetWalletPubKeyHash
            ] -= 1;
            self.walletReservationsAmount[
                pendingAction.targetWalletPubKeyHash
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
            self.reservationTotalAmount -= pendingAction.amount;
            self.walletReservationsCount[
                pendingAction.targetWalletPubKeyHash
            ] -= 1;
            self.walletReservationsAmount[
                pendingAction.targetWalletPubKeyHash
            ] -= pendingAction.amount;
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

    /// @notice Asserts the given input vector contains exactly one input
    ///         pointing to the reservation's current anchor outpoint, marks
    ///         that outpoint as correctly spent (making it recognized by the
    ///         fraud challenge defeat path) and clears its anchor index
    ///         entry.
    function consumeAnchor(
        BridgeState.Storage storage self,
        Reservation.ReservationRequest storage reservation,
        bytes memory inputVector
    ) internal {
        (bytes32 outpointTxHash, uint32 outpointIndex) = OutboundTx
            .parseWalletOutboundTxInput(inputVector);

        require(
            reservation.anchorTxHash == outpointTxHash &&
                reservation.anchorTxOutputIndex == outpointIndex,
            "Transaction input must point to the reservation anchor"
        );

        uint256 anchorUtxoKey = uint256(
            keccak256(abi.encodePacked(outpointTxHash, outpointIndex))
        );

        // Anchor outpoints are wallet-controlled UTXOs. Marking a consumed
        // anchor in `spentMainUTXOs` -- the existing registry of honestly
        // spent wallet UTXOs -- makes the spend recognized by
        // `Fraud.defeatFraudChallenge` without modifying the fraud library.
        self.spentMainUTXOs[anchorUtxoKey] = true;
        delete self.reservationsByAnchorUtxo[anchorUtxoKey];
    }

    /// @notice Processes the dissolution transaction inputs: the first
    ///         input must spend the reservation's anchor outpoint and, if
    ///         the generation's snapshot recorded a main UTXO, the second
    ///         input must spend exactly that main UTXO. Marks both consumed
    ///         outpoints as correctly spent.
    /// @return inputsTotalValue Sum of all inputs values.
    function processDissolutionInputs(
        BridgeState.Storage storage self,
        Reservation.ReservationRequest storage reservation,
        bytes memory inputVector,
        bytes32 expectedMainUtxoHash,
        BitcoinTx.UTXO calldata mainUtxo
    ) internal returns (uint64 inputsTotalValue) {
        bool mainUtxoExpected = expectedMainUtxoHash != bytes32(0);

        (uint256 varIntLength, uint256 inputsCount) = inputVector.parseVarInt();
        require(
            inputsCount == (mainUtxoExpected ? 2 : 1),
            "Wrong number of dissolution transaction inputs"
        );

        // The first input must spend the reservation's anchor outpoint.
        uint256 nextInputIndex = consumeAnchorInputAt(
            self,
            reservation,
            inputVector,
            1 + varIntLength
        );
        inputsTotalValue = reservation.anchorAmount;

        if (mainUtxoExpected) {
            require(
                keccak256(
                    abi.encodePacked(
                        mainUtxo.txHash,
                        mainUtxo.txOutputIndex,
                        mainUtxo.txOutputValue
                    )
                ) == expectedMainUtxoHash,
                "Invalid main UTXO data"
            );

            consumeMainUtxoInputAt(self, inputVector, nextInputIndex, mainUtxo);
            inputsTotalValue += mainUtxo.txOutputValue;
        }

        return inputsTotalValue;
    }

    /// @notice Asserts the input at the given starting index spends the
    ///         reservation's current anchor outpoint, marks that outpoint as
    ///         correctly spent and clears its anchor index entry.
    /// @return nextInputIndex Starting index of the next input.
    function consumeAnchorInputAt(
        BridgeState.Storage storage self,
        Reservation.ReservationRequest storage reservation,
        bytes memory inputVector,
        uint256 inputStartingIndex
    ) internal returns (uint256 nextInputIndex) {
        bytes32 outpointTxHash = inputVector.extractInputTxIdLeAt(
            inputStartingIndex
        );
        uint32 outpointIndex = BTCUtils.reverseUint32(
            uint32(inputVector.extractTxIndexLeAt(inputStartingIndex))
        );

        require(
            reservation.anchorTxHash == outpointTxHash &&
                reservation.anchorTxOutputIndex == outpointIndex,
            "Transaction input must point to the reservation anchor"
        );

        uint256 anchorUtxoKey = uint256(
            keccak256(abi.encodePacked(outpointTxHash, outpointIndex))
        );
        // See `consumeAnchor` for the `spentMainUTXOs` rationale.
        self.spentMainUTXOs[anchorUtxoKey] = true;
        delete self.reservationsByAnchorUtxo[anchorUtxoKey];

        nextInputIndex =
            inputStartingIndex +
            inputVector.determineInputLengthAt(inputStartingIndex);
    }

    /// @notice Asserts the input at the given starting index spends the
    ///         given main UTXO and marks it as correctly spent.
    function consumeMainUtxoInputAt(
        BridgeState.Storage storage self,
        bytes memory inputVector,
        uint256 inputStartingIndex,
        BitcoinTx.UTXO calldata mainUtxo
    ) internal {
        bytes32 outpointTxHash = inputVector.extractInputTxIdLeAt(
            inputStartingIndex
        );
        uint32 outpointIndex = BTCUtils.reverseUint32(
            uint32(inputVector.extractTxIndexLeAt(inputStartingIndex))
        );

        require(
            mainUtxo.txHash == outpointTxHash &&
                mainUtxo.txOutputIndex == outpointIndex,
            "Transaction input must point to the wallet's main UTXO"
        );

        self.spentMainUTXOs[
            uint256(keccak256(abi.encodePacked(outpointTxHash, outpointIndex)))
        ] = true;
    }
}
