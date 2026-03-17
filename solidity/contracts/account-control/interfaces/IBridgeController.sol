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

/// @notice Bridge surface for authorized controller-based minting.
/// @dev Minimal interface consumed by MintBurnGuard and other controllers
///      to execute mints via the Bridge's controller authorization system.
///
///      Security model:
///      - The Bridge exposes controller-based minting entrypoints that are
///        restricted to a single governance-authorized controller address
///        (set via Bridge.mintingController).
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
interface IBridgeController {
    function controllerIncreaseBalance(address recipient, uint256 amount)
        external;

    function controllerIncreaseBalances(
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external;

    /// @notice Returns the address of the authorized minting controller.
    function mintingController() external view returns (address);
}
