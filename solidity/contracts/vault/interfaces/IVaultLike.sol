// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

/// @notice Minimal Vault-like surface used by MintBurnGuard for unminting.
/// @dev Only the `unmint` primitive is required for guard flows.
interface IVaultLike {
    function unmint(uint256 amount) external;
}
