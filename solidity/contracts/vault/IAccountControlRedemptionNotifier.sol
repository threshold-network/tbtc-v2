// SPDX-License-Identifier: GPL-3.0-only

pragma solidity ^0.8.0;

/// @notice Interface the TBTCVault uses to reconcile Account Control (AC)
///         minted exposure when AC-origin TBTC is redeemed through the
///         irreversible legacy redemption path (`TBTCVault.unmintAndRedeem`
///         and the non-empty-`extraData` branch of `receiveApproval`).
/// @dev Implemented by the Account Control extension and wired into the vault
///      by governance via `TBTCVault.setAccountControlRedemptionNotifier`.
///      The legacy redemption path burns fungible TBTC without identifying the
///      AC reserve that originally minted it, so the vault cannot reconcile the
///      AC accounting on its own. It instead delegates to this notifier, which
///      owns the reserve mapping.
///
///      This notifier is deliberately NOT called from a plain unmint (no
///      redemption data). Unmint only returns transferable Bank balance to the
///      caller; Bank balance carries no provenance, so a decrement recorded
///      here for a plain unmint could later be detached from that balance once
///      transferred and re-minted by an unrelated holder, permanently
///      understating AC exposure. Once reconciliation is required, plain
///      unmint is blocked outright instead of calling this notifier — see
///      `TBTCVault._unmint`.
///
///      The implementation MUST:
///      - identify the AC reserve associated with `redeemer` and decrement that
///        reserve's minted exposure by `amount`;
///      - revert when a redemption of AC-origin supply cannot be reconciled, so
///        the legacy redemption reverts with it rather than silently leaving AC
///        exposure overstated;
///      - be a no-op (no revert) for redeemers that hold no AC exposure, so
///        regular, non-AC redemptions are unaffected.
interface IAccountControlRedemptionNotifier {
    /// @notice Reconciles AC minted exposure for a legacy redemption.
    /// @param redeemer The address whose TBTC is being burned by the legacy
    ///        redemption (the AC "user").
    /// @param amount The TBTC amount being redeemed, in 1e18 precision.
    function notifyLegacyRedemption(address redeemer, uint256 amount) external;
}
