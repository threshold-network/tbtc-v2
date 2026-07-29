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

/// @notice Lifecycle status of a signer operator in the delegated staking
///         module.
/// @dev File-scoped so that other contracts can import the enum without
///      pulling in the full interface. `None` is the default for unknown
///      staking providers. `Active` operators are eligible for weight and
///      new delegations. `Deactivating` operators keep their status until a
///      later lifecycle drain but carry zero weight and accept no new stake.
///      `Ejected` is an instant, governance-triggered terminal status.
enum OperatorStatus {
    None,
    Active,
    Deactivating,
    Ejected
}

/// @notice Governance-managed registry of signer operators for the delegated
///         staking module. Maps staking providers to their node operator and
///         beneficiary addresses, tracks operator lifecycle status, and
///         manages time-noticed commission declarations.
interface ISignerRegistry {
    /// @notice Returns the lifecycle status of the given staking provider.
    /// @param stakingProvider Address of the staking provider.
    /// @return Current `OperatorStatus`; `None` for unknown providers.
    function operatorStatus(address stakingProvider)
        external
        view
        returns (OperatorStatus);

    /// @notice Returns true if the given staking provider's status is
    ///         `Active`. Only active operators are eligible for authorization
    ///         weight and can receive new delegations; `Deactivating` and
    ///         `Ejected` operators resolve to a weight of zero.
    /// @param stakingProvider Address of the staking provider.
    /// @return True if the operator is `Active`.
    function isActive(address stakingProvider) external view returns (bool);

    /// @notice Returns the node operator address registered for the given
    ///         staking provider.
    /// @param stakingProvider Address of the staking provider.
    /// @return Node operator address; zero address if none registered.
    function nodeOperatorOf(address stakingProvider)
        external
        view
        returns (address);

    /// @notice Returns the staking provider a node operator address is
    ///         registered under. Each node operator address can be used by
    ///         at most one staking provider.
    /// @param nodeOperator Address of the node operator.
    /// @return Staking provider address; zero address if none registered.
    function stakingProviderOf(address nodeOperator)
        external
        view
        returns (address);

    /// @notice Returns the beneficiary address that receives rewards
    ///         (operator commission) for the given staking provider.
    /// @param stakingProvider Address of the staking provider.
    /// @return Payable beneficiary address.
    function beneficiaryOf(address stakingProvider)
        external
        view
        returns (address payable);

    /// @notice Returns the commission the operator takes from delegator
    ///         rewards, in basis points. A pending commission declared by the
    ///         operator becomes the returned value only once its notice
    ///         period has elapsed (`block.timestamp >= commissionEffectiveAt`);
    ///         until then the previously effective value is returned.
    /// @param stakingProvider Address of the staking provider.
    /// @return Effective commission in basis points.
    function commissionBpsOf(address stakingProvider)
        external
        view
        returns (uint16);
}
