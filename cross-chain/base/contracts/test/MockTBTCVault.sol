// SPDX-License-Identifier: GPL-3.0-only

pragma solidity ^0.8.17;

/// @notice Minimal vault mock returning a configurable tbtcToken address.
/// @dev This contract is intended solely for testing purposes. It provides
///      a `tbtcToken()` getter that satisfies the ITBTCVault interface
///      requirement during L1BitcoinDepositor.initialize().
contract MockTBTCVault {
    address public tbtcToken;

    constructor(address _tbtcToken) {
        tbtcToken = _tbtcToken;
    }
}
