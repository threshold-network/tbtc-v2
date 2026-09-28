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

/// @notice Interface of the reservation vault's Bridge-only hooks.
///         The Bridge calls `creditReservation` when it proves a
///         reservation's acceptance anchor, and `financeInKindFee` when a
///         reservation settlement pays a Bitcoin miner fee that no party
///         surrenders TBTC for (re-anchor and dissolution transactions): the
///         vault burns supply equal to the fee from its custody-fee reserve
///         so total TBTC supply shrinks in lockstep with the Bitcoin backing.
interface IReservationFeeFinancer {
    /// @notice Credits an accepted reservation: the Bridge has just
    ///         increased the vault's Bank balance by the position's gross
    ///         anchored amount, and the vault mints TBTC gross, keeps the
    ///         acceptance fee and forwards the rest to the position's owner.
    ///         The vault reads the owner, the amount, the state and the term
    ///         of the position from the Bridge; the Bridge passes only the
    ///         key.
    /// @dev Called inside the acceptance proof, so the implementation must
    ///      not revert beyond checking that the caller is the Bridge: a
    ///      revert would leave a confirmed anchor unsettleable.
    /// @param reservationKey The key of the accepted reservation.
    function creditReservation(uint256 reservationKey) external;

    /// @notice Finances an in-kind Bitcoin miner fee: burns TBTC equal to
    ///         `feeSat` from the vault's fee reserve and the corresponding
    ///         Bank balance. If the reserve cannot cover the full amount,
    ///         the shortfall is recorded as public debt and the call still
    ///         succeeds — a confirmed Bitcoin spend must never fail to
    ///         settle because of the reserve level. This function has no
    ///         return value and the legitimate partial-burn case makes a
    ///         balance-delta check unreliable, so callers cannot fully
    ///         verify the burn from this call alone; a non-conforming vault
    ///         must be caught before it is wired up (governance-gated
    ///         `reservationVault`/`isVaultTrusted`), not at call time.
    /// @dev KNOWN GAP (tracked, not fixed here): nothing currently enforces
    ///      that "caught before wired up" claim -- if `reservationVault` is
    ///      ever set to a codeless/non-implementing address, the high-level
    ///      call to `financeInKindFee` reverts (Solidity inserts an
    ///      extcodesize check on every external interface call, including
    ///      void-return functions) instead of silently no-oping, blocking
    ///      settlement of the fee-bearing proof entirely rather than
    ///      silently skipping the burn. `Reservation.updateReservationParameters`
    ///      already wires `reservationVault` in this branch without a
    ///      conformance probe (e.g. ERC165 or a magic-constant call) at
    ///      that site -- the gap remains open and unaddressed.
    /// @param feeSat The in-kind fee in satoshi.
    function financeInKindFee(uint64 feeSat) external;
}
