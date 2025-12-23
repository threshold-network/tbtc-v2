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

/// @title Mint/Burn Guard interface
/// @notice Minimal surface used by external operator logic (e.g. AccountControl)
///         to respect system-level caps and coordinate TBTC mint/burn execution.
/// @dev Owner-only migration helpers are intentionally omitted. Keep this in
///      sync with the AccountControl-side `IMintBurnGuard` in the tbtc-v2-ac
///      repository when the surface changes.
interface IMintBurnGuard {
    /// @notice Returns the current global net minted amount tracked by the guard.
    /// @dev Amount is expressed in TBTC satoshis (1e8).
    function totalMinted() external view returns (uint256);

    /// @notice Returns the current global mint cap.
    /// @dev A value of zero means the global cap is not enforced.
    function globalMintCap() external view returns (uint256);

    /// @notice Indicates whether operator-driven minting is globally paused.
    function mintingPaused() external view returns (bool);

    /// @notice Mints TBTC into the Bank via the Bridge and updates global net exposure.
    /// @param recipient Address receiving the TBTC bank balance.
    /// @param tbtcAmount Amount in TBTC satoshis (1e8) to add to exposure.
    function mintToBank(address recipient, uint256 tbtcAmount) external;

    /// @notice Burns TBTC bank balance via the underlying Bank and reduces
    ///         global net exposure.
    /// @param from Source address for burns that operate on balances.
    /// @param tbtcAmount Amount in TBTC satoshis (1e8) to burn from the Bank.
    function burnFromBank(address from, uint256 tbtcAmount) external;

    /// @notice Unmints TBTC via the underlying Vault and reduces global net exposure.
    /// @param tbtcAmount Amount in TBTC satoshis (1e8) to unmint.
    function unmintFromVault(uint256 tbtcAmount) external;
}
