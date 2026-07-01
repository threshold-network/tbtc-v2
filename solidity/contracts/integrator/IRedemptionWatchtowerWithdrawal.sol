// SPDX-License-Identifier: GPL-3.0-only

pragma solidity ^0.8.0;

/// @notice Minimal interface of the RedemptionWatchtower contract, exposing
///         the vetoed-funds withdrawal path used by integrators.
/// @dev Named distinctly from the Bridge-side `IRedemptionWatchtower`
///      (see bridge/Redemption.sol) so both interfaces compile to separate
///      Hardhat artifacts and can be mocked without ambiguity.
///      See bridge/RedemptionWatchtower.sol for the production implementation.
interface IRedemptionWatchtowerWithdrawal {
    /// @notice Withdraws the non-penalty Bank balance of a vetoed redemption
    ///         request to the caller. The caller must be the recorded redeemer
    ///         of the vetoed request.
    /// @param redemptionKey Redemption key built as
    ///        `keccak256(keccak256(redeemerOutputScript) | walletPubKeyHash)`.
    function withdrawVetoedFunds(uint256 redemptionKey) external;
}
