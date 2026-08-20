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
///         size margin: the reservation feature (and its planned two-phase
///         settlement state machine) does not fit in the ~400 bytes the
///         monolithic Bridge implementation has left. Moving the surface to
///         a delegatecall extension gives reservations their own 24 kB
///         budget while changing nothing about the storage/address/authority
///         model.
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
///         reduction). A storage-layout parity test guards this.
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
///         via `Bridge.setReservationRouter`. Replacing router code
///         afterwards requires a Bridge implementation upgrade (the same
///         ceremony as any Bridge logic change), keeping code-change
///         authority exactly where it is today: with the proxy admin, not
///         with the parameter governance.
contract ReservationRouter is Governable, Initializable {
    using Reservation for BridgeState.Storage;

    // Mirror of the Bridge's storage anchor. `Governable` contributes slots
    // 0-49 (governance + gap) and `Initializable` the following slot, so
    // `self` starts at the same slot as in the Bridge. See invariant 1.
    BridgeState.Storage internal self;

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

    // Re-declaration of the event emitted by
    // `BridgeState.setReservationRouter` (invoked through
    // `Bridge.setReservationRouter`). Library events are not part of any
    // contract ABI under solc 0.8.17, so the router — the ABI home of the
    // reservation surface — declares it for off-chain consumers.
    event ReservationRouterSet(address reservationRouter);

    modifier onlySpvMaintainer() {
        require(
            self.isSpvMaintainer[msg.sender],
            "Caller is not SPV maintainer"
        );
        _;
    }

    /// @notice Single entry point for all reservation lifecycle SPV proofs:
    ///         anchor acceptance, in-kind reserved redemption, re-anchoring
    ///         and dissolution. See `Reservation.submitReservationProof` and
    ///         the individual handlers in the `Reservation` library for
    ///         detailed requirements.
    /// @param proofType The type of the submitted proof, see
    ///        `Reservation.ProofType`.
    /// @param txInfo Bitcoin transaction data.
    /// @param proof Bitcoin proof data.
    /// @param mainUtxo Data of the wallet's main UTXO; only used for
    ///        `Dissolution` proofs and ignored otherwise.
    /// @param reservationKey The key of the target reservation; ignored for
    ///        `Acceptance` proofs where the key is derived from the spent
    ///        deposit outpoint.
    function submitReservationProof(
        uint8 proofType,
        BitcoinTx.Info calldata txInfo,
        BitcoinTx.Proof calldata proof,
        BitcoinTx.UTXO calldata mainUtxo,
        uint256 reservationKey
    ) external onlySpvMaintainer {
        self.submitReservationProof(
            proofType,
            txInfo,
            proof,
            mainUtxo,
            reservationKey
        );
    }

    /// @notice Extends the custody term of a reservation by the current
    ///         reservation term length. Can only be called by the
    ///         reservation vault, which collects the custody fee for the
    ///         extension. See `Reservation.extendReservation`.
    /// @param reservationKey The key of the reservation to extend.
    function extendReservation(uint256 reservationKey) external {
        // The caller is checked in the library function.
        self.extendReservation(reservationKey);
    }

    /// @notice Requests an in-kind redemption of a reservation: the wallet
    ///         is expected to spend exactly the reservation's current anchor
    ///         outpoint to the redeemer output script in a 1-input-1-output
    ///         transaction. Can only be called by the reservation vault,
    ///         which must have approved the Bridge in the Bank for the gross
    ///         minted amount. See `Reservation.requestReservedRedemption`.
    /// @param reservationKey The key of the reservation to redeem.
    /// @param redeemer The address able to claim the surrendered balance
    ///        back if the redemption times out.
    /// @param redeemerOutputScript The redeemer's length-prefixed output
    ///        script (P2PKH, P2WPKH, P2SH or P2WSH).
    function requestReservedRedemption(
        uint256 reservationKey,
        address redeemer,
        bytes calldata redeemerOutputScript
    ) external {
        // The caller is checked in the library function.
        self.requestReservedRedemption(
            reservationKey,
            redeemer,
            redeemerOutputScript
        );
    }

    /// @notice Notifies that a pending reserved redemption has timed out.
    ///         Returns the surrendered balance to the redeemer, slashes the
    ///         wallet operators like a regular redemption timeout, and
    ///         returns the reservation to the Active state. See
    ///         `Reservation.notifyReservedRedemptionTimeout`.
    /// @param reservationKey The key of the reservation with the timed out
    ///        redemption.
    /// @param walletMembersIDs Identifiers of the wallet signing group
    ///        members.
    function notifyReservedRedemptionTimeout(
        uint256 reservationKey,
        uint32[] calldata walletMembersIDs
    ) external {
        self.notifyReservedRedemptionTimeout(reservationKey, walletMembersIDs);
    }

    /// @notice Notifies that a pending reserved redemption was vetoed in the
    ///         redemption watchtower. Detains the surrendered balance to the
    ///         watchtower and returns the reservation to the Active state.
    ///         See `Reservation.notifyReservedRedemptionVeto`.
    /// @param reservationKey The key of the reservation with the vetoed
    ///        redemption.
    function notifyReservedRedemptionVeto(uint256 reservationKey) external {
        // The caller is checked in the library function.
        self.notifyReservedRedemptionVeto(reservationKey);
    }

    /// @notice Updates parameters of reservations, including the
    ///         reservation vault address. Deposits revealed with the
    ///         reservation vault address are treated as UTXO reservations.
    /// @param reservationVault Address of the reservation vault. Can only be
    ///        changed while there are no active reservations.
    /// @param reservationMinAmount New value of the reservation minimum
    ///        amount in satoshis. It is the minimal anchor output amount
    ///        accepted for a reservation.
    /// @param reservationTxMaxFee New value of the reservation transaction
    ///        max fee in satoshis. It is the maximum amount of BTC
    ///        transaction fee that can be incurred by a single reservation
    ///        lifecycle transaction.
    /// @param reservationTermSeconds New value of the reservation custody
    ///        term length in seconds.
    /// @param reservationGracePeriod New value of the reservation grace
    ///        period in seconds.
    /// @param reservationMaxTotalAmount New cap on the total amount in
    ///        satoshi locked under active reservations.
    /// @param maxReservationsPerWallet New cap on the number of active
    ///        reservations a single wallet can custody.
    /// @dev Requirements:
    ///      - The caller must be the governance,
    ///      - See `Reservation.updateReservationParameters` for parameter
    ///        requirements.
    function updateReservationParameters(
        address reservationVault,
        uint64 reservationMinAmount,
        uint64 reservationTxMaxFee,
        uint32 reservationTermSeconds,
        uint32 reservationGracePeriod,
        uint64 reservationMaxTotalAmount,
        uint32 maxReservationsPerWallet
    ) external onlyGovernance {
        self.updateReservationParameters(
            reservationVault,
            reservationMinAmount,
            reservationTxMaxFee,
            reservationTermSeconds,
            reservationGracePeriod,
            reservationMaxTotalAmount,
            maxReservationsPerWallet
        );
    }

    /// @notice Collection of all reservations indexed by the deposit key of
    ///         the underlying reserved deposit, i.e.
    ///         `keccak256(fundingTxHash | fundingOutputIndex)`.
    /// @param reservationKey The key of the reservation.
    function reservations(uint256 reservationKey)
        external
        view
        returns (Reservation.ReservationRequest memory)
    {
        return self.reservations[reservationKey];
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
            uint32 reservationGracePeriod,
            uint64 reservationMaxTotalAmount,
            uint64 reservationTotalAmount,
            uint32 maxReservationsPerWallet
        )
    {
        reservationVault = self.reservationVault;
        reservationMinAmount = self.reservationMinAmount;
        reservationTxMaxFee = self.reservationTxMaxFee;
        reservationTermSeconds = self.reservationTermSeconds;
        reservationGracePeriod = self.reservationGracePeriod;
        reservationMaxTotalAmount = self.reservationMaxTotalAmount;
        reservationTotalAmount = self.reservationTotalAmount;
        maxReservationsPerWallet = self.maxReservationsPerWallet;
    }

    /// @notice Returns the address of the reservation router the Bridge
    ///         routes unmatched selectors to — i.e. the address of the
    ///         contract holding this code.
    function reservationRouter() external view returns (address) {
        return self.reservationRouter;
    }
}
