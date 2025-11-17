// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import {BTCUtils} from "@keep-network/bitcoin-spv-sol/contracts/BTCUtils.sol";

import "../bridge/Bridge.sol";

/// @notice Used only for system tests.
contract SystemTestRelay is IRelay {
    using BTCUtils for bytes;
    using BTCUtils for uint256;

    uint256 private currentEpochDifficulty;
    uint256 private prevEpochDifficulty;

    function setCurrentEpochDifficulty(uint256 _difficulty) external {
        currentEpochDifficulty = _difficulty;
    }

    function setPrevEpochDifficulty(uint256 _difficulty) external {
        prevEpochDifficulty = _difficulty;
    }

    function setCurrentEpochDifficultyFromHeaders(bytes memory bitcoinHeaders)
        external
    {
        uint256 firstHeaderDiff = bitcoinHeaders
            .extractTarget()
            .calculateDifficulty();

        currentEpochDifficulty = firstHeaderDiff;
    }

    function setPrevEpochDifficultyFromHeaders(bytes memory bitcoinHeaders)
        external
    {
        uint256 firstHeaderDiff = bitcoinHeaders
            .extractTarget()
            .calculateDifficulty();

        prevEpochDifficulty = firstHeaderDiff;
    }

    function getCurrentEpochDifficulty()
        external
        view
        override
        returns (uint256)
    {
        return currentEpochDifficulty;
    }

    function getPrevEpochDifficulty() external view override returns (uint256) {
        return prevEpochDifficulty;
    }
}
