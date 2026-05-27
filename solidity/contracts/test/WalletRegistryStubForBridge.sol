// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

/// @notice Minimal wallet registry stub used by Bridge tests.
/// @dev This stub intentionally covers only owner-role transfer wiring used by
///      deploy resolution on allowStubs networks. Full `IWalletRegistry`
///      behavior in tests is provided by `smock.fake<IWalletRegistry>`.
contract WalletRegistryStubForBridge {
    address public walletOwner;

    function transferWalletOwnerRole(address newWalletOwner) external {
        walletOwner = newWalletOwner;
    }
}
