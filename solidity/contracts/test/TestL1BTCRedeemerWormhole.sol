// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../cross-chain/wormhole/L1BTCRedeemerWormhole.sol";

contract TestL1BTCRedeemerWormhole is L1BTCRedeemerWormhole {
    function seedTimedOutRedemptionRefund(
        uint256 redemptionKey,
        address l2User,
        uint256 sourceChainId,
        uint64 amountSat,
        uint32 requestedAt
    ) external {
        timedOutRedemptionRefunds[redemptionKey] = TimedOutRedemptionRefund({
            l2User: l2User,
            sourceChainId: sourceChainId,
            amountSat: amountSat,
            requestedAt: requestedAt
        });
    }

    function requireNoPendingTimedOutRedemptionRefund(uint256 redemptionKey)
        external
        view
    {
        _requireNoPendingTimedOutRedemptionRefund(redemptionKey);
    }
}
