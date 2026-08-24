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

/// @notice Interface of the reservation vault's in-kind fee financing hook.
///         The Bridge calls it when a reservation settlement pays a Bitcoin
///         miner fee that no party surrenders TBTC for (re-anchor and
///         dissolution transactions): the vault burns supply equal to the
///         fee from its custody-fee reserve so total TBTC supply shrinks in
///         lockstep with the Bitcoin backing.
interface IReservationFeeFinancer {
    /// @notice Finances an in-kind Bitcoin miner fee: burns TBTC equal to
    ///         `feeSat` from the vault's fee reserve and the corresponding
    ///         Bank balance. If the reserve cannot cover the full amount,
    ///         the shortfall is recorded as public debt and the call still
    ///         succeeds — a confirmed Bitcoin spend must never fail to
    ///         settle because of the reserve level.
    /// @param feeSat The in-kind fee in satoshi.
    function financeInKindFee(uint64 feeSat) external;
}
