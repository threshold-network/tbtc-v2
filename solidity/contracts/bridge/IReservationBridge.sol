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

import "./Reservation.sol";

/// @notice Interface of the UTXO-reservation surface observable at the
///         Bridge address. The functions listed here are implemented by the
///         `ReservationRouter` and reached through the Bridge's fallback via
///         `delegatecall`, so callers use this interface against the Bridge
///         address itself — the Bridge contract type does not declare them.
/// @dev In milestone 1, redemption, dissolution, veto, and renewal entry
///      points are deferred to a later milestone.
interface IReservationBridge {
    /// @notice Emitted when the deposit's depositor authorizes a wallet to
    ///         anchor a revealed reserved deposit. See
    ///         `ReservationRouter.requestReservationAcceptance`.
    /// @param reservationKey The deposit key of the revealed reserved
    ///        deposit (doubles as the reservation key).
    /// @param requestNonce The action generation created by this request.
    /// @param walletPubKeyHash 20-byte public key hash of the wallet
    ///        authorized to anchor the deposit.
    /// @param depositAmount Amount of the underlying deposit, in satoshi.
    /// @param txMaxFee Maximum Bitcoin miner fee snapshotted for this
    ///        generation, in satoshi.
    /// @param timeoutAt UNIX timestamp after which the authorization can be
    ///        reported timed out.
    event ReservationAcceptanceRequested(
        uint256 indexed reservationKey,
        uint64 requestNonce,
        bytes20 indexed walletPubKeyHash,
        uint64 depositAmount,
        uint64 txMaxFee,
        uint32 timeoutAt
    );

    /// @notice Emitted when an acceptance-anchor SPV proof settles,
    ///         registering the reservation and crediting the owner's
    ///         balance. See
    ///         `ReservationProofs.submitReservationAcceptanceProof`.
    /// @param reservationKey The key of the reservation.
    /// @param requestNonce The settled acceptance action generation.
    /// @param walletPubKeyHash 20-byte public key hash of the custodying
    ///        wallet.
    /// @param owner Address credited with the anchored balance (the
    ///        deposit's depositor).
    /// @param anchorTxHash Hash of the anchor transaction, in Bitcoin
    ///        internal byte order.
    /// @param anchorAmount Gross anchor value credited, in satoshi.
    /// @param expiresAt UNIX timestamp the reservation's custody term
    ///        expires at.
    event ReservationAccepted(
        uint256 indexed reservationKey,
        uint64 requestNonce,
        bytes20 indexed walletPubKeyHash,
        address indexed owner,
        bytes32 anchorTxHash,
        uint64 anchorAmount,
        uint32 expiresAt
    );

    /// @notice Emitted when a reservation's re-anchoring to another wallet
    ///         is authorized. See
    ///         `ReservationRouter.requestReservationReanchor`.
    /// @param reservationKey The key of the reservation being re-anchored.
    /// @param requestNonce The action generation created by this request.
    /// @param sourceWalletPubKeyHash 20-byte public key hash of the wallet
    ///        currently custodying the anchor.
    /// @param targetWalletPubKeyHash 20-byte public key hash of the wallet
    ///        authorized to receive the re-anchored funds.
    /// @param txMaxFee Maximum Bitcoin miner fee snapshotted for this
    ///        generation, in satoshi.
    event ReservationReanchorRequested(
        uint256 indexed reservationKey,
        uint64 requestNonce,
        bytes20 indexed sourceWalletPubKeyHash,
        bytes20 indexed targetWalletPubKeyHash,
        uint64 txMaxFee
    );

    /// @notice Emitted when a re-anchor SPV proof settles, moving the
    ///         reservation's anchor to the new wallet. See
    ///         `ReservationProofs.submitReservationReanchorProof`.
    /// @param reservationKey The key of the reservation.
    /// @param requestNonce The settled re-anchor action generation.
    /// @param newWalletPubKeyHash 20-byte public key hash of the wallet now
    ///        custodying the anchor.
    /// @param newAnchorTxHash Hash of the new anchor transaction, in
    ///        Bitcoin internal byte order.
    /// @param newAnchorAmount Value of the new anchor output, in satoshi.
    /// @param minerFee Bitcoin miner fee paid by the re-anchor transaction,
    ///        in satoshi.
    event ReservationReanchored(
        uint256 indexed reservationKey,
        uint64 requestNonce,
        bytes20 indexed newWalletPubKeyHash,
        bytes32 newAnchorTxHash,
        uint64 newAnchorAmount,
        uint64 minerFee
    );

