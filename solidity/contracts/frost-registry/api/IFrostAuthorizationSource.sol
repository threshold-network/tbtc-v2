// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

/// @notice Authorization source consumed by the FROST wallet registry.
///         The current implementation is DAO-managed allowlist weights, but
///         this interface keeps the registry independent from that concrete
///         model so future permissionless or bonded sources can be introduced
///         without reviving legacy staking coupling.
interface IFrostAuthorizationSource {
    function authorizedWeight(address operatorProvider, address operator)
        external
        view
        returns (uint96);

    function approveAuthorizationDecrease(address operatorProvider)
        external
        returns (uint96);

    function rolesOf(address operatorProvider)
        external
        view
        returns (
            address owner,
            address payable beneficiary,
            address authorizer
        );

    function reportMaliciousBehavior(
        uint96 amount,
        uint256 rewardMultiplier,
        address notifier,
        address[] memory operatorProviders
    ) external;

    /// @notice Mirrors a registry-accepted inactivity penalty into the
    ///         authorization source's economic reward accounting.
    function onOperatorInactivity(
        address[] memory operatorProviders,
        uint64 ineligibleUntil
    ) external;

    /// @notice Advances exit-gate floors after registry-authoritative wallet
    ///         exposure has been repaired.
    function onWalletExposureReconciled(address[] memory operatorProviders)
        external;
}
