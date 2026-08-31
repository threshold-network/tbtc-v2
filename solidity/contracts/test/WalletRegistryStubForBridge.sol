// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

/// @notice Minimal wallet registry stub used by Bridge tests.
contract WalletRegistryStubForBridge {
    address public walletOwner;

    function transferWalletOwnerRole(address newWalletOwner) external {
        walletOwner = newWalletOwner;
    }
}