    /// @notice Emitted when a pending re-anchor authorization's signing
    ///         window elapses without a settling proof, restoring the
    ///         reservation to Active under the source wallet and applying a
    ///         re-anchor cooldown. See
    ///         `Reservation.notifyReservationActionTimeout`.
    /// @param reservationKey The key of the reservation with the timed out
    ///        action.
    /// @param requestNonce The timed out re-anchor action generation.
    event ReservationReanchorTimedOut(
        uint256 indexed reservationKey,
        uint64 requestNonce
    );

    /// @notice Emitted when a pending acceptance authorization's signing
    ///         window elapses without a settling proof, releasing the
    ///         capacity it reserved. The generation remains settleable as a
    ///         late acceptance. See
    ///         `Reservation.notifyReservationAcceptanceTimedOut`.
    /// @param reservationKey The deposit key of the revealed reserved
    ///        deposit (doubles as the reservation key).
    /// @param requestNonce The timed out acceptance action generation.
    event ReservationAcceptanceTimedOut(
        uint256 indexed reservationKey,
        uint64 requestNonce
    );

    /// @notice Emitted when a pending action generation is superseded by a
    ///         newer request before it settles or times out.
    /// @param reservationKey The key of the reservation.
    /// @param requestNonce The superseded action generation.
    event ReservationActionSuperseded(
        uint256 indexed reservationKey,
        uint64 requestNonce
    );

    /// @notice Emitted when an already-timed-out action generation settles
    ///         late (its Bitcoin transaction confirms after
    ///         `notifyReservationActionTimeout`/
    ///         `notifyReservationAcceptanceTimedOut` already fired).
    /// @param reservationKey The key of the reservation.
    /// @param requestNonce The late-settled action generation.
    /// @param actionType The action type that settled late (Acceptance or
    ///        Reanchor).
    event ReservationLateSettled(
        uint256 indexed reservationKey,
        uint64 requestNonce,
        Reservation.ActionType actionType
    );

    /// @notice Emitted when a timed-out fee-paid redemption generation's
    ///         single-use retry entitlement is restored to the reservation
    ///         so a later generation may consume it again.
    /// @param reservationKey The key of the reservation credited with the
    ///        retry entitlement.
    event ReservationRetryCreditMinted(uint256 indexed reservationKey);

    /// @notice Emitted when a revealed reserved deposit is marked stale
    ///         (permissionlessly after its refund deadline elapses, or by
    ///         governance via `forceStaleReservedDeposit`), stopping it
    ///         from counting against the pending-reserved-deposit guard.
    /// @param depositKey The deposit key of the reserved deposit marked
    ///        stale.
    event ReservedDepositMarkedStale(uint256 indexed depositKey);

    /// @notice Emitted when an idle reservation custodied by a terminated,
    ///         closed, or dissolution-eligible closing wallet is stranded:
    ///         the position closes and capacity is released while the
    ///         owner's minted balance remains an ordinary pooled claim. See
    ///         `Reservation.notifyReservationStranded`.
    /// @param reservationKey The key of the stranded reservation.
    /// @param walletPubKeyHash 20-byte public key hash of the wallet that
    ///        was custodying the reservation.
    /// @param owner Address that retains the pooled balance claim.
    /// @param anchorAmount Value of the anchor the reservation was
    ///        custodying, in satoshi.
    event ReservationStranded(
        uint256 indexed reservationKey,
        bytes20 indexed walletPubKeyHash,
        address indexed owner,
        uint64 anchorAmount
    );

