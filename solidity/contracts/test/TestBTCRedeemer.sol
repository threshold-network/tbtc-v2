// SPDX-License-Identifier: GPL-3.0-only

pragma solidity ^0.8.0;

import "../integrator/AbstractBTCRedeemer.sol";
import "../integrator/IBridge.sol";
import "../integrator/IBank.sol";
import "../integrator/BitcoinTx.sol";

contract TestBTCRedeemer is AbstractBTCRedeemer {
    event RequestRedemptionReturned(uint256 redemptionKey, uint256 tbtcAmount);

    function initialize(
        address _bridge,
        address _tbtcToken,
        address _bank
    ) external {
        __AbstractBTCRedeemer_initialize(_bridge, _tbtcToken, _bank);
        _transferOwnership(msg.sender); // Set owner for rescueTbtc
    }

    function requestRedemptionPublic(
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO calldata mainUtxo,
        bytes calldata redemptionOutputScript,
        uint64 amount
    ) external {
        (uint256 redemptionKey, uint256 tbtcAmount) = _requestRedemption(
            walletPubKeyHash,
            mainUtxo,
            redemptionOutputScript,
            amount
        );
        emit RequestRedemptionReturned(redemptionKey, tbtcAmount);
    }

    function calculateTbtcAmountPublic(
        uint64 redemptionAmountSat,
        uint64 redemptionTreasuryFeeSat
    ) external view returns (uint256) {
        return
            _calculateTbtcAmount(redemptionAmountSat, redemptionTreasuryFeeSat);
    }

    // Expose internal owner for testing purposes
    function exposedOwner() external view returns (address) {
        return owner();
    }

    function getRedemptionKeyPublic(
        bytes20 walletPubKeyHash,
        bytes memory script
    ) external pure returns (uint256) {
        return _getRedemptionKey(walletPubKeyHash, script);
    }
}
