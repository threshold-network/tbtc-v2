// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

/// @title Wallet proposal validator timing constants
/// @notice Shared timing policy used both when a wallet action is requested
///         and when the resulting proposal is validated for signing.
///         `REQUEST_TIMEOUT_SAFETY_MARGIN` also gates reservation
///         acceptance requests (`Reservation.requestReservationAcceptance`)
///         alongside deposit sweep and redemption.
library WalletProposalValidatorConstants {
    uint32 internal constant DEPOSIT_MIN_AGE = 2 hours;
    uint32 internal constant DEPOSIT_REFUND_SAFETY_MARGIN = 24 hours;
    uint32 internal constant REQUEST_TIMEOUT_SAFETY_MARGIN = 2 hours;
}