    /// @notice Emitted when governance updates the reservation parameters
    ///         via `updateReservationParameters`.
    /// @param reservationMinAmount New reservation minimum amount, in
    ///        satoshi.
    /// @param reservationTxMaxFee New reservation transaction max fee, in
    ///        satoshi.
    /// @param reservationTermSeconds New reservation custody term length,
    ///        in seconds.
    /// @param reservationDissolutionDelay New post-expiry dissolution
    ///        delay, in seconds.
    /// @param reservationMaxTotalAmount New cap on the total amount, in
    ///        satoshi, locked under active reservations.
    /// @param maxReservationsPerWallet New cap on the number of active
    ///        reservations a single wallet can custody.
    /// @param reservationActionTimeout New reservation action timeout, in
    ///        seconds.
    /// @param reservationRenewalWindowSeconds New renewal window length, in
    ///        seconds.
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

    /// @notice Emitted when governance changes the reservation vault
    ///         address via `updateReservationParameters`.
    /// @param reservationVault New reservation vault address. Deposits
    ///        revealed to this address are treated as UTXO reservations.
    event ReservationVaultUpdated(address reservationVault);

    /// @notice Emitted when governance updates the reservation caps via
    ///         `updateReservationCaps`.
    /// @param maxReservationsAmountPerWallet New cap on the total satoshi
    ///        amount of anchors a single wallet can custody; zero disables
    ///        the cap.
    /// @param reservationMaxSingleAmount New cap on the satoshi amount of a
    ///        single reservation; zero disables the cap.
    /// @param maxActiveReservations New global cap on open reservation
    ///        positions; must be positive.
    event ReservationCapsUpdated(
        uint64 maxReservationsAmountPerWallet,
        uint64 reservationMaxSingleAmount,
        uint32 maxActiveReservations
    );

    /// @notice Emitted whenever the global count of open reservation
    ///         positions changes, letting indexers track occupancy against
    ///         `maxActiveReservations` from logs alone.
    /// @param activeReservationsCount The new global count of open
    ///        reservation positions.
    event ReservationOccupancyChanged(uint32 activeReservationsCount);

    /// @notice Requests the acceptance of a revealed reserved deposit: the
    ///         authorization for the designated wallet to perform the
    ///         anchor spend. Checks and reserves reservation capacity so
    ///         the anchor, once signed, can always be proven.
    /// @dev Caller must be the deposit's depositor. Reverts unless: the
    ///      deposit is revealed to the reservation vault and not swept; no
    ///      acceptance authorization is already pending for it;
    ///      `walletPubKeyHash` is the deposit's designated wallet and is in
    ///      the Live state; no reservation already exists for the key; the
    ///      deposit amount satisfies the reservation minimum plus the
    ///      transaction fee allowance; the deposit amount does not exceed
    ///      the single-reservation cap; the wallet's reserved amount after
    ///      this deposit does not exceed the per-wallet amount cap; the
    ///      active reservations count stays below the global occupancy
    ///      cap; and a valid signing window exists between the deposit's
    ///      minimum age and its refund deadline. See
    ///      `Reservation.requestReservationAcceptance` for the full
    ///      requirement list.
    /// @param reservationKey The deposit key of the revealed reserved
    ///        deposit (doubles as the reservation key).
    /// @param walletPubKeyHash 20-byte public key hash of the wallet that
    ///        will anchor the deposit.
    function requestReservationAcceptance(
        uint256 reservationKey,
        bytes20 walletPubKeyHash
    ) external;

    /// @notice Requests the re-anchoring of a reservation to another
    ///         wallet: the authorization for the source wallet to move the
    ///         anchor during migration or a governance-approved rotation.
    /// @dev Callable by anyone when the source wallet is in the
    ///      MovingFunds or Closing state (the primary, permissionless
    ///      migration path). Callable only by Bridge governance when the
    ///      source wallet is still Live (an approved rotation). Reverts
    ///      unless: the reservation is Active; the target wallet is Live
    ///      and different from the source; the target wallet's
    ///      reservation-count and amount capacity allow the move; and a
    ///      valid signing window remains before the action-timeout safety
    ///      margin. A non-privileged call additionally reverts if the
    ///      reservation's re-anchor cooldown has not elapsed. See
    ///      `Reservation.requestReservationReanchor` for the full
    ///      requirement list.
    /// @param reservationKey The key of the reservation to re-anchor.
    /// @param targetWalletPubKeyHash 20-byte public key hash of the target
    ///        wallet.
    function requestReservationReanchor(
        uint256 reservationKey,
        bytes20 targetWalletPubKeyHash
    ) external;

