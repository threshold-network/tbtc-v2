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

    event ReservationReanchored(
        uint256 indexed reservationKey,
        bytes20 indexed newWalletPubKeyHash,
        bytes32 newAnchorTxHash,
        uint64 newAnchorAmount
    );

    event ReservationDissolved(
        uint256 indexed reservationKey,
        bytes20 indexed walletPubKeyHash,
        bytes32 dissolutionTxHash
    );

    event ReservationParametersUpdated(
        uint64 reservationMinAmount,
        uint64 reservationTxMaxFee,
        uint32 reservationTermSeconds,
        uint32 reservationGracePeriod,
        uint64 reservationMaxTotalAmount,
        uint32 maxReservationsPerWallet
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
    /// @return reservationKey The deposit key of the reserved deposit, used
    ///         as the reservation key.
    function resolveAcceptedDeposit(
        BridgeState.Storage storage self,
        bytes memory inputVector
    ) internal returns (uint256 reservationKey) {
        (bytes32 outpointTxHash, uint32 outpointIndex) = OutboundTx
            .parseWalletOutboundTxInput(inputVector);

        reservationKey = uint256(
            keccak256(abi.encodePacked(outpointTxHash, outpointIndex))
        );

        Deposit.DepositRequest storage deposit = self.deposits[reservationKey];
        require(deposit.revealedAt != 0, "Deposit not revealed");
        require(deposit.sweptAt == 0, "Deposit already swept");
        require(
            deposit.vault == self.reservationVault,
            "Deposit not routed to the reservation vault"
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

    /// @notice Registers a new reservation: checks and adjusts the caps,
    ///         stores the reservation record and indexes the anchor
    ///         outpoint.
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

        self.reservationsByAnchorUtxo[
            uint256(keccak256(abi.encodePacked(anchorTxHash, uint32(0))))
        ] = reservationKey;

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
    ///      - The reservation must be in the Active or RedemptionRequested
    ///        state,
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
            reservation.state == ReservationState.Active ||
                reservation.state == ReservationState.RedemptionRequested,
            "Reservation is not active"
        );
        require(
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp <=
                uint256(reservation.expiresAt) + self.reservationGracePeriod,
            "Reservation past grace period"
        );

        uint32 base = reservation.expiresAt;
        /* solhint-disable-next-line not-rely-on-time */
        if (base < block.timestamp) {
            /* solhint-disable-next-line not-rely-on-time */
            base = uint32(block.timestamp);
        }
        reservation.expiresAt = base + self.reservationTermSeconds;

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
    /// @dev Requirements:
    ///      - The caller must be the reservation vault, which must have
    ///        approved the Bridge in the Bank for the gross minted amount,
    ///      - The reservation must be in the Active state,
    ///      - If the redemption watchtower is set, the request must be
    ///        considered safe by the watchtower,
    ///      - `redeemerOutputScript` must be a standard type and must not
    ///        pay to the custodying wallet's public key hash.
    function requestReservedRedemption(
        BridgeState.Storage storage self,
        uint256 reservationKey,
        address redeemer,
        bytes calldata redeemerOutputScript
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

        if (self.redemptionWatchtower != address(0)) {
            require(
                IRedemptionWatchtower(self.redemptionWatchtower)
                    .isSafeRedemption(
                        reservation.walletPubKeyHash,
                        redeemerOutputScript,
                        self.reservationVault,
                        redeemer
                    ),
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

        reservation.state = ReservationState.RedemptionRequested;
        reservation.redeemer = redeemer;
        reservation.redeemerOutputScriptHash = keccak256(
            redeemerOutputScriptMem
        );
        /* solhint-disable-next-line not-rely-on-time */
        reservation.redemptionRequestedAt = uint32(block.timestamp);
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
        require(
            reservation.state == ReservationState.RedemptionRequested,
            "No pending reserved redemption"
        );

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

        require(
            reservation.anchorAmount - reservation.redemptionTxMaxFee <=
                outputValue &&
                outputValue <= reservation.anchorAmount,
            "Output value is not within the acceptable range"
        );

        closeReservation(self, reservation);

        // slither-disable-next-line reentrancy-events
        emit ReservedRedemptionCompleted(reservationKey, redemptionTxHash);

        // Burn the gross minted amount held by the Bridge since the
        // redemption request.
        self.bank.decreaseBalance(reservation.mintedAmount);
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

        reservation.state = ReservationState.Active;
        reservation.redeemer = address(0);
        reservation.redeemerOutputScriptHash = bytes32(0);
        reservation.redemptionRequestedAt = 0;
        reservation.redemptionTxMaxFee = 0;

        // Propagate timeout consequences to the wallet: slashing and state
        // transition follow exactly the regular redemption timeout rules.
        self.notifyWalletRedemptionTimeout(walletPubKeyHash, walletMembersIDs);

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

        reservation.state = ReservationState.Active;
        reservation.redeemer = address(0);
        reservation.redeemerOutputScriptHash = bytes32(0);
        reservation.redemptionRequestedAt = 0;
        reservation.redemptionTxMaxFee = 0;

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

        require(
            reservation.anchorAmount - newAnchorAmount <=
                self.reservationTxMaxFee,
            "Transaction fee is too high"
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

        // The miner fee reduces the on-chain earmarked amount. The gross
        // claim (`mintedAmount`) is unchanged; the accumulated in-kind fees
        // are settled when the reservation is redeemed (full gross burn).
        self.reservationTotalAmount -= (reservation.anchorAmount -
            newAnchorAmount);

        reservation.walletPubKeyHash = newWalletPubKeyHash;
        reservation.anchorAmount = newAnchorAmount;
        reservation.anchorTxHash = reanchorTxHash;
        reservation.anchorTxOutputIndex = 0;

        self.reservationsByAnchorUtxo[
            uint256(keccak256(abi.encodePacked(reanchorTxHash, uint32(0))))
        ] = reservationKey;

        emit ReservationReanchored(
            reservationKey,
            newWalletPubKeyHash,
            reanchorTxHash,
            newAnchorAmount
        );
    }

    /// @notice Used by the wallet to prove a dissolution transaction merging
    ///         an expired reservation's anchor outpoint into the wallet's
    ///         main UTXO. After dissolution the owner's minted balance
    ///         simply remains an ordinary pooled claim; no balances are
    ///         moved or burned.
    /// @param dissolutionTx Bitcoin dissolution transaction data.
    /// @param dissolutionProof Bitcoin dissolution proof data.
    /// @param mainUtxo Data of the wallet's main UTXO, as currently known on
    ///        the Ethereum chain. Ignored if the wallet has no main UTXO.
    /// @param reservationKey The key of the reservation being dissolved.
    /// @dev Requirements:
    ///      - The reservation must be in the Active state (a pending
    ///        reserved redemption always wins over dissolution),
    ///      - The custody term plus grace period must have elapsed,
    ///      - The custodying wallet must be in Live or MovingFunds state,
    ///      - If the wallet has a main UTXO, `dissolutionTx` must spend
    ///        exactly the anchor outpoint (first input) and that main UTXO
    ///        (second input); otherwise it must spend exactly the anchor
    ///        outpoint,
    ///      - `dissolutionTx` must have a single P2(W)PKH output locking
    ///        funds back on the custodying wallet's public key hash; that
    ///        output becomes the wallet's new main UTXO.
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

        Wallets.Wallet storage wallet = self.registeredWallets[
            reservation.walletPubKeyHash
        ];
        {
            Wallets.WalletState walletState = wallet.state;
            require(
                walletState == Wallets.WalletState.Live ||
                    walletState == Wallets.WalletState.MovingFunds,
                "Wallet must be in Live or MovingFunds state"
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
            self.extractPubKeyHash(output) == reservation.walletPubKeyHash,
            "Dissolution output must pay to the custodying wallet"
        );
        require(
            inputsTotalValue - outputValue <= self.reservationTxMaxFee,
            "Transaction fee is too high"
        );

        // The dissolution output becomes the wallet's new main UTXO: the
        // reserved backing rejoins the pooled supply.
        wallet.mainUtxoHash = keccak256(
            abi.encodePacked(dissolutionTxHash, uint32(0), outputValue)
        );

        closeReservation(self, reservation);

        emit ReservationDissolved(
            reservationKey,
            reservation.walletPubKeyHash,
            dissolutionTxHash
        );
    }

    /// @notice Updates the reservation parameters, including the
    ///         reservation vault address. Deposits revealed with the
    ///         reservation vault address are treated as reserved deposits.
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
        uint32 reservationTermSeconds,
        uint32 reservationGracePeriod,
        uint64 reservationMaxTotalAmount,
        uint32 maxReservationsPerWallet
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
            reservationTermSeconds > 0,
            "Reservation term must be greater than zero"
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
        self.reservationGracePeriod = reservationGracePeriod;
        self.reservationMaxTotalAmount = reservationMaxTotalAmount;
        self.maxReservationsPerWallet = maxReservationsPerWallet;

        emit ReservationParametersUpdated(
            reservationMinAmount,
            reservationTxMaxFee,
            reservationTermSeconds,
            reservationGracePeriod,
            reservationMaxTotalAmount,
            maxReservationsPerWallet
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
    ///         the wallet has a main UTXO, the second input must spend
    ///         exactly that main UTXO. Marks both consumed outpoints as
    ///         correctly spent.
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
                ) == mainUtxoHash,
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
    ///         wallet's main UTXO and marks it as correctly spent.
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
