// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../bank/Bank.sol";
import "../bridge/Bridge.sol";
import "../token/TBTC.sol";
import "../vault/TBTCVault.sol";

contract TBTCVaultHarness is TBTCVault {
    constructor(
        Bank _bank,
        TBTC _tbtcToken,
        Bridge _bridge
    ) TBTCVault(_bank, _tbtcToken, _bridge) {}

    function setOptimisticMintingDebtForTest(address depositor, uint256 amount)
        external
    {
        // Keep the aggregate outstanding-optimistic-debt counter consistent
        // with the per-depositor mapping so that a later repayment through
        // `repayOptimisticMintingDebt` does not underflow the counter.
        uint256 oldDebt = optimisticMintingDebt[depositor];
        if (oldDebt == 0 && amount > 0) {
            _outstandingOptimisticMintingDebtCount++;
        } else if (oldDebt > 0 && amount == 0) {
            _outstandingOptimisticMintingDebtCount--;
        }
        optimisticMintingDebt[depositor] = amount;
    }

    function setOptimisticMintingRequestForTest(
        bytes32 fundingTxHash,
        uint32 fundingOutputIndex,
        uint64 requestedAt,
        uint64 finalizedAt
    ) external {
        optimisticMintingRequests[
            calculateDepositKey(fundingTxHash, fundingOutputIndex)
        ] = OptimisticMintingRequest(requestedAt, finalizedAt);
    }
}
