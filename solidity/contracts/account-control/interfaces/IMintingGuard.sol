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

/// @title Minting Guard interface
/// @notice Minimal surface used by external controller logic (e.g. AccountControl)
///         to report net-minting operations and respect system-level caps.
interface IMintingGuard {
    /// @notice Returns the current global net minted amount tracked by the guard.
    /// @dev Amount is expressed in satoshis or the configured base unit.
    function totalMinted() external view returns (uint256);

    /// @notice Returns the current global mint cap.
    /// @dev A value of zero means the global cap is not enforced.
    function globalMintCap() external view returns (uint256);

    /// @notice Indicates whether controller-driven minting is globally paused.
    function mintingPaused() external view returns (bool);

    /// @notice Increases the global net-minted amount.
    /// @param amount Amount to add to the total minted exposure.
    /// @return newTotal The updated total minted amount.
    function increaseTotalMinted(uint256 amount)
        external
        returns (uint256 newTotal);

    /// @notice Decreases the global net-minted amount.
    /// @param amount Amount to subtract from the total minted exposure.
    /// @return newTotal The updated total minted amount.
    function decreaseTotalMinted(uint256 amount)
        external
        returns (uint256 newTotal);
}