    /// @notice Settles a reservation acceptance-anchor SPV proof: the named
    ///         action generation must be a settleable Acceptance. Marks the
    ///         underlying deposit as swept, registers the reservation and
    ///         credits the owner's balance with the gross anchor value
    ///         through the reservation vault.
    /// @dev Caller must be an approved SPV maintainer. Reverts unless: the
    ///      named generation is a settleable acceptance authorization for
    ///      the deposit; `txInfo`'s sole input spends the revealed reserved
    ///      deposit; `txInfo` has exactly one P2(W)PKH output locking funds
    ///      on the authorized wallet's public key hash; and the implied
    ///      Bitcoin miner fee does not exceed the authorization's
    ///      snapshotted fee bound. Together with the request-time deposit
    ///      minimum check, this guarantees the anchor value satisfies the
    ///      reservation minimum without any proof-time dependency on live
    ///      parameters. See
    ///      `ReservationProofs.submitReservationAcceptanceProof` for the
    ///      full requirement list.
    /// @param txInfo Bitcoin transaction data of the anchor transaction.
    /// @param proof Bitcoin SPV proof data for the anchor transaction.
    /// @param reservationKey The key of the target reservation.
    /// @param requestNonce The action generation being settled. Late
    ///        settlements name an older, timed-out generation.
    function submitReservationAcceptanceProof(
        BitcoinTx.Info calldata txInfo,
        BitcoinTx.Proof calldata proof,
        uint256 reservationKey,
        uint64 requestNonce
    ) external;

    /// @notice Settles a reservation re-anchor SPV proof: the named action
    ///         generation must be a settleable Reanchor. Moves the
    ///         reservation's anchor outpoint to the authorized target
    ///         wallet.
    /// @dev Caller must be an approved SPV maintainer. Reverts unless: the
    ///      named generation is a settleable re-anchor; `txInfo`'s sole
    ///      input spends the current anchor outpoint and creates a single
    ///      P2(W)PKH output paying the generation's authorized target
    ///      wallet; and the implied Bitcoin miner fee respects the
    ///      snapshotted bound while the re-anchored value stays above the
    ///      dust floor. See
    ///      `ReservationProofs.submitReservationReanchorProof` for the
    ///      full requirement list.
    /// @param txInfo Bitcoin transaction data of the re-anchor transaction.
    /// @param proof Bitcoin SPV proof data for the re-anchor transaction.
    /// @param reservationKey The key of the target reservation.
    /// @param requestNonce The action generation being settled. Late
    ///        settlements name an older, timed-out generation.
    function submitReservationReanchorProof(
        BitcoinTx.Info calldata txInfo,
        BitcoinTx.Proof calldata proof,
        uint256 reservationKey,
        uint64 requestNonce
    ) external;

    /// @notice Reports a pending reservation action as timed out once its
    ///         authorization window has elapsed. In milestone 1, releases
    ///         the target-wallet capacity reserved by a pending Reanchor
    ///         request, restores the reservation to Active under the source
    ///         wallet, and applies a re-anchor cooldown.
    /// @dev Callable by anyone. Reverts with "Unsupported action type for
    ///      timeout" for non-Reanchor action types. Reverts unless the
    ///      reservation is in the ActionPending state, its current action
    ///      is Pending, and `block.timestamp >= action.timeoutAt`. See
    ///      `Reservation.notifyReservationActionTimeout`.
    /// @param reservationKey The key of the reservation with the timed out
    ///        action.
    function notifyReservationActionTimeout(uint256 reservationKey) external;

