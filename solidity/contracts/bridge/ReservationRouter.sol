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

import "@keep-network/random-beacon/contracts/Governable.sol";

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "./BitcoinTx.sol";
import "./BridgeState.sol";
import "./Reservation.sol";

/// @title Bridge reservation router
/// @notice Holds the external UTXO-reservation surface of the Bridge. The
///         Bridge routes every call with an unmatched function selector to
///         this contract via `delegatecall` from its fallback function, so
///         all functions declared here execute at the Bridge address, on the
///         Bridge storage, with the Bridge's Bank authority — exactly as if
///         they were declared in `Bridge.sol` itself. Their selectors are
///         part of the Bridge ABI surface observable at the Bridge address.
///
///         The router exists to preserve the Bridge's EIP-170 deployment
///         size margin: the reservation feature and its two-phase
///         settlement state machine do not fit in the bytes the monolithic
///         Bridge implementation has left. Moving the surface to a
///         delegatecall extension gives reservations their own 24 kB
///         budget while changing nothing about the storage/address/
///         authority model.
///
///         Architecture notes (why delegatecall, not an external router):
///         the P2TR activation track routes *fraud signature checks* through
///         external router contracts the Bridge calls into. That shape works
///         for stateless verification, but reservations mutate core Bridge
///         state (deposits, wallets, spent-UTXO registry) and rely on the
///         Bank's Bridge-only authority (`increaseBalanceAndCall`,
///         `transferBalanceFrom`). An external contract would need a wide
///         set of privileged Bridge mutator callbacks — more new Bridge
///         bytecode than the refactor removes, and a brand-new authority
///         surface to audit. The delegatecall extension keeps the current
///         model: no new trusted party, no Bank changes, no ABI change for
///         off-chain clients.
/// @dev Security invariants, enforced by construction and by tests:
///
///      1. STORAGE PARITY. The router inherits the same storage-bearing
///         bases as the Bridge, in the same order, and declares the single
///         `BridgeState.Storage internal self` variable as its only storage
///         — so every storage reference made by router code resolves to the
///         same slots as in the Bridge. The router MUST NOT declare any
///         additional state variable; new reservation state goes into
///         `BridgeState.Storage` (appending, with a matching `__gap`
///         reduction). MUST be guarded by a storage-layout parity test;
///         guard lands with the Bridge-integration PR (PR #G) which is
///         out of scope here.
///
///      2. NO SELECTOR SHADOWING. A selector defined by the Bridge never
///         reaches the router (the fallback only sees unmatched calls). The
///         router must not declare a function the Bridge also declares; a
///         selector-disjointness test guards this.
///
///      3. NO STANDALONE AUTHORITY. Calling the router directly (not via the
///         Bridge fallback) executes on the router's own, empty storage:
///         `governance` is unset, no SPV maintainer is approved, the
///         reservation vault is zero, and the router holds no Bank balance
///         or authority — every state-changing entry point reverts. The
///         router needs no initialization and has no initializer.
///
///      4. UPGRADE MODEL. The Bridge stores the router address in
///         `BridgeState.Storage.reservationRouter`, settable exactly once
///         via the Bridge (Bridge-integration PR, out of scope). Replacing router code
///         afterwards requires a Bridge implementation upgrade (the same
///         ceremony as any Bridge logic change), keeping code-change
///         authority exactly where it is today: with the proxy admin, not
///         with the parameter governance.
contract ReservationRouter is Governable, Initializable {
    /// @notice This router is standalone/unreachable until the Bridge-integration PR lands.
    using BridgeState for BridgeState.Storage;
    using Reservation for BridgeState.Storage;

    // Mirror of the Bridge's storage anchor. `Governable` contributes slots
    // 0-49 (governance + gap) and `Initializable` the following slot, so
    // `self` starts at the same slot as in the Bridge. See invariant 1.
    BridgeState.Storage internal self;

    event ReservationAcceptanceRequested(
        uint256 indexed reservationKey,
        uint64 requestNonce,
        bytes20 indexed walletPubKeyHash,
        uint64 depositAmount,
        uint64 txMaxFee,
        uint32 timeoutAt
    );

    event ReservationAccepted(
        uint256 indexed reservationKey,
        uint64 requestNonce,
        bytes20 indexed walletPubKeyHash,
        address indexed owner,
        bytes32 anchorTxHash,
        uint64 anchorAmount,
        uint32 expiresAt
    );

    event ReservationReanchorRequested(
        uint256 indexed reservationKey,
        uint64 requestNonce,
        bytes20 indexed sourceWalletPubKeyHash,
        bytes20 indexed targetWalletPubKeyHash,
        uint64 txMaxFee
    );

    event ReservationReanchored(
        uint256 indexed reservationKey,
        uint64 requestNonce,
        bytes20 indexed newWalletPubKeyHash,
        bytes32 newAnchorTxHash,
        uint64 newAnchorAmount,
        uint64 minerFee
    );

    event ReservationAcceptanceTimedOut(
        uint256 indexed reservationKey,
        uint64 requestNonce
    );

    event ReservationActionTimedOut(
        uint256 indexed reservationKey,
        uint64 requestNonce,
        Reservation.ActionType actionType
    );

    event ReservationActionSuperseded(
        uint256 indexed reservationKey,
        uint64 requestNonce
    );

    event ReservationLateSettled(
        uint256 indexed reservationKey,
        uint64 requestNonce,
        Reservation.ActionType actionType
    );

    event ReservationRetryCreditMinted(uint256 indexed reservationKey);

    event ReservedDepositMarkedStale(uint256 indexed depositKey);

    event ReservationStranded(
        uint256 indexed reservationKey,
        bytes20 indexed walletPubKeyHash,
        address indexed owner,
        uint64 anchorAmount
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

    /// @dev Emitted by the eventual Bridge.setReservationRouter (out of scope
    ///      for this PR; arrives with the Bridge-integration PR). Declared here
    ///      because library events are not part of any contract ABI under
    ///      solc 0.8.17.
    event ReservationRouterSet(address reservationRouter);

    modifier onlySpvMaintainer() {
        require(
            self.isSpvMaintainer[msg.sender],
            "Caller is not SPV maintainer"
        );
        _;
    }

    /// @notice Requests the acceptance of a revealed reserved deposit: the
    ///         authorization for the designated wallet to perform the
    ///         anchor spend. Checks and reserves reservation capacity so
    ///         the anchor, once signed, can always be proven. See
    ///         `Reservation.requestReservationAcceptance`.
    /// @param reservationKey The deposit key of the revealed reserved
    ///        deposit (doubles as the reservation key).
    /// @param walletPubKeyHash 20-byte public key hash of the wallet that
    ///        will anchor the deposit.
    function requestReservationAcceptance(
        uint256 reservationKey,
        bytes20 walletPubKeyHash
    ) external {
        self.requestReservationAcceptance(reservationKey, walletPubKeyHash);
    }

    /// @notice Requests the re-anchoring of a reservation to another
    ///         wallet: the authorization for the source wallet to move the
    ///         anchor during migration or a governance-approved rotation.
    ///         See `Reservation.requestReservationReanchor`.
    /// @param reservationKey The key of the reservation to re-anchor.
    /// @param targetWalletPubKeyHash 20-byte public key hash of the target
    ///        wallet.
    function requestReservationReanchor(
        uint256 reservationKey,
        bytes20 targetWalletPubKeyHash
    ) external {
        self.requestReservationReanchor(
            reservationKey,
            targetWalletPubKeyHash,
            msg.sender == governance
        );
    }

    /// @notice Single entry point for reservation lifecycle SPV proofs
    ///         retained in milestone 1: anchor acceptance and re-anchoring.
    ///         Settles the named action generation. See
    ///         `ReservationProofs.submitReservationProof` (reached through
    ///         the `Reservation` library so this contract links exactly one
    ///         external library) and the individual handlers for detailed
    ///         requirements.
    /// @param proofType The type of the submitted proof, see
    ///        `ReservationProofs.ProofType`.
    /// @param txInfo Bitcoin transaction data.
    /// @param proof Bitcoin proof data.
    /// @param mainUtxo Unused in milestone 1; Dissolution proofs are rejected
    ///        by the underlying library. Reserved for milestone 2.
    /// @param reservationKey The key of the target reservation.
    /// @param requestNonce The action generation being settled. Late
    ///        settlements name an older, timed-out generation.
    function submitReservationProof(
        uint8 proofType,
        BitcoinTx.Info calldata txInfo,
        BitcoinTx.Proof calldata proof,
        BitcoinTx.UTXO calldata mainUtxo,
        uint256 reservationKey,
        uint64 requestNonce
    ) external onlySpvMaintainer {
        self.submitReservationProof(
            proofType,
            txInfo,
            proof,
            mainUtxo,
            reservationKey,
            requestNonce
        );
    }

    /// @notice Notifies that the pending action of the given reservation
    ///         has timed out. Writes the terminal, late-proof-accepting
    ///         record, releases reserved capacity and locks, refunds the
    ///         escrowed claim for redemptions, and slashes the wallet for
    ///         redemption and dissolution timeouts. See
    ///         `Reservation.notifyReservationActionTimeout`.
    /// @param reservationKey The key of the reservation with the timed out
    ///        action.
    /// @param walletMembersIDs Identifiers of the wallet signing group
    ///        members; only consulted on the slashing paths (redemption
    ///        and dissolution timeouts). Unreachable in milestone 1 (redemption
    ///        and dissolution timeouts do not occur); pass an empty array.
    function notifyReservationActionTimeout(
        uint256 reservationKey,
        uint32[] calldata walletMembersIDs
    ) external {
        self.notifyReservationActionTimeout(reservationKey, walletMembersIDs);
    }

    /// @notice Updates parameters of reservations, including the
    ///         reservation vault address. Deposits revealed with the
    ///         reservation vault address are treated as UTXO reservations.
    /// @param reservationVault Address of the reservation vault. Can only be
    ///        changed while there are no active reservations.
    /// @param reservationMinAmount New value of the reservation minimum
    ///        amount in satoshis.
    /// @param reservationTxMaxFee New value of the reservation transaction
    ///        max fee in satoshis.
    /// @param reservationTermSeconds New value of the reservation custody
    ///        term length in seconds, within the protocol bounds. Applies
    ///        to future term grants; never alters an existing expiry.
    /// @param reservationDissolutionDelay New value of the post-expiry
    ///        dissolution delay in seconds. Snapshotted per granted term.
    /// @param reservationMaxTotalAmount New cap on the total amount in
    ///        satoshi locked under active reservations.
    /// @param maxReservationsPerWallet New cap on the number of active
    ///        reservations a single wallet can custody.
    /// @param reservationActionTimeout New value of the reservation action
    ///        timeout in seconds.
    /// @param reservationRenewalWindowSeconds New length of the renewal
    ///        window; must stay strictly shorter than the term.
    /// @dev Requirements:
    ///      - The caller must be the governance,
    ///      - See `Reservation.updateReservationParameters` for parameter
    ///        requirements.
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
    ) external onlyGovernance {
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

    /// @notice Marks a revealed reserved deposit as stale so it stops
    ///         counting against the pending-reserved-deposit guard and can
    ///         no longer be authorized for acceptance. See
    ///         `Reservation.notifyStaleReservedDeposit`.
    /// @param depositKey The deposit key of the reserved deposit.
    function notifyStaleReservedDeposit(uint256 depositKey) external {
        self.notifyStaleReservedDeposit(depositKey);
    }

    /// @notice Permissionlessly reports a pending acceptance authorization
    ///         as timed out once its authorization window has elapsed,
    ///         releasing the capacity it reserved so a fresh generation can
    ///         be requested for the deposit. The timed-out generation
    ///         remains settleable: a late anchor proof still settles via
    ///         `submitReservationProof`. See
    ///         `Reservation.notifyReservationAcceptanceTimedOut`.
    /// @param reservationKey The deposit key of the revealed reserved
    ///        deposit, which doubles as the reservation key.
    function notifyReservationAcceptanceTimedOut(uint256 reservationKey)
        external
    {
        self.notifyReservationAcceptanceTimedOut(reservationKey);
    }

    /// @notice Marks a reservation custodied by a terminated, closing, or
    ///         closed wallet as stranded: an idle position closes, capacity
    ///         is released and the owner's minted balance remains an ordinary
    ///         pooled claim. Pending actions remain proof-eligible and
    ///         cannot be stranded. See
    ///         `Reservation.notifyReservationStranded`.
    /// @param reservationKey The key of the stranded reservation.
    function notifyReservationStranded(uint256 reservationKey) external {
        self.notifyReservationStranded(reservationKey);
    }

    /// @notice Updates the amount-denominated reservation caps (per-wallet
    ///         total anchor amount and single-reservation maximum) and the
    ///         global open-position occupancy cap. A zero amount-cap value
    ///         disables that amount cap. `maxActiveReservations` must be
    ///         greater than zero — it is the milestone 1 launch gate.
    ///         Caps are checked and reserved at request/authorization time,
    ///         never at proof time.
    /// @param maxReservationsAmountPerWallet New cap on the total satoshi
    ///        amount of anchors a single wallet can custody.
    /// @param reservationMaxSingleAmount New cap on the satoshi amount of
    ///        a single reservation.
    /// @param maxActiveReservations New global cap on open reservation
    ///        positions (pending acceptances reserved against it). Must be
    ///        greater than zero. Milestone 1 launch gate.
    /// @dev Requirements:
    ///      - The caller must be the governance.
    function updateReservationCaps(
        uint64 maxReservationsAmountPerWallet,
        uint64 reservationMaxSingleAmount,
        uint32 maxActiveReservations
    ) external onlyGovernance {
        self.updateReservationCaps(
            maxReservationsAmountPerWallet,
            reservationMaxSingleAmount,
            maxActiveReservations
        );
    }

    /// @notice Returns the amount-denominated reservation caps.
    function reservationCaps()
        external
        view
        returns (
            uint64 maxReservationsAmountPerWallet,
            uint64 reservationMaxSingleAmount
        )
    {
        maxReservationsAmountPerWallet = self.maxReservationsAmountPerWallet;
        reservationMaxSingleAmount = self.reservationMaxSingleAmount;
    }

    /// @notice Returns the total satoshi amount of reservation anchors
    ///         (and reserved capacity of pending reservation actions)
    ///         custodied by the given wallet.
    /// @param walletPubKeyHash 20-byte public key hash of the wallet.
    function walletReservationsAmount(bytes20 walletPubKeyHash)
        external
        view
        returns (uint64)
    {
        return self.walletReservationsAmount[walletPubKeyHash];
    }

    /// @notice Returns the number of reservations custodied by the given
    ///         wallet (including reserved capacity of pending actions).
    /// @param walletPubKeyHash 20-byte public key hash of the wallet.
    function walletReservationsCount(bytes20 walletPubKeyHash)
        external
        view
        returns (uint32)
    {
        return self.walletReservationsCount[walletPubKeyHash];
    }

    /// @notice Returns the reservation keys custodied by the given wallet.
    /// @param walletPubKeyHash 20-byte public key hash of the wallet.
    function walletReservations(bytes20 walletPubKeyHash)
        external
        view
        returns (uint256[] memory)
    {
        return self.walletReservationKeys[walletPubKeyHash];
    }

    /// @notice Returns the reservation key whose current anchor is the
    ///         given outpoint, or zero when the outpoint is not a tracked
    ///         anchor.
    /// @param anchorTxHash Hash of the transaction holding the anchor
    ///        output, in Bitcoin internal byte order.
    /// @param anchorTxOutputIndex Output index of the anchor output.
    function reservationByAnchorUtxo(
        bytes32 anchorTxHash,
        uint32 anchorTxOutputIndex
    ) external view returns (uint256) {
        return
            self.reservationsByAnchorUtxo[
                uint256(
                    keccak256(
                        abi.encodePacked(anchorTxHash, anchorTxOutputIndex)
                    )
                )
            ];
    }

    /// @notice Returns the designated wallet of a pending reserved deposit
    ///         (zero when the deposit is not pending).
    /// @param depositKey The deposit key of the reserved deposit.
    function reservedDepositWallet(uint256 depositKey)
        external
        view
        returns (bytes20)
    {
        return self.pendingReservedDeposit[depositKey].walletPubKeyHash;
    }

    /// @notice Returns the number of revealed reserved deposits that were
    ///         neither accepted nor marked stale yet.
    function pendingReservedDeposits() external view returns (uint64) {
        return self.pendingReservedDeposits;
    }

    /// @notice Collection of all reservation positions indexed by the
    ///         deposit key of the underlying reserved deposit, i.e.
    ///         `keccak256(fundingTxHash | fundingOutputIndex)`.
    /// @param reservationKey The key of the reservation.
    function reservations(uint256 reservationKey)
        external
        view
        returns (Reservation.ReservationRequest memory)
    {
        return self.reservations[reservationKey];
    }

    /// @notice Returns the action record of the given reservation
    ///         generation.
    /// @param reservationKey The key of the reservation.
    /// @param requestNonce The action generation.
    function reservationActions(uint256 reservationKey, uint64 requestNonce)
        external
        view
        returns (Reservation.ReservationAction memory)
    {
        return
            self.reservationActions[
                Reservation.actionKey(reservationKey, requestNonce)
            ];
    }

    /// @notice Returns the current values of Bridge reservation parameters.
    function reservationParameters()
        external
        view
        returns (
            address reservationVault,
            uint64 reservationMinAmount,
            uint64 reservationTxMaxFee,
            uint32 reservationTermSeconds,
            uint32 reservationDissolutionDelay,
            uint64 reservationMaxTotalAmount,
            uint64 reservationTotalAmount,
            uint32 maxReservationsPerWallet,
            uint32 reservationActionTimeout,
            uint32 reservationRenewalWindowSeconds
        )
    {
        reservationVault = self.reservationVault;
        reservationMinAmount = self.reservationMinAmount;
        reservationTxMaxFee = self.reservationTxMaxFee;
        reservationTermSeconds = self.reservationTermSeconds;
        reservationDissolutionDelay = self.reservationDissolutionDelay;
        reservationMaxTotalAmount = self.reservationMaxTotalAmount;
        reservationTotalAmount = self.reservationTotalAmount;
        maxReservationsPerWallet = self.maxReservationsPerWallet;
        reservationActionTimeout = self.reservationActionTimeout;
        reservationRenewalWindowSeconds = self.reservationRenewalWindowSeconds;
    }

    /// @notice Returns the global open-position occupancy and its governance
    ///         cap. `count` includes capacity reserved by pending acceptance
    ///         authorizations, matching the request-time reservation pattern
    ///         of `walletReservationsCount`.
    function activeReservationsCount()
        external
        view
        returns (uint32 count, uint32 maxActive)
    {
        count = self.activeReservationsCount;
        maxActive = self.maxActiveReservations;
    }

    /// @notice Returns the address of the reservation router the Bridge
    ///         routes unmatched selectors to — i.e. the address of the
    ///         contract holding this code.
    function reservationRouter() external view returns (address) {
        return self.reservationRouter;
    }
}
