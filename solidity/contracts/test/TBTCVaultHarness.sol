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
