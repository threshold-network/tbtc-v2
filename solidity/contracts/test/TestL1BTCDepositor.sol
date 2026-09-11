// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../cross-chain/AbstractL1BTCDepositor.sol";

/// @notice Test implementation of the `AbstractL1BTCDepositor` contract.
///         Used to test the base contract logic in isolation from any
///         specific bridging integration.
contract TestL1BTCDepositor is AbstractL1BTCDepositor {
    /// @notice Deposit key whose deferred gas reimbursement entry is
    ///         inspected during the `_transferTbtc` call.
    uint256 public trackedDepositKey;
    /// @notice True if `gasReimbursements[trackedDepositKey]` was already
    ///         cleared from storage at the time `_transferTbtc` executed.
    bool public reimbursementClearedBeforeTransfer;

    event TbtcTransferred(uint256 amount, bytes32 destinationChainReceiver);

    function initialize(address _tbtcBridge, address _tbtcVault)
        external
        initializer
    {
        __AbstractL1BTCDepositor_initialize(_tbtcBridge, _tbtcVault);
        __Ownable_init();
    }

    function setTrackedDepositKey(uint256 depositKey) external {
        trackedDepositKey = depositKey;
    }

    function _transferTbtc(uint256 amount, bytes32 destinationChainReceiver)
        internal
        override
    {
        reimbursementClearedBeforeTransfer =
            gasReimbursements[trackedDepositKey].receiver == address(0);

        emit TbtcTransferred(amount, destinationChainReceiver);
    }
}