    /// @notice Permissionlessly reports a pending acceptance authorization
    ///         as timed out once its authorization window has elapsed,
    ///         releasing the capacity it reserved so a fresh generation can
    ///         be requested for the deposit. The timed-out generation
    ///         remains settleable: if its anchor transaction later confirms
    ///         on Bitcoin, `submitReservationAcceptanceProof` settles it as
    ///         a late acceptance instead of reverting.
    /// @dev Callable by anyone. Reverts unless the reservation's current
    ///      generation is a pending acceptance authorization
    ///      (`ActionType.Acceptance`, `ActionState.Pending`) and
    ///      `block.timestamp` is at or after its `timeoutAt`. See
    ///      `Reservation.notifyReservationAcceptanceTimedOut`.
    /// @param reservationKey The deposit key of the revealed reserved
    ///        deposit, which doubles as the reservation key.
    function notifyReservationAcceptanceTimedOut(uint256 reservationKey)
        external;

    /// @notice Updates parameters of reservations, including the
    ///         reservation vault address. Deposits revealed with the
    ///         reservation vault address are treated as UTXO reservations.
    ///         Term, dissolution delay and fee bounds are snapshotted into
    ///         positions and action records when terms are granted or
    ///         actions requested; updates apply prospectively only.
    /// @dev Caller must be Bridge governance. Reverts unless:
    ///      `reservationTxMaxFee` is greater than zero;
    ///      `reservationMinAmount` is greater than `reservationTxMaxFee`;
    ///      `reservationTermSeconds` stays within the protocol's
    ///      [MIN_RESERVATION_TERM, MAX_RESERVATION_TERM] bounds;
    ///      `reservationRenewalWindowSeconds` is greater than zero and
    ///      strictly shorter than the term; `reservationActionTimeout`
    ///      exceeds the wallet validator's final signing safety margin;
    ///      `maxReservationsPerWallet` is greater than zero;
    ///      `reservationMaxTotalAmount` does not exceed the slot capacity
    ///      `maxActiveReservations * reservationMaxSingleAmount` (skipped
    ///      when either operand is zero/disabled); and `reservationVault`
    ///      is only changed while there are no active reservations. See
    ///      `Reservation.updateReservationParameters` for the full
    ///      requirement list.
    /// @param reservationVault Address of the reservation vault. Can only
    ///        be changed while there are no active reservations and no
    ///        pending reserved deposits.
    /// @param reservationMinAmount New value of the reservation minimum
    ///        amount, in satoshi.
    /// @param reservationTxMaxFee New value of the reservation transaction
    ///        max fee, in satoshi.
    /// @param reservationTermSeconds New value of the reservation custody
    ///        term length, in seconds, within the protocol bounds. Applies
    ///        to future term grants; never alters an existing expiry.
    /// @param reservationDissolutionDelay New value of the post-expiry
    ///        dissolution delay, in seconds. Snapshotted per granted term.
    /// @param reservationMaxTotalAmount New cap on the total amount, in
    ///        satoshi, locked under active reservations.
    /// @param maxReservationsPerWallet New cap on the number of active
    ///        reservations a single wallet can custody.
    /// @param reservationActionTimeout New value of the reservation action
    ///        timeout, in seconds.
    /// @param reservationRenewalWindowSeconds New length of the renewal
    ///        window; must stay strictly shorter than the term.
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
    ) external;

    /// @notice Marks a revealed reserved deposit as stale so it stops
    ///         counting against the pending-reserved-deposit guard and can
    ///         no longer be authorized for acceptance.
    /// @dev Callable by anyone. Reverts unless: the deposit is a pending
    ///      reserved deposit (revealed to the reservation vault, not
    ///      accepted, not already stale); no acceptance authorization is
    ///      pending for it; and the exact Bitcoin refund deadline
    ///      snapshotted at reveal has elapsed. See
    ///      `Reservation.notifyStaleReservedDeposit`.
    /// @param depositKey The deposit key of the reserved deposit.
    function notifyStaleReservedDeposit(uint256 depositKey) external;

    /// @notice Governance override of `notifyStaleReservedDeposit`: force-
    ///         clears a pending reserved deposit before its refund deadline
    ///         elapses, preventing a griefing depositor from indefinitely
    ///         holding a slot in the pending-reserved-deposit guard.
    /// @dev Caller must be Bridge governance. Reverts unless: the deposit
    ///      is a pending reserved deposit (revealed to the reservation
    ///      vault, not accepted, not already stale); and no acceptance
    ///      authorization is pending for it. Unlike
    ///      `notifyStaleReservedDeposit`, the refund deadline is not
    ///      checked — governance may clear the entry at any time. See
    ///      `Reservation.forceStaleReservedDeposit`.
    /// @param depositKey The deposit key of the reserved deposit.
    function forceStaleReservedDeposit(uint256 depositKey) external;

    /// @notice Marks a reservation custodied by a terminated or closed
    ///         wallet as stranded, or one custodied by a closing wallet once
    ///         the reservation's dissolution-eligible timestamp has passed:
    ///         an idle position closes, capacity is released and the
    ///         owner's minted balance remains an ordinary pooled claim.
    ///         Pending actions remain proof-eligible and cannot be
    ///         stranded.
    /// @dev Callable by anyone. Reverts unless the reservation is Active
    ///      and its custodying wallet is Terminated, Closed, or Closing
    ///      with `block.timestamp >= reservation.dissolutionEligibleAt`.
    ///      See `Reservation.notifyReservationStranded`.
    /// @param reservationKey The key of the stranded reservation.
    function notifyReservationStranded(uint256 reservationKey) external;

    /// @notice Updates the amount-denominated reservation caps (per-wallet
    ///         total anchor amount and single-reservation maximum) and the
    ///         global open-position occupancy cap. Caps are checked and
    ///         reserved at request/authorization time, never at proof time.
    /// @dev Caller must be Bridge governance. Reverts unless
    ///      `maxActiveReservations` is greater than zero (the milestone 1
    ///      launch gate) and the stored `reservationMaxTotalAmount` does
    ///      not exceed the slot capacity `maxActiveReservations *
    ///      reservationMaxSingleAmount` (skipped when either operand is
    ///      zero/disabled). See `Reservation.updateReservationCaps`.
    /// @param maxReservationsAmountPerWallet New cap on the total satoshi
    ///        amount of anchors a single wallet can custody; zero disables
    ///        the cap.
    /// @param reservationMaxSingleAmount New cap on the satoshi amount of a
    ///        single reservation; zero disables the cap.
    /// @param maxActiveReservations New global cap on open reservation
    ///        positions (pending acceptances reserved against it). Must be
    ///        greater than zero. Milestone 1 launch gate.
    function updateReservationCaps(
        uint64 maxReservationsAmountPerWallet,
        uint64 reservationMaxSingleAmount,
        uint32 maxActiveReservations
    ) external;

    /// @notice Returns the reservation caps: per-wallet anchor amount cap,
    ///         single-reservation maximum amount, and global open-position
    ///         occupancy cap.
    /// @return maxReservationsAmountPerWallet Cap on the total satoshi
    ///         amount of anchors a single wallet can custody; zero means
    ///         the cap is disabled.
    /// @return reservationMaxSingleAmount Cap on the satoshi amount of a
    ///         single reservation; zero means the cap is disabled.
    /// @return maxActiveReservations Global cap on open reservation
    ///         positions.
    function reservationCaps()
        external
        view
        returns (
            uint64 maxReservationsAmountPerWallet,
            uint64 reservationMaxSingleAmount,
            uint32 maxActiveReservations
        );

    /// @notice Bridge treasury address. Declared by the Bridge contract
    ///         itself (not the router); included here so reservation
    ///         consumers can use a single interface against the Bridge
    ///         address.
    /// @return The Bridge treasury address.
    function treasury() external view returns (address);

    /// @notice Returns the reservation position record for the given key,
    ///         indexed by the deposit key of the underlying reserved
    ///         deposit, i.e. `keccak256(fundingTxHash | fundingOutputIndex)`.
    ///         See the `Reservation.ReservationRequest` struct definition
    ///         for field-level documentation.
    /// @param reservationKey The key of the reservation.
    /// @return The reservation position record; a zeroed struct
    ///         (`state == ReservationState.Unknown`) when no reservation
    ///         exists for the key.
    function reservations(uint256 reservationKey)
        external
        view
        returns (Reservation.ReservationRequest memory);

    /// @notice Returns the action record of the given reservation
    ///         generation. See the `Reservation.ReservationAction` struct
    ///         definition for field-level documentation.
    /// @param reservationKey The key of the reservation.
    /// @param requestNonce The action generation.
    /// @return The action record; a zeroed struct
    ///         (`state == ActionState.Unknown`) when no such generation
    ///         exists.
    function reservationActions(uint256 reservationKey, uint64 requestNonce)
        external
        view
        returns (Reservation.ReservationAction memory);

    /// @notice Returns the current values of Bridge reservation parameters.
    /// @return reservationVault Address of the reservation vault. Deposits
    ///         revealed to this address are treated as UTXO reservations.
    /// @return reservationMinAmount Minimum reservation amount, in satoshi.
    /// @return reservationTxMaxFee Reservation transaction max fee, in
    ///         satoshi.
    /// @return reservationTermSeconds Reservation custody term length, in
    ///         seconds.
    /// @return reservationDissolutionDelay Post-expiry dissolution delay,
    ///         in seconds.
    /// @return reservationMaxTotalAmount Cap on the total amount, in
    ///         satoshi, locked under active reservations; zero disables
    ///         the cap.
    /// @return reservationTotalAmount Current total amount, in satoshi,
    ///         locked under active reservations.
    /// @return maxReservationsPerWallet Cap on the number of active
    ///         reservations a single wallet can custody.
    /// @return reservationActionTimeout Reservation action timeout, in
    ///         seconds.
    /// @return reservationRenewalWindowSeconds Renewal window length, in
    ///         seconds.
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
        );

    /// @notice Returns the total satoshi amount of reservation anchors
    ///         (and reserved capacity of pending reservation actions)
    ///         custodied by the given wallet.
    /// @param walletPubKeyHash 20-byte public key hash of the wallet.
    /// @return Total reserved amount, in satoshi, custodied by the wallet.
    function walletReservationsAmount(bytes20 walletPubKeyHash)
        external
        view
        returns (uint64);

    /// @notice Returns the number of reservations custodied by the given
    ///         wallet (including reserved capacity of pending actions).
    /// @param walletPubKeyHash 20-byte public key hash of the wallet.
    /// @return Number of reservations custodied by the wallet.
    function walletReservationsCount(bytes20 walletPubKeyHash)
        external
        view
        returns (uint32);

    /// @notice Returns the reservation key whose current anchor is the
    ///         given outpoint, or zero when the outpoint is not a tracked
    ///         anchor.
    /// @param anchorTxHash Hash of the transaction holding the anchor
    ///        output, in Bitcoin internal byte order.
    /// @param anchorTxOutputIndex Output index of the anchor output.
    /// @return The reservation key, or zero if the outpoint is not a
    ///         tracked anchor.
    function reservationByAnchorUtxo(
        bytes32 anchorTxHash,
        uint32 anchorTxOutputIndex
    ) external view returns (uint256);

    /// @notice Returns the designated wallet of a pending reserved deposit
    ///         (zero when the deposit is not pending).
    /// @param depositKey The deposit key of the reserved deposit.
    /// @return 20-byte public key hash of the designated wallet, or zero
    ///         when the deposit is not a pending reserved deposit.
    function reservedDepositWallet(uint256 depositKey)
        external
        view
        returns (bytes20);

    /// @notice Returns the number of revealed reserved deposits that were
    ///         neither accepted nor marked stale yet.
    /// @return Count of pending reserved deposits.
    function pendingReservedDeposits() external view returns (uint64);

    /// @notice Returns the global open-position occupancy and its
    ///         governance cap. `count` includes capacity reserved by
    ///         pending acceptance authorizations, matching the
    ///         request-time reservation pattern of
    ///         `walletReservationsCount`.
    /// @return count Current global count of open reservation positions.
    /// @return maxActive Governance-set cap on `count`.
    function activeReservationsCount()
        external
        view
        returns (uint32 count, uint32 maxActive);

    /// @notice Returns the address of the reservation router the Bridge
    ///         routes unmatched selectors to — i.e. the address of the
    ///         contract holding this code.
    /// @return The reservation router address.
    function reservationRouter() external view returns (address);
}
