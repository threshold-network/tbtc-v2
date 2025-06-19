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

pragma solidity ^0.8.0;

/// @notice Interface of the TBTCVault contract.
/// @dev See vault/TBTCVault.sol
interface ITBTCVault {
    /// @dev See {TBTCVault#optimisticMintingRequests}
    function optimisticMintingRequests(uint256 depositKey)
        external
        returns (uint64 requestedAt, uint64 finalizedAt);

    /// @dev See {TBTCVault#optimisticMintingFeeDivisor}
    function optimisticMintingFeeDivisor() external view returns (uint32);

    /// @dev See {TBTCVault#tbtcToken}
    function tbtcToken() external view returns (address);
}
