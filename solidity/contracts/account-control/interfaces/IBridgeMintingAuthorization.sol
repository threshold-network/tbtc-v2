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
/// @dev Security model:
///      - The Bridge exposes controller-based minting entrypoints that are
///        restricted to governance-authorized controller contracts via the
///        `authorizedBalanceIncreasers` mapping.
///      - The Bridge **does not** enforce per-controller caps or rate limits;
///        it only enforces _who_ can mint. Global caps, pauses, and any
///        per-protocol policy must be implemented in MintBurnGuard
///        and the controller contracts themselves.
///      - Controller contracts MUST implement their own access control,
///        limits, and pause/kill switches so that a compromise or bug in a
///        controller does not result in unbounded system-wide minting within
///        their configured allowance.
///      - Only fully reviewed and audited contracts, under governance
///        control, should ever be authorized as controllers.
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
