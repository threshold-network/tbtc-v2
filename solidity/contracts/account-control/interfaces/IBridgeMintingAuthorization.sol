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

/// @notice Minimal Bridge surface consumed by AccountControl for minting.
interface IBridgeMintingAuthorization {
    function controllerIncreaseBalance(address recipient, uint256 amount)
        external;

    function controllerIncreaseBalances(
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external;

    function authorizedBalanceIncreasers(address increaser)
        external
        view
        returns (bool);

    function getAuthorizedBalanceIncreasers(address[] calldata increasers)
        external
        view
        returns (bool[] memory);
}
