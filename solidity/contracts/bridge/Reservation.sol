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
import "./Wallets.sol";

import "../bank/Bank.sol";

/// @title Bridge UTXO reservations
/// @notice The library handles the logic for reserving deposited UTXOs so
///         that a depositor's coins are custodied without ever being
///         commingled with the pooled supply and are returned in-kind --
///         with an unbroken 1-input-1-output lineage -- upon redemption.
/// @dev A reserved deposit is a regular revealed deposit routed to the
///      designated reservation vault (`reveal.vault == reservationVault`).
///      Instead of being swept into the wallet's main UTXO, a reserved
///      deposit is *anchored*: the wallet performs a 1-input-1-output spend
///      of the deposit into a fresh wallet-controlled P2(W)PKH output that
///      carries no refund path. The Bank balance is credited only when the
///      SPV proof of that anchor transaction is submitted. The anchor thus
///      mirrors the sweep's refund-disabling role while dropping its
///      consolidating role -- balances are never credited against an output
///      the depositor could still claw back, and the coins never merge with
///      the pooled supply.
///
///      The registry tracks the reservation's current anchor outpoint
///      through optional re-anchoring hops (wallet migration) until the
///      reservation is closed by an in-kind redemption, or -- once the
///      custody term and grace period elapse -- dissolved into the wallet's
///      main UTXO, at which point the owner's balance simply remains an
///      ordinary pooled claim.
///
///      Claim accounting: the amount credited (`mintedAmount`) is the gross
///      anchor output value; the per-deposit treasury fee computed at reveal
///      time is deliberately not netted. All protocol fees are charged by
///      the reservation vault as explicit transfers. Bitcoin miner fees are
///      the only in-kind deductions: the anchor and any re-anchor fees
///      reduce the on-chain `anchorAmount`, while the reserved redemption
///      always burns the full `mintedAmount`, so supply and backing
///      reconcile exactly when the reservation closes via redemption.
///
///      Fraud-defense integration: accepting a reservation marks the
///      underlying deposit as swept (making the deposit outpoint recognized
///      by `Fraud.defeatFraudChallenge`), and every proven consumption of an
///      anchor outpoint (redemption, re-anchor, dissolution) records it in
///      `spentMainUTXOs` -- the existing registry of honestly-spent,
///      wallet-controlled outpoints the fraud defeat path consults.
library Reservation {
    using BridgeState for BridgeState.Storage;
    using Wallets for BridgeState.Storage;
    using BitcoinTx for BridgeState.Storage;

    using BTCUtils for bytes;
    using BytesLib for bytes;

    /// @notice Represents the state of a reservation.
    enum ReservationState {
        /// @dev The reservation is unknown to the Bridge.
        Unknown,
        /// @dev The reservation was accepted (anchor proven, balance
        ///      credited) and its anchor outpoint is under wallet custody.
        Active,
        /// @dev The owner requested an in-kind redemption of the reserved
        ///      outpoint and surrendered the gross balance. The wallet is
        ///      expected to spend the anchor to the redeemer script.
        RedemptionRequested,
        /// @dev The reservation was closed, either by a proven in-kind
        ///      redemption or by dissolution into the wallet's main UTXO.
        Closed
    }

    /// @notice Represents a UTXO reservation.
    struct ReservationRequest {
        // The reservation owner holding the in-kind redemption right. Set to
        // the deposit's depositor at acceptance time.
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
        // layer fact -- the anchor output carries no timelock. After
        // `expiresAt + reservationGracePeriod` the wallet may dissolve the
        // reservation into its main UTXO.
        // XXX: Unsigned 32-bit int unix seconds, will break February 7th 2106.
        uint32 expiresAt;
        // Hash of the Bitcoin transaction holding the current anchor output.
        bytes32 anchorTxHash;
        // Output index of the current anchor output. Always 0 given anchor
        // transactions have a single output; kept for auditability.
        uint32 anchorTxOutputIndex;
        // Current state of the reservation.
        ReservationState state;
        // UNIX timestamp the pending reserved redemption was requested at.
        // Zero when no redemption is pending.
        // XXX: Unsigned 32-bit int unix seconds, will break February 7th 2106.
        uint32 redemptionRequestedAt;
        // Transaction maximum BTC fee in satoshi snapshotted at redemption
        // request time.
        uint64 redemptionTxMaxFee;
        // The address able to claim the surrendered balance back should the
        // pending reserved redemption time out.
        address redeemer;
        // keccak256 hash of the length-prefixed redeemer output script the
        // pending reserved redemption must pay to.
        bytes32 redeemerOutputScriptHash;
        // Cumulative satoshi lost to Bitcoin miner fees across all
        // re-anchor hops of this reservation. Bounded by
        // `Storage.maxCumulativeReanchorFee` to cap in-kind fee
        // extraction by a Byzantine wallet performing many small
        // re-anchors.
        uint64 cumulativeReanchorFee;
        // Set true when the most recent reserved redemption timeout
        // actually slashed the custodying wallet (it was Live or
        // MovingFunds); set false when slashing was skipped (wallet
        // already Terminated, Closing, or Closed) or the most recent
        // resolution was a veto rather than a timeout. Read by
        // `ReservationVault.retryRedeemReservation` to confirm the prior
        // request specifically ended in a wallet-fault timeout before
        // waiving the redemption fee -- without this gate an owner could
        // use the retry path as an ordinary fee-free first redemption, or
        // grief wallet operators by repeatedly requesting, waiting out
        // the timeout (slashing the wallet), and retrying for free.
        bool lastTimeoutWasWalletFault;
        // Set true while the pending reserved redemption request
        // (`state == RedemptionRequested`) was itself initiated as a
        // fee-free retry via `ReservationVault.retryRedeemReservation`,
        // rather than a fresh fee-paid `redeemReservation` call. Read by
        // `notifyReservedRedemptionTimeout` to grant at most one fee-free
        // retry per paid redemption fee: if a retry's own request times
        // out through wallet fault, `lastTimeoutWasWalletFault` is NOT
        // set again, so a second retry requires a fresh fee payment.
        // Without this, an owner could loop request -> timeout -> retry
        // indefinitely, slashing wallet operators for free on every
        // iteration after paying only the first redemption fee.
        bool currentRequestIsRetry;
        // This struct doesn't contain `__gap` property as the structure is
        // stored in a mapping, mappings store values in different slots and
        // they are not contiguous with other values.
    }

    event ReservationAccepted(
        uint256 indexed reservationKey,
        bytes20 indexed walletPubKeyHash,
        address indexed owner,
        bytes32 anchorTxHash,
        uint64 anchorAmount,
        uint32 expiresAt
    );

    event ReservationExtended(
        uint256 indexed reservationKey,
        uint32 newExpiresAt
    );

    event ReservedRedemptionRequested(
        uint256 indexed reservationKey,
        address indexed redeemer,
        bytes redeemerOutputScript,
        uint64 mintedAmount,
        uint64 txMaxFee
    );

    event ReservedRedemptionCompleted(
        uint256 indexed reservationKey,
        bytes32 redemptionTxHash
    );

    event ReservedRedemptionTimedOut(
        uint256 indexed reservationKey,
        bytes20 indexed walletPubKeyHash
    );

    event ReservedRedemptionVetoed(uint256 indexed reservationKey);

    // Emitted when a reserved redemption proof lands after the request
    // already timed out or was vetoed; the redeemer was already refunded
    // and no further balance movement occurs.
    event ReservedRedemptionSettled(
        uint256 indexed reservationKey,
        bytes32 redemptionTxHash
    );

    // Emitted when a reserved redemption timeout occurs but the custodying
    // wallet has already reached Closing or Closed state, so wallet-fault
    // slashing is skipped (the redeemer is still refunded).
    event ReservedRedemptionTimeoutSlashingSkipped(
        uint256 indexed reservationKey,
        bytes20 indexed walletPubKeyHash
    );

    event ReservationReanchored(
        uint256 indexed reservationKey,
        bytes20 indexed newWalletPubKeyHash,
        bytes32 newAnchorTxHash,
        uint64 newAnchorAmount
    );

    // Fee-loss decomposition for off-chain accounting: `mintedAmount` is
    // the gross claim that stays with the owner, `anchorAmount` is the
    // anchor's value entering this dissolution, and `dissolutionFee` is
    // the Bitcoin fee this transaction paid. The unreconciled shortfall
    // is `mintedAmount - anchorAmount + dissolutionFee` -- see the
    // comment preceding the `closeReservation` call in
    // `submitReservationDissolutionProof` for why nothing is burned.
    event ReservationDissolved(
        uint256 indexed reservationKey,
        bytes20 indexed walletPubKeyHash,
        bytes32 dissolutionTxHash,
        uint64 mintedAmount,
        uint64 anchorAmount,
        uint64 dissolutionFee
    );

    event ReservationParametersUpdated(
        uint64 reservationMinAmount,
        uint64 reservationTxMaxFee,
        uint64 reservationDissolutionTxMaxFee,
        uint32 reservationTermSeconds,
        uint32 reservationGracePeriod,
        uint64 reservationMaxTotalAmount,
        uint32 maxReservationsPerWallet,
        uint64 maxCumulativeReanchorFee
    );

    event ReservationVaultUpdated(address reservationVault);

    /// @notice Represents the type of a reservation lifecycle SPV proof.
    enum ProofType {
        /// @dev Proof of the anchor transaction accepting a reserved
        ///      deposit. `mainUtxo` and `reservationKey` parameters are
        ///      ignored; the reservation key is derived from the spent
        ///      deposit outpoint.
        Acceptance,
        /// @dev Proof of an in-kind reserved redemption transaction.
        ///      `mainUtxo` parameter is ignored.
        Redemption,
        /// @dev Proof of a re-anchor transaction moving the anchor outpoint
        ///      to another wallet. `mainUtxo` parameter is ignored.
        Reanchor,
        /// @dev Proof of a dissolution transaction merging an expired
        ///      reservation's anchor into the wallet's main UTXO.
        Dissolution
    }

    /// @notice Single entry point for all reservation lifecycle SPV proofs.
    ///         Dispatches to the appropriate handler based on `proofType`.
    ///         Consolidated into one external function to preserve the
    ///         Bridge contract's EIP-170 deployment size margin.
    /// @param proofType The type of the submitted proof, see `ProofType`.
    /// @param txInfo Bitcoin transaction data.
    /// @param proof Bitcoin proof data.
    /// @param mainUtxo Data of the wallet's main UTXO; only used for
    ///        `Dissolution` proofs and ignored otherwise.
    /// @param reservationKey The key of the target reservation; ignored for
    ///        `Acceptance` proofs where the key is derived from the spent
    ///        deposit outpoint.
    function submitReservationProof(
        BridgeState.Storage storage self,
        uint8 proofType,
        BitcoinTx.Info calldata txInfo,
        BitcoinTx.Proof calldata proof,
        BitcoinTx.UTXO calldata mainUtxo,
        uint256 reservationKey
    ) external {
        ProofType parsedProofType = ProofType(proofType);

        if (parsedProofType == ProofType.Acceptance) {
            submitReservationAcceptanceProof(self, txInfo, proof);
        } else if (parsedProofType == ProofType.Redemption) {
            submitReservedRedemptionProof(self, txInfo, proof, reservationKey);
        } else if (parsedProofType == ProofType.Reanchor) {
            submitReservationReanchorProof(self, txInfo, proof, reservationKey);
        } else {
            submitReservationDissolutionProof(
                self,
                txInfo,
                proof,
                mainUtxo,
                reservationKey
            );
        }
    }

    /// @notice Used by the wallet to prove the BTC anchor transaction of a
    ///         reserved deposit and to credit the owner's balance
    ///         accordingly. The anchor is only accepted if it satisfies SPV
    ///         proof.
    ///
    ///         The anchor transaction must spend exactly the revealed
    ///         reserved deposit as its sole input and create exactly one
    ///         P2(W)PKH output controlled by a registered wallet. Proving it
    ///         marks the deposit as swept (blocking any regular sweep and
    ///         enabling fraud challenge defeats for the deposit outpoint),
    ///         registers the reservation and credits the gross anchor value
    ///         to the depositor through the reservation vault.
    /// @param anchorTx Bitcoin anchor transaction data.
    /// @param anchorProof Bitcoin anchor proof data.
    /// @dev Requirements:
    ///      - The reservation vault must be set,
    ///      - `anchorTx` must have exactly one input pointing to a revealed,
    ///        unswept deposit routed to the reservation vault,
    ///      - `anchorTx` must have exactly one P2(W)PKH output locking funds
    ///        on a 20-byte public key hash of a Live or MovingFunds wallet,
    ///      - The anchor output value must respect the reservation minimum
    ///        amount, the per-transaction max fee, and the reservation caps.
    function submitReservationAcceptanceProof(
        BridgeState.Storage storage self,
        BitcoinTx.Info calldata anchorTx,
        BitcoinTx.Proof calldata anchorProof
    ) internal {
        require(
            self.reservationVault != address(0),
            "Reservations are disabled"
        );

        bytes32 anchorTxHash = self.validateProof(anchorTx, anchorProof);

        uint256 reservationKey = resolveAcceptedDeposit(
            self,
            anchorTx.inputVector
        );

        (bytes20 walletPubKeyHash, uint64 anchorAmount) = processAnchorOutput(
            self,
            anchorTx.outputVector
        );

        Deposit.DepositRequest storage deposit = self.deposits[reservationKey];

        require(
            anchorAmount >= self.reservationMinAmount,
            "Reservation amount too small"
        );
        // The difference between the deposit value and the anchor output
        // value is the Bitcoin miner fee of the anchor transaction -- the
        // only in-kind deduction the reservation lifecycle allows.
        require(
            deposit.amount - anchorAmount <= self.reservationTxMaxFee,
            "Transaction fee is too high"
        );

        registerReservation(
            self,
            reservationKey,
            deposit.depositor,
            walletPubKeyHash,
            anchorAmount,
            anchorTxHash
        );

        // Credit the gross anchored amount through the reservation vault.
        // The per-deposit treasury fee computed at reveal time is
        // deliberately ignored: reservation claims are minted gross and all
        // protocol fees are charged as explicit transfers by the vault.
        address[] memory depositors = new address[](1);
        depositors[0] = deposit.depositor;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = anchorAmount;
        self.bank.increaseBalanceAndCall(
            self.reservationVault,
            depositors,
            amounts
        );
    }

    /// @notice Resolves the reserved deposit spent by the anchor transaction
    ///         input vector, validates it and marks it as swept. Marking the
    ///         deposit as swept blocks any future regular sweep, prevents
    ///         double acceptance, and makes the deposit outpoint recognized
    ///         as correctly spent by the fraud challenge defeat path.
    /// @dev Does not re-check the deposit's revealed `vault` against the
    ///      current `self.reservationVault`: the reveal-time
    ///      classification in `pendingReservedDeposit` is what gates
    ///      reservation treatment. If governance changes the reservation
    ///      vault between reveal and acceptance, this deposit is still
    ///      accepted and its credit is routed through the *current*
    ///      vault (see `submitReservationAcceptanceProof`), not the one
    ///      set at reveal time.
    /// @return reservationKey The deposit key of the reserved deposit, used
    ///         as the reservation key.
    function resolveAcceptedDeposit(
        BridgeState.Storage storage self,
        bytes memory inputVector
    ) internal returns (uint256 reservationKey) {
        (bytes32 outpointTxHash, uint32 outpointIndex) = OutboundTx
            .parseWalletOutboundTxInput(inputVector);

        reservationKey = _outpointKey(outpointTxHash, outpointIndex);

        Deposit.DepositRequest storage deposit = self.deposits[reservationKey];
        require(deposit.revealedAt != 0, "Deposit not revealed");
        require(deposit.sweptAt == 0, "Deposit already swept");
        require(
            self.pendingReservedDeposit[reservationKey].isReserved,
            "Deposit was not revealed as reserved"
        );

        /* solhint-disable-next-line not-rely-on-time */
        deposit.sweptAt = uint32(block.timestamp);
    }

    /// @notice Parses the anchor transaction single output and validates it
    ///         is controlled by a Live or MovingFunds wallet.
    function processAnchorOutput(
        BridgeState.Storage storage self,
        bytes memory outputVector
    ) internal view returns (bytes20 walletPubKeyHash, uint64 anchorAmount) {
        bytes memory anchorOutput = parseSingleOutput(outputVector);
        walletPubKeyHash = self.extractPubKeyHash(anchorOutput);
        anchorAmount = anchorOutput.extractValue();

        Wallets.WalletState walletState = self
            .registeredWallets[walletPubKeyHash]
            .state;
        require(
            walletState == Wallets.WalletState.Live ||
                walletState == Wallets.WalletState.MovingFunds,
            "Anchor wallet must be in Live or MovingFunds state"
        );
    }

    /// @notice Registers a new reservation: checks and adjusts the caps
    ///         and stores the reservation record.
    function registerReservation(
        BridgeState.Storage storage self,
        uint256 reservationKey,
        address owner,
        bytes20 walletPubKeyHash,
        uint64 anchorAmount,
        bytes32 anchorTxHash
    ) internal {
        uint64 newTotal = self.reservationTotalAmount + anchorAmount;
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

        /* solhint-disable-next-line not-rely-on-time */
        uint32 expiresAt = uint32(block.timestamp) +
            self.reservationTermSeconds;

        ReservationRequest storage reservation = self.reservations[
            reservationKey
        ];
        reservation.owner = owner;
        reservation.mintedAmount = anchorAmount;
        /* solhint-disable-next-line not-rely-on-time */
        reservation.acceptedAt = uint32(block.timestamp);
        reservation.walletPubKeyHash = walletPubKeyHash;
        reservation.anchorAmount = anchorAmount;
        reservation.expiresAt = expiresAt;
        reservation.anchorTxHash = anchorTxHash;
        reservation.anchorTxOutputIndex = 0;
        reservation.state = ReservationState.Active;

        // slither-disable-next-line reentrancy-events
        emit ReservationAccepted(
            reservationKey,
            walletPubKeyHash,
            owner,
            anchorTxHash,
            anchorAmount,
            expiresAt
        );
    }

    /// @notice Extends the custody term of a reservation by the current
    ///         reservation term length. The custody fee for the extension is
    ///         collected by the reservation vault before this call.
    /// @param reservationKey The key of the reservation to extend.
    /// @dev Requirements:
    ///      - The caller must be the reservation vault,
    ///      - The reservation must be in the Active state (a pending
    ///        reserved redemption may consume the anchor at any time,
    ///        so extending it would risk paying an extension fee on a
    ///        position about to be spent),
    ///      - The reservation must not be past its grace period.
    function extendReservation(
        BridgeState.Storage storage self,
        uint256 reservationKey
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
        require(
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp <=
                uint256(reservation.expiresAt) + self.reservationGracePeriod,
            "Reservation past grace period"
        );

        // Always additive from the current `expiresAt`, even when the
        // caller extends after expiry but still within the grace window:
        // basing the new term on `block.timestamp` instead would hand a
        // late extender bonus custody days (the gap between the old
        // `expiresAt` and now) for the same flat extension fee, silently
        // undercharging the protocol relative to the custody duration
        // actually purchased.
        reservation.expiresAt =
            reservation.expiresAt +
            self.reservationTermSeconds;

        emit ReservationExtended(reservationKey, reservation.expiresAt);
    }

    /// @notice Requests an in-kind redemption of a reservation: the wallet
    ///         is expected to spend exactly the reservation's anchor
    ///         outpoint to the redeemer output script in a 1-input-1-output
    ///         transaction. The gross minted amount is taken from the
    ///         reservation vault's Bank balance and held by the Bridge until
    ///         the redemption is proven (burned) or times out (returned to
    ///         the redeemer).
    /// @param reservationKey The key of the reservation to redeem.
    /// @param redeemer The address able to claim the surrendered balance
    ///        back if the redemption times out.
    /// @param redeemerOutputScript The redeemer's length-prefixed output
    ///        script (P2PKH, P2WPKH, P2SH or P2WSH) that will be used to
    ///        lock the redeemed BTC.
    /// @param isRetry True when this request is a fee-free retry via
    ///        `ReservationVault.retryRedeemReservation` of a prior request
    ///        that timed out through wallet fault; false for a fresh,
    ///        fee-paid `redeemReservation` call.
    /// @dev Requirements:
    ///      - The caller must be the reservation vault, which must have
    ///        approved the Bridge in the Bank for the gross minted amount,
    ///      - The reservation must be in the Active state,
    ///      - The custodying wallet must be in the Live state, matching
    ///        the pooled redemption path's requirement -- a wallet already
    ///        transitioning out (MovingFunds) does not accept new
    ///        redemption requests, reserved or pooled alike,
    ///      - If `isRetry` is true, the reservation's most recent
    ///        redemption timeout must specifically have been caused by
    ///        wallet fault (see `lastTimeoutWasWalletFault`), and that
    ///        grant is consumed here so it cannot be reused,
    ///      - The reservation's current anchor must not carry an unresolved
    ///        terminal settlement record from a prior generation's timeout
    ///        or veto (see the settlement-overwrite guard below),
    ///      - If the redemption watchtower is set, the request must be
    ///        considered safe by the watchtower,
    ///      - `redeemerOutputScript` must be a standard type and, if it
    ///        has a 20-byte payload (P2PKH/P2WPKH), must not pay to the
    ///        custodying wallet's public key hash.
    function requestReservedRedemption(
        BridgeState.Storage storage self,
        uint256 reservationKey,
        address redeemer,
        bytes calldata redeemerOutputScript,
        bool isRetry
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

        require(
            self.registeredWallets[reservation.walletPubKeyHash].state ==
                Wallets.WalletState.Live,
            "Wallet must be in Live state"
        );

        if (isRetry) {
            require(
                reservation.lastTimeoutWasWalletFault,
                "Previous request did not time out through wallet fault"
            );
            // Consume the grant immediately: this specific fee-free retry
            // is the one payment it was earned by. `currentRequestIsRetry`
            // (checked at the next timeout, if any) is what actually
            // prevents chaining a second free retry off this one.
            reservation.lastTimeoutWasWalletFault = false;
        }
        reservation.currentRequestIsRetry = isRetry;

        // Settlement-overwrite guard: `reservedRedemptionSettlements` is a
        // single slot per reservation key. If a prior generation's
        // redemption timed out or was vetoed while its Bitcoin transaction
        // was already broadcast (just not yet proven), a settlement record
        // for the *current* anchor is still pending resolution -- allowing
        // a new redemption request here would let this new generation's
        // own timeout/veto overwrite that record (its `anchorTxHash` is
        // unchanged since no re-anchor happened), permanently corrupting
        // the redeemer output script the prior generation's late proof
        // must match. Block same-anchor re-requests until either the
        // pending settlement resolves via a late proof (which closes the
        // reservation) or the anchor moves via `submitReservationReanchorProof`
        // (which changes `anchorTxHash`, naturally invalidating the stale
        // settlement's relevance to any future request).
        require(
            self.reservedRedemptionSettlements[reservationKey].anchorTxHash !=
                reservation.anchorTxHash,
            "Unresolved settlement exists for the current anchor"
        );

        /* solhint-disable-next-line not-rely-on-time */
        uint32 redemptionRequestedAt = uint32(block.timestamp);

        if (self.redemptionWatchtower != address(0)) {
            require(
                IRedemptionWatchtower(self.redemptionWatchtower)
                    .isSafeReservedRedemption(
                        reservationKey,
                        redemptionRequestedAt,
                        self.reservationVault,
                        redeemer
                    ),
                "Redemption request rejected by the watchtower"
            );
        }

        bytes memory redeemerOutputScriptMem = redeemerOutputScript;

        OutboundTx.validateRedeemerOutputScript(
            redeemerOutputScriptMem,
            reservation.walletPubKeyHash
        );

        reservation.state = ReservationState.RedemptionRequested;
        reservation.redeemer = redeemer;
        reservation.redeemerOutputScriptHash = keccak256(
            redeemerOutputScriptMem
        );
        reservation.redemptionRequestedAt = redemptionRequestedAt;
        reservation.redemptionTxMaxFee = self.reservationTxMaxFee;

        // slither-disable-next-line reentrancy-events
        emit ReservedRedemptionRequested(
            reservationKey,
            redeemer,
            redeemerOutputScript,
            reservation.mintedAmount,
            reservation.redemptionTxMaxFee
        );

        self.bank.transferBalanceFrom(
            msg.sender,
            address(this),
            reservation.mintedAmount
        );
    }

    /// @notice Used by the wallet to prove the BTC reserved redemption
    ///         transaction and close the reservation. The transaction must
    ///         spend exactly the reservation's anchor outpoint as its sole
    ///         input and pay the requested redeemer output script as its
    ///         sole output. The full gross minted amount is burned: the
    ///         difference between the burned amount and the BTC paid out is
    ///         the Bitcoin miner fee (plus any re-anchor fees accrued
    ///         in-kind during custody), so supply and backing reconcile
    ///         exactly.
    /// @param redemptionTx Bitcoin reserved redemption transaction data.
    /// @param redemptionProof Bitcoin reserved redemption proof data.
    /// @param reservationKey The key of the reservation being redeemed.
    /// @dev Requirements:
    ///      - The reservation must have a pending reserved redemption,
    ///      - `redemptionTx` must spend the reservation's current anchor
    ///        outpoint as its sole input,
    ///      - `redemptionTx` must have a single output paying the requested
    ///        redeemer output script with a value within the acceptable
    ///        range.
    function submitReservedRedemptionProof(
        BridgeState.Storage storage self,
        BitcoinTx.Info calldata redemptionTx,
        BitcoinTx.Proof calldata redemptionProof,
        uint256 reservationKey
    ) internal {
        bytes32 redemptionTxHash = self.validateProof(
            redemptionTx,
            redemptionProof
        );

        ReservationRequest storage reservation = self.reservations[
            reservationKey
        ];
        if (reservation.state != ReservationState.RedemptionRequested) {
            // The request already timed out or was vetoed and the redeemer
            // was refunded there; acknowledge a late-arriving proof for the
            // exact settled anchor spend without moving any further
            // balance, mirroring the pooled redemption path's
            // `timedOutRedemptions` mechanism. The reservation itself is
            // terminalized here (closed) since the anchor this proof
            // proves is now provably spent and can never be re-anchored or
            // dissolved again.
            BridgeState.ReservedRedemptionSettlement storage settlement = self
                .reservedRedemptionSettlements[reservationKey];
            require(
                settlement.anchorTxHash != bytes32(0),
                "No settled reserved redemption"
            );

            // The reservation may have been re-anchored since the
            // settlement was recorded (a timeout/veto returns it to
            // Active, which permits re-anchoring). If so, the anchor
            // this settlement refers to is no longer the reservation's
            // current position -- the reservation has since moved on to
            // a live, unsettled anchor that must go through its own
            // redemption or dissolution, not be force-closed here.
            require(
                reservation.anchorTxHash == settlement.anchorTxHash,
                "Reservation anchor no longer matches the settlement"
            );

            (bytes32 outpointTxHash, uint32 outpointIndex) = OutboundTx
                .parseWalletOutboundTxInput(redemptionTx.inputVector);
            require(
                settlement.anchorTxHash == outpointTxHash && outpointIndex == 0,
                "Wrong settled anchor outpoint"
            );

            bytes memory settlementOutput = parseSingleOutput(
                redemptionTx.outputVector
            );
            require(
                keccak256(
                    settlementOutput.slice(8, settlementOutput.length - 8)
                ) == settlement.redeemerOutputScriptHash,
                "Output does not pay the settled redeemer script"
            );

            // Output-value range check: without this, a spend paying the
            // settled script an arbitrarily small (even dust) value would
            // still be accepted here -- since Bitcoin requires
            // `sum(inputs) >= sum(outputs)` and this transaction has a
            // single output, the difference between the anchor's value
            // and a near-zero output would be an enormous miner fee. A
            // wallet operator colluding with (or controlling) a mining
            // pool could exploit this to recapture almost the entire
            // anchor value as miner fee while the Bridge records the
            // reservation as cleanly settled. `reservation.anchorAmount`
            // is still the settled anchor's value here (the prior
            // `anchorTxHash` equality check above guarantees no re-anchor
            // happened since settlement); `self.reservationTxMaxFee` is
            // the same governance-bounded fee tolerance used throughout
            // the reservation lifecycle for miner-fee deductions.
            uint64 settledAnchorAmount = reservation.anchorAmount;
            uint64 settlementOutputValue = settlementOutput.extractValue();
            require(
                settlementOutputValue <= settledAnchorAmount &&
                    settledAnchorAmount - settlementOutputValue <=
                    self.reservationTxMaxFee,
                "Settled output value is not within the acceptable range"
            );

            self.spentMainUTXOs[
                _outpointKey(outpointTxHash, outpointIndex)
            ] = true;

            closeReservation(self, reservation, reservationKey);

            // slither-disable-next-line reentrancy-events
            emit ReservedRedemptionSettled(reservationKey, redemptionTxHash);
            return;
        }

        consumeAnchor(self, reservation, redemptionTx.inputVector);

        bytes memory output = parseSingleOutput(redemptionTx.outputVector);
        uint64 outputValue = output.extractValue();

        {
            bytes memory outputScript = output.slice(8, output.length - 8);
            require(
                keccak256(outputScript) == reservation.redeemerOutputScriptHash,
                "Output does not pay the requested redeemer script"
            );
        }

        // Underflow-safe range check. `redemptionTxMaxFee` is a governable
        // parameter, not a value derived from the proven transaction, so it
        // may exceed `anchorAmount` after re-anchor hops shrink the anchor
        // or after a governance fee increase. The equivalent formulation
        // below avoids the `anchorAmount - redemptionTxMaxFee` subtraction
        // that would otherwise revert and permanently strand the
        // reservation. `outputValue <= anchorAmount` is guaranteed by
        // Bitcoin consensus (an output cannot exceed its input) but is
        // asserted defensively.
        require(
            outputValue <= reservation.anchorAmount &&
                reservation.anchorAmount - outputValue <=
                reservation.redemptionTxMaxFee,
            "Output value is not within the acceptable range"
        );

        closeReservation(self, reservation, reservationKey);

        // slither-disable-next-line reentrancy-events
        emit ReservedRedemptionCompleted(reservationKey, redemptionTxHash);

        // Burn the gross minted amount held by the Bridge since the
        // redemption request.
        self.bank.decreaseBalance(reservation.mintedAmount);
    }

    /// @notice Records a terminal settlement for the reservation's pending
    ///         redemption request and clears the request fields, returning
    ///         it to the Active state. Shared core of timeout and veto
    ///         resolution -- both leave the reservation in the identical
    ///         post-request shape, differing only in where the surrendered
    ///         balance goes and whether wallet-fault slashing applies.
    /// @return wasRetry Whether the just-cleared request was itself a
    ///         fee-free retry (see `currentRequestIsRetry`).
    function _clearPendingRedemptionRequest(
        BridgeState.Storage storage self,
        ReservationRequest storage reservation,
        uint256 reservationKey
    ) internal returns (bool wasRetry) {
        // Record a terminal settlement BEFORE clearing the reservation
        // fields so a redemption proof that lands after this resolution
        // can still be acknowledged and mark the anchor outpoint spent,
        // mirroring the pooled redemption path's `timedOutRedemptions`
        // mechanism.
        self.reservedRedemptionSettlements[reservationKey] = BridgeState
            .ReservedRedemptionSettlement({
                anchorTxHash: reservation.anchorTxHash,
                redeemerOutputScriptHash: reservation.redeemerOutputScriptHash
            });

        reservation.state = ReservationState.Active;
        reservation.redeemer = address(0);
        reservation.redeemerOutputScriptHash = bytes32(0);
        reservation.redemptionRequestedAt = 0;
        reservation.redemptionTxMaxFee = 0;

        wasRetry = reservation.currentRequestIsRetry;
        reservation.currentRequestIsRetry = false;
    }

    /// @notice Notifies that a pending reserved redemption has timed out.
    ///         The surrendered balance is returned to the redeemer, the
    ///         wallet operators are slashed the same way as for a regular
    ///         redemption timeout, and the reservation returns to the
    ///         Active state -- the anchor outpoint was not spent, so the
    ///         in-kind claim survives and the redemption can be re-requested.
    /// @param reservationKey The key of the reservation with the timed out
    ///        redemption.
    /// @param walletMembersIDs Identifiers of the wallet signing group
    ///        members.
    /// @dev Requirements:
    ///      - The reservation must have a pending reserved redemption,
    ///      - The amount of time defined by `redemptionTimeout` must have
    ///        passed since the reserved redemption was requested.
    function notifyReservedRedemptionTimeout(
        BridgeState.Storage storage self,
        uint256 reservationKey,
        uint32[] calldata walletMembersIDs
    ) external {
        ReservationRequest storage reservation = self.reservations[
            reservationKey
        ];
        require(
            reservation.state == ReservationState.RedemptionRequested,
            "No pending reserved redemption"
        );
        require(
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp >
                reservation.redemptionRequestedAt + self.redemptionTimeout,
            "Redemption request has not timed out"
        );
        address redeemer = reservation.redeemer;
        uint64 refundAmount = reservation.mintedAmount;
        bytes20 walletPubKeyHash = reservation.walletPubKeyHash;

        bool timedOutRequestWasRetry = _clearPendingRedemptionRequest(
            self,
            reservation,
            reservationKey
        );

        // Propagate timeout consequences to the wallet: slashing and state
        // transition follow the regular redemption timeout rules, but only
        // when the wallet is actually slashable (Live or MovingFunds). A
        // wallet that already reached Terminated, Closing, or Closed
        // cannot be slashed via this path -- skip the call instead of
        // reverting so the refund below is never blocked by wallet
        // state. The wallet is slashed either way when slashable -- it
        // genuinely failed to redeem in time regardless of whether the
        // request was a fresh one or a retry -- but a free-retry grant
        // (`lastTimeoutWasWalletFault = true`) is issued only when this
        // timed-out request was NOT itself a retry: without this gate an
        // owner could loop request -> timeout -> retry -> timeout -> retry
        // indefinitely after paying only the first redemption fee, since
        // each retry's own timeout would otherwise re-grant another free
        // retry. A second retry now requires a fresh fee payment via
        // `redeemReservation`.
        Wallets.WalletState walletState = self
            .registeredWallets[walletPubKeyHash]
            .state;
        if (
            walletState == Wallets.WalletState.Live ||
            walletState == Wallets.WalletState.MovingFunds
        ) {
            reservation.lastTimeoutWasWalletFault = !timedOutRequestWasRetry;
            self.notifyWalletRedemptionTimeout(
                walletPubKeyHash,
                walletMembersIDs
            );
        } else {
            reservation.lastTimeoutWasWalletFault = false;
            // slither-disable-next-line reentrancy-events
            emit ReservedRedemptionTimeoutSlashingSkipped(
                reservationKey,
                walletPubKeyHash
            );
        }

        // slither-disable-next-line reentrancy-events
        emit ReservedRedemptionTimedOut(reservationKey, walletPubKeyHash);

        // Return the surrendered balance to the redeemer as Bank balance.
        self.bank.transferBalance(redeemer, refundAmount);
    }

    /// @notice Notifies that a pending reserved redemption was vetoed in the
    ///         redemption watchtower. Mirrors
    ///         `Redemption.notifyRedemptionVeto`: the surrendered balance is
    ///         detained and passed to the watchtower (as Bank balance) for
    ///         further processing, the pending request is cleared, and the
    ///         reservation returns to the Active state -- the anchor
    ///         outpoint was not spent, so the in-kind claim survives.
    /// @param reservationKey The key of the reservation with the vetoed
    ///        redemption.
    /// @dev Requirements:
    ///      - The caller must be the redemption watchtower,
    ///      - The reservation must have a pending reserved redemption.
    function notifyReservedRedemptionVeto(
        BridgeState.Storage storage self,
        uint256 reservationKey
    ) external {
        require(
            msg.sender == self.redemptionWatchtower,
            "Caller is not the redemption watchtower"
        );

        ReservationRequest storage reservation = self.reservations[
            reservationKey
        ];
        require(
            reservation.state == ReservationState.RedemptionRequested,
            "No pending reserved redemption"
        );

        uint64 detainedAmount = reservation.mintedAmount;

        // Mirrors the timeout path's terminal-settlement recording; the
        // returned `wasRetry` value is irrelevant here since a veto never
        // grants a free retry regardless.
        _clearPendingRedemptionRequest(self, reservation, reservationKey);
        reservation.lastTimeoutWasWalletFault = false;

        // slither-disable-next-line reentrancy-events
        emit ReservedRedemptionVetoed(reservationKey);

        self.bank.transferBalance(self.redemptionWatchtower, detainedAmount);
    }

    /// @notice Used by the wallet to prove a re-anchor transaction moving a
    ///         reservation's anchor outpoint to another (or a fresh output
    ///         of the same) wallet in a 1-input-1-output spend. Used during
    ///         wallet migration so reservations never pin retiring wallets.
    /// @param reanchorTx Bitcoin re-anchor transaction data.
    /// @param reanchorProof Bitcoin re-anchor proof data.
    /// @param reservationKey The key of the reservation being re-anchored.
    /// @dev Requirements:
    ///      - The reservation must be in the Active state (a pending
    ///        reserved redemption blocks re-anchoring),
    ///      - `reanchorTx` must spend the current anchor outpoint as its
    ///        sole input and create a single P2(W)PKH output controlled by
    ///        a Live wallet,
    ///      - The value difference (Bitcoin miner fee) must not exceed the
    ///        reservation transaction max fee.
    ///
    ///      The source wallet state is deliberately not restricted: the
    ///      ability to produce the transaction is enforced by Bitcoin (only
    ///      the custodying wallet can sign the anchor spend) and moving
    ///      reservations out must remain possible for wallets in any
    ///      lifecycle state.
    ///
    ///      Proof-type ambiguity: once the custody term plus grace period
    ///      has elapsed, a single 1-input-1-output anchor spend can satisfy
    ///      both this function's and `submitReservationDissolutionProof`'s
    ///      output rules, and the `proofType` chosen by whichever party
    ///      submits the SPV proof is the only discriminator between the
    ///      two. Both entry points are reachable only through
    ///      `Bridge.submitReservationProof`, gated to the same trusted,
    ///      governance-controlled SPV maintainer role, so this is a
    ///      maintainer-tooling correctness concern rather than an open
    ///      exploit surface: the maintainer's tooling is responsible for
    ///      choosing the `proofType` matching the wallet operator's actual
    ///      intent. Submitting the wrong proof type either force-closes the
    ///      reservation via dissolution or blocks an intended dissolution
    ///      via re-anchor -- currently a trust assumption on the maintainer
    ///      role, not an on-chain-enforced guarantee.
    function submitReservationReanchorProof(
        BridgeState.Storage storage self,
        BitcoinTx.Info calldata reanchorTx,
        BitcoinTx.Proof calldata reanchorProof,
        uint256 reservationKey
    ) internal {
        bytes32 reanchorTxHash = self.validateProof(reanchorTx, reanchorProof);

        ReservationRequest storage reservation = self.reservations[
            reservationKey
        ];
        require(
            reservation.state == ReservationState.Active,
            "Reservation is not active"
        );

        consumeAnchor(self, reservation, reanchorTx.inputVector);

        bytes memory output = parseSingleOutput(reanchorTx.outputVector);
        bytes20 newWalletPubKeyHash = self.extractPubKeyHash(output);
        uint64 newAnchorAmount = output.extractValue();

        require(
            self.registeredWallets[newWalletPubKeyHash].state ==
                Wallets.WalletState.Live,
            "Target wallet must be in Live state"
        );

        // `newAnchorAmount <= anchorAmount` is guaranteed by Bitcoin
        // consensus (the re-anchor output cannot exceed its input).
        // Cache the reservation's current anchor value locally: it is
        // read once here, then re-read when computing the cumulative
        // re-anchor fee below. Using the local avoids a second SLOAD.
        uint64 anchorAmount = reservation.anchorAmount;
        require(
            anchorAmount - newAnchorAmount <= self.reservationTxMaxFee,
            "Transaction fee is too high"
        );

        // Dust floor: the re-anchored amount must stay strictly above the
        // per-transaction fee bound, keeping the anchor clear of dust and
        // preserving positive redemption value. This is deliberately a dust
        // floor rather than `reservationMinAmount`: a minimum-sized
        // reservation must remain migratable.
        require(
            newAnchorAmount > self.reservationTxMaxFee,
            "Re-anchor amount below the dust floor"
        );

        // Cumulative re-anchor fee budget: cap the total satoshi a
        // single reservation may lose across all re-anchor hops.
        // Bounds Byzantine fee-grinding attacks that would otherwise
        // split the cumulative loss into many hops each individually
        // under `reservationTxMaxFee`. The `reservationTotalAmount`
        // aggregate is intentionally NOT decremented on re-anchor:
        // re-anchoring does not change `mintedAmount`, the gross claim
        // that backs the reservation.
        uint64 fee = anchorAmount - newAnchorAmount;
        reservation.cumulativeReanchorFee += fee;
        require(
            reservation.cumulativeReanchorFee <= self.maxCumulativeReanchorFee,
            "Cumulative re-anchor fee budget exceeded"
        );

        bytes20 oldWalletPubKeyHash = reservation.walletPubKeyHash;
        if (oldWalletPubKeyHash != newWalletPubKeyHash) {
            self.walletReservationsCount[oldWalletPubKeyHash] -= 1;
            uint32 newCount = self.walletReservationsCount[
                newWalletPubKeyHash
            ] + 1;
            require(
                newCount <= self.maxReservationsPerWallet,
                "Wallet reservations cap exceeded"
            );
            self.walletReservationsCount[newWalletPubKeyHash] = newCount;
        }

        reservation.walletPubKeyHash = newWalletPubKeyHash;
        reservation.anchorAmount = newAnchorAmount;
        reservation.anchorTxHash = reanchorTxHash;
        reservation.anchorTxOutputIndex = 0;

        emit ReservationReanchored(
            reservationKey,
            newWalletPubKeyHash,
            reanchorTxHash,
            newAnchorAmount
        );
    }

    /// @notice Used by the wallet to prove a dissolution transaction merging
    ///         an expired reservation's anchor outpoint into the wallet's
    ///         main UTXO. The anchor value rejoins the pool as an ordinary
    ///         claim; any accrued re-anchor fee loss (the gap between the
    ///         original minted amount and the anchor's current value) is
    ///         simply not reconciled -- see the inline comment preceding
    ///         the `closeReservation` call in this function's body for
    ///         why no Bank balance is burned.
    /// @param dissolutionTx Bitcoin dissolution transaction data.
    /// @param dissolutionProof Bitcoin dissolution proof data.
    /// @param mainUtxo Data of the wallet's main UTXO, as currently known on
    ///        the Ethereum chain. Ignored if the wallet has no main UTXO.
    /// @param reservationKey The key of the reservation being dissolved.
    /// @dev Requirements:
    ///      - The reservation must be in the Active state (a pending
    ///        reserved redemption always wins over dissolution),
    ///      - The custody term plus grace period must have elapsed,
    ///      - The custodying wallet must be in Live, MovingFunds or
    ///        Terminated state,
    ///      - If the wallet has a main UTXO, `dissolutionTx` must spend
    ///        exactly the anchor outpoint and that main UTXO as its two
    ///        inputs, in either order (Bitcoin does not constrain input
    ///        ordering); otherwise it must spend exactly the anchor
    ///        outpoint,
    ///      - `dissolutionTx` must have a single P2(W)PKH output locking
    ///        funds back on the custodying wallet's public key hash; that
    ///        output becomes the wallet's new main UTXO.
    ///
    ///      Dissolution concurrency: dissolution proofs for multiple
    ///      reservations on the same wallet must be submitted sequentially
    ///      -- one at a time, each landing before the next is signed and
    ///      submitted. If two dissolutions are signed off-chain assuming
    ///      the same (e.g. zero) main UTXO, the first proof to land moves
    ///      the wallet's `mainUtxoHash` forward and the second, now-stale
    ///      transaction reverts on its input count instead of executing;
    ///      it must be re-signed against the wallet's updated main UTXO.
    ///      This is the same operational pattern already required by this
    ///      codebase's MovingFunds sweep-input handling.
    ///
    ///      Proof-type ambiguity: see the matching note on
    ///      `submitReservationReanchorProof` -- once the custody term plus
    ///      grace period has elapsed, a single 1-input-1-output anchor
    ///      spend can satisfy either function's output rules, and both are
    ///      reachable only through the same trusted, governance-controlled
    ///      SPV maintainer role via `Bridge.submitReservationProof`. This
    ///      is a maintainer-tooling correctness concern, not an on-chain-
    ///      enforced guarantee.
    ///
    ///      Note the Bridge cannot verify *when* the dissolution transaction
    ///      was signed. A wallet signing it before the grace period elapses
    ///      cannot prove it here (this function reverts), so such a spend is
    ///      an undefeatable fraud challenge target until the grace period
    ///      passes -- premature dissolution is deterred economically by the
    ///      fraud slashing machinery.
    function submitReservationDissolutionProof(
        BridgeState.Storage storage self,
        BitcoinTx.Info calldata dissolutionTx,
        BitcoinTx.Proof calldata dissolutionProof,
        BitcoinTx.UTXO calldata mainUtxo,
        uint256 reservationKey
    ) internal {
        bytes32 dissolutionTxHash = self.validateProof(
            dissolutionTx,
            dissolutionProof
        );

        ReservationRequest storage reservation = self.reservations[
            reservationKey
        ];
        require(
            reservation.state == ReservationState.Active,
            "Reservation is not active"
        );
        require(
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp >
                uint256(reservation.expiresAt) + self.reservationGracePeriod,
            "Reservation term or grace period not elapsed"
        );

        // Cache the reservation's wallet identity: it is read here, again
        // in the dissolution-output require, and in the
        // `ReservationDissolved` event. The claim/backing pair
        // (`mintedAmount`, `anchorAmount`) is read straight from storage
        // in the event below rather than into locals -- this function is
        // already at the stack limit.
        bytes20 walletPubKeyHash = reservation.walletPubKeyHash;

        Wallets.Wallet storage wallet = self.registeredWallets[
            walletPubKeyHash
        ];
        {
            Wallets.WalletState walletState = wallet.state;
            // `Terminated` is included alongside `Live`/`MovingFunds` so a
            // reservation that predates the wallet's termination is not
            // permanently stranded: without this, a wallet terminated via
            // `notifyWalletMovingFundsTimeout` (which has no reservation
            // gate) leaves any reservation it still custodies unable to
            // ever dissolve or close -- `reservationTotalAmount` would
            // never reach zero and any future reservation-vault change
            // would revert forever. Re-anchor is unaffected: its docstring
            // already allows any source wallet state. This mirrors the
            // existing carve-out in `Wallets.notifyWalletRedemptionTimeout`,
            // which explicitly allows `Terminated` "in case the redemption
            // was requested before the wallet got terminated" -- settling
            // a pre-existing obligation, not authorizing a new action,
            // which is what `Terminated` blocks.
            require(
                walletState == Wallets.WalletState.Live ||
                    walletState == Wallets.WalletState.MovingFunds ||
                    walletState == Wallets.WalletState.Terminated,
                "Wallet must be in Live, MovingFunds or Terminated state"
            );
        }

        uint64 inputsTotalValue = processDissolutionInputs(
            self,
            reservation,
            dissolutionTx.inputVector,
            wallet.mainUtxoHash,
            mainUtxo
        );

        bytes memory output = parseSingleOutput(dissolutionTx.outputVector);
        uint64 outputValue = output.extractValue();
        require(
            self.extractPubKeyHash(output) == walletPubKeyHash,
            "Dissolution output must pay to the custodying wallet"
        );
        // Dissolution is usually a 2-in-1-out spend (anchor + wallet
        // main UTXO rolled into a new main UTXO), or 1-in-1-out when
        // the wallet has no main UTXO yet; either shape's fee economics
        // differ from the always-1-in-1-out anchor / re-anchor /
        // redemption shapes, so the cap is the dedicated
        // `reservationDissolutionTxMaxFee` governance parameter rather
        // than the shared `reservationTxMaxFee`.
        require(
            inputsTotalValue - outputValue <=
                self.reservationDissolutionTxMaxFee,
            "Transaction fee is too high"
        );

        // The dissolution output becomes the wallet's new main UTXO,
        // rolling the anchor's remaining value (after any re-anchor fees)
        // together with the previous main UTXO, less this transaction's
        // fee. No Bank balance is burned here: the Bridge itself holds no
        // balance attributable to a dissolving reservation to burn
        // against -- the owner's full `mintedAmount` claim was minted out
        // through the reservation vault at acceptance time and stays with
        // the owner regardless of later re-anchor fee loss. Reconciling
        // that fee loss against the pool, if ever desired, requires a
        // separate mechanism that first obtains the shortfall from the
        // owner; it is not handled here. This mirrors the way
        // `movingFundsTxMaxTotalFee` leaves wallet-migration fees
        // pool-socialized rather than charging individual depositors. The
        // `reservationTotalAmount` aggregate is decremented inside
        // `closeReservation` against the full `mintedAmount`, and
        // `ReservationDissolved` emits the fee-loss decomposition so the
        // shortfall stays observable off-chain.

        wallet.mainUtxoHash = keccak256(
            abi.encodePacked(dissolutionTxHash, uint32(0), outputValue)
        );

        // Emitted before `closeReservation` so the claim/backing pair is
        // read while the reservation record is still intact.
        emit ReservationDissolved(
            reservationKey,
            walletPubKeyHash,
            dissolutionTxHash,
            reservation.mintedAmount,
            reservation.anchorAmount,
            inputsTotalValue - outputValue
        );

        closeReservation(self, reservation, reservationKey);
    }

    /// @notice Updates the reservation parameters, including the
    ///         reservation vault address. Deposits revealed with the
    ///         reservation vault address are treated as reserved deposits.
    /// @param reservationDissolutionTxMaxFee New value of the dedicated
    ///        cap on the BTC transaction fee for the dissolution shape
    ///        (usually 2-in-1-out; 1-in-1-out when the wallet has no
    ///        main UTXO yet); distinct from `reservationTxMaxFee` which
    ///        caps the always-1-in-1-out anchor / re-anchor / redemption
    ///        shapes.
    /// @param maxCumulativeReanchorFee New value of the per-reservation
    ///        cap on the total satoshi that may be lost across all
    ///        re-anchor hops of a single reservation. Bounds in-kind
    ///        fee extraction by a Byzantine wallet performing many
    ///        small re-anchors.
    /// @dev Requirements:
    ///      - Reservation transaction max fee must be greater than zero,
    ///      - Reservation minimum amount must be greater than the
    ///        reservation transaction max fee,
    ///      - Reservation term must be greater than zero,
    ///      - The reservation vault can only be changed while there are no
    ///        active reservations (total reserved amount is zero).
    function updateReservationParameters(
        BridgeState.Storage storage self,
        address reservationVault,
        uint64 reservationMinAmount,
        uint64 reservationTxMaxFee,
        uint64 reservationDissolutionTxMaxFee,
        uint32 reservationTermSeconds,
        uint32 reservationGracePeriod,
        uint64 reservationMaxTotalAmount,
        uint32 maxReservationsPerWallet,
        uint64 maxCumulativeReanchorFee
    ) external {
        require(
            reservationTxMaxFee > 0,
            "Reservation transaction max fee must be greater than zero"
        );
        require(
            reservationDissolutionTxMaxFee > 0,
            "Reservation dissolution transaction max fee must be greater than zero"
        );
        require(
            reservationMinAmount > reservationTxMaxFee,
            "Reservation minimum amount must be greater than the reservation TX max fee"
        );
        require(
            reservationTermSeconds > 0,
            "Reservation term must be greater than zero"
        );
        require(
            maxCumulativeReanchorFee > 0,
            "Max cumulative re-anchor fee must be greater than zero"
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
        self.reservationDissolutionTxMaxFee = reservationDissolutionTxMaxFee;
        self.reservationTermSeconds = reservationTermSeconds;
        self.reservationGracePeriod = reservationGracePeriod;
        self.reservationMaxTotalAmount = reservationMaxTotalAmount;
        self.maxReservationsPerWallet = maxReservationsPerWallet;
        self.maxCumulativeReanchorFee = maxCumulativeReanchorFee;

        emit ReservationParametersUpdated(
            reservationMinAmount,
            reservationTxMaxFee,
            reservationDissolutionTxMaxFee,
            reservationTermSeconds,
            reservationGracePeriod,
            reservationMaxTotalAmount,
            maxReservationsPerWallet,
            maxCumulativeReanchorFee
        );
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

    /// @notice Derives the `spentMainUTXOs`/deposit-key mapping key for a
    ///         Bitcoin outpoint, shared by every call site that hashes a
    ///         transaction hash and output index pair this way.
    function _outpointKey(bytes32 txHash, uint32 outputIndex)
        internal
        pure
        returns (uint256)
    {
        return uint256(keccak256(abi.encodePacked(txHash, outputIndex)));
    }

    /// @notice Compares the given outpoint against the reservation's
    ///         current anchor and, if it matches, marks it spent. Shared
    ///         core of `consumeAnchor` and `consumeAnchorInputAt`, which
    ///         differ only in how they extract the outpoint from an input
    ///         vector (a known-single-input vector vs. a specific offset
    ///         within a multi-input vector).
    function _consumeAnchorOutpoint(
        BridgeState.Storage storage self,
        ReservationRequest storage reservation,
        bytes32 outpointTxHash,
        uint32 outpointIndex
    ) internal {
        require(
            reservation.anchorTxHash == outpointTxHash &&
                reservation.anchorTxOutputIndex == outpointIndex,
            "Transaction input must point to the reservation anchor"
        );

        // Anchor outpoints are wallet-controlled UTXOs. Marking a consumed
        // anchor in `spentMainUTXOs` -- the existing registry of honestly
        // spent wallet UTXOs -- makes the spend recognized by
        // `Fraud.defeatFraudChallenge` without modifying the fraud library.
        self.spentMainUTXOs[
            _outpointKey(outpointTxHash, outpointIndex)
        ] = true;
    }

    /// @notice Asserts the given input vector contains exactly one input
    ///         pointing to the reservation's current anchor outpoint, marks
    ///         that outpoint as correctly spent (making it recognized by the
    ///         fraud challenge defeat path) and clears its anchor index
    ///         entry.
    function consumeAnchor(
        BridgeState.Storage storage self,
        ReservationRequest storage reservation,
        bytes memory inputVector
    ) internal {
        (bytes32 outpointTxHash, uint32 outpointIndex) = OutboundTx
            .parseWalletOutboundTxInput(inputVector);

        _consumeAnchorOutpoint(self, reservation, outpointTxHash, outpointIndex);
    }

    /// @notice Extracts the outpoint (transaction hash and output index) of
    ///         the input at the given starting index, without asserting
    ///         anything about it. Shared "peek" primitive used where the
    ///         caller must inspect an outpoint before deciding what it is
    ///         expected to be (see `processDissolutionInputs`, which cannot
    ///         assume a fixed input order).
    function _peekOutpointAt(bytes memory inputVector, uint256 inputStartingIndex)
        internal
        pure
        returns (bytes32 outpointTxHash, uint32 outpointIndex)
    {
        outpointTxHash = inputVector.extractInputTxIdLeAt(inputStartingIndex);
        outpointIndex = BTCUtils.reverseUint32(
            uint32(inputVector.extractTxIndexLeAt(inputStartingIndex))
        );
    }

    /// @notice Compares the given outpoint against the wallet's expected
    ///         main UTXO and, if it matches, marks it spent. Shared core
    ///         of `consumeMainUtxoInputAt` and `processDissolutionInputs`'s
    ///         either-order matching.
    function _consumeMainUtxoOutpoint(
        BridgeState.Storage storage self,
        BitcoinTx.UTXO calldata mainUtxo,
        bytes32 outpointTxHash,
        uint32 outpointIndex
    ) internal {
        require(
            mainUtxo.txHash == outpointTxHash &&
                mainUtxo.txOutputIndex == outpointIndex,
            "Transaction input must point to the wallet's main UTXO"
        );

        self.spentMainUTXOs[_outpointKey(outpointTxHash, outpointIndex)] = true;
    }

    /// @notice Processes the dissolution transaction inputs: exactly one
    ///         input must spend the reservation's anchor outpoint and,
    ///         if the wallet has a main UTXO, exactly one other input must
    ///         spend that main UTXO. The two inputs may appear in either
    ///         order -- Bitcoin does not constrain input ordering, and a
    ///         wallet's transaction-construction tooling has no reason to
    ///         place the anchor first. Requiring a fixed order would let
    ///         an already-mined, fully valid dissolution transaction with
    ///         the inputs swapped become permanently unprovable: since the
    ///         spend is irreversible on Bitcoin once confirmed, the
    ///         wallet's `mainUtxoHash` would never update to match Bitcoin's
    ///         true state, silently bricking every subsequent Bitcoin
    ///         operation for that wallet, not just this dissolution.
    ///         Marks both consumed outpoints as correctly spent.
    /// @return inputsTotalValue Sum of all inputs values.
    function processDissolutionInputs(
        BridgeState.Storage storage self,
        ReservationRequest storage reservation,
        bytes memory inputVector,
        bytes32 mainUtxoHash,
        BitcoinTx.UTXO calldata mainUtxo
    ) internal returns (uint64 inputsTotalValue) {
        bool mainUtxoExpected = mainUtxoHash != bytes32(0);

        (uint256 varIntLength, uint256 inputsCount) = inputVector.parseVarInt();
        require(
            inputsCount == (mainUtxoExpected ? 2 : 1),
            "Wrong number of dissolution transaction inputs"
        );

        uint256 firstInputIndex = 1 + varIntLength;

        if (!mainUtxoExpected) {
            // Single-input case: the sole input must be the anchor: no
            // ordering ambiguity is possible.
            consumeAnchorInputAt(self, reservation, inputVector, firstInputIndex);
            return reservation.anchorAmount;
        }

        require(
            keccak256(
                abi.encodePacked(
                    mainUtxo.txHash,
                    mainUtxo.txOutputIndex,
                    mainUtxo.txOutputValue
                )
            ) == mainUtxoHash,
            "Invalid main UTXO data"
        );

        (bytes32 firstTxHash, uint32 firstIndex) = _peekOutpointAt(
            inputVector,
            firstInputIndex
        );
        uint256 secondInputIndex = firstInputIndex +
            inputVector.determineInputLengthAt(firstInputIndex);

        if (
            firstTxHash == reservation.anchorTxHash &&
            firstIndex == reservation.anchorTxOutputIndex
        ) {
            // First input is the anchor; second must be the main UTXO.
            _consumeAnchorOutpoint(self, reservation, firstTxHash, firstIndex);
            (bytes32 secondTxHash, uint32 secondIndex) = _peekOutpointAt(
                inputVector,
                secondInputIndex
            );
            _consumeMainUtxoOutpoint(self, mainUtxo, secondTxHash, secondIndex);
        } else {
            // First input must be the main UTXO instead; second must be
            // the anchor. `_consumeMainUtxoOutpoint`/`_consumeAnchorOutpoint`
            // still revert with a clear message if neither matches.
            _consumeMainUtxoOutpoint(self, mainUtxo, firstTxHash, firstIndex);
            (bytes32 secondTxHash, uint32 secondIndex) = _peekOutpointAt(
                inputVector,
                secondInputIndex
            );
            _consumeAnchorOutpoint(self, reservation, secondTxHash, secondIndex);
        }

        inputsTotalValue = reservation.anchorAmount + mainUtxo.txOutputValue;
    }

    /// @notice Asserts the input at the given starting index spends the
    ///         reservation's current anchor outpoint, marks that outpoint as
    ///         correctly spent and clears its anchor index entry.
    /// @return nextInputIndex Starting index of the next input.
    function consumeAnchorInputAt(
        BridgeState.Storage storage self,
        ReservationRequest storage reservation,
        bytes memory inputVector,
        uint256 inputStartingIndex
    ) internal returns (uint256 nextInputIndex) {
        bytes32 outpointTxHash = inputVector.extractInputTxIdLeAt(
            inputStartingIndex
        );
        uint32 outpointIndex = BTCUtils.reverseUint32(
            uint32(inputVector.extractTxIndexLeAt(inputStartingIndex))
        );

        _consumeAnchorOutpoint(self, reservation, outpointTxHash, outpointIndex);

        nextInputIndex =
            inputStartingIndex +
            inputVector.determineInputLengthAt(inputStartingIndex);
    }

    /// @notice Closes a reservation: adjusts the wallet reservation count
    ///         and the total reserved amount, marks the reservation as
    ///         Closed, and clears any terminal settlement record left by
    ///         a prior timeout or veto so it cannot outlive the request
    ///         generation that created it.
    /// @dev `reservationTotalAmount` aggregates the sum of gross
    ///      `mintedAmount` over Active reservations -- not the shrinking
    ///      per-reservation `anchorAmount` -- so the cap tracks the
    ///      bridge's true gross liability.
    function closeReservation(
        BridgeState.Storage storage self,
        ReservationRequest storage reservation,
        uint256 reservationKey
    ) internal {
        bytes20 walletPubKeyHash = reservation.walletPubKeyHash;
        uint64 mintedAmount = reservation.mintedAmount;
        self.walletReservationsCount[walletPubKeyHash] -= 1;
        self.reservationTotalAmount -= mintedAmount;
        reservation.state = ReservationState.Closed;
        // Clear flags that only have meaning for an in-progress or
        // recently-timed-out redemption request; leaving them set would be
        // harmless (both are re-derived fresh on any future request cycle
        // and this reservation key can never re-enter `Active`) but is
        // stale state with no purpose once the reservation is terminal.
        reservation.lastTimeoutWasWalletFault = false;
        reservation.currentRequestIsRetry = false;
        delete self.reservedRedemptionSettlements[reservationKey];
    }
}
