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

    /// @notice Unmints TBTC from a user, burns the Bank balance, and reduces
    ///         global net exposure atomically.
    /// @param from User whose TBTC will be unminted (must have approved TBTC to guard).
    /// @param tbtcAmount Amount in TBTC satoshis (1e8) to unmint and burn.
    function unmintAndBurnFrom(address from, uint256 tbtcAmount) external;

    /// @notice Burns Bank balance from a user and reduces global exposure.
    /// @param from User whose Bank balance will be burned (must have approved Bank balance to guard).
    /// @param tbtcAmount Amount in TBTC satoshis (1e8) to burn from Bank.
    function burnFrom(address from, uint256 tbtcAmount) external;
}
