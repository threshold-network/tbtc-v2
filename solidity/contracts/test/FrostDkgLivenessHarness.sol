// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../frost-registry/libraries/FrostDkg.sol";
import "../frost-registry/FrostDkgValidator.sol";
import "@keep-network/sortition-pools/contracts/SortitionPool.sol";

/// @notice Test harness exposing the production FrostDkg state transitions.
contract FrostDkgLivenessHarness {
    using FrostDkg for FrostDkg.Data;

    FrostDkg.Data private dkg;

    constructor(
        SortitionPool sortitionPool,
        FrostDkgValidator validator,
        address bridge,
        uint256 challengePeriod,
        uint256 submissionTimeout
    ) {
        dkg.init(sortitionPool, validator, bridge);
        dkg.parameters.resultChallengePeriodLength = challengePeriod;
        dkg.parameters.resultSubmissionTimeout = submissionTimeout;
    }

    function lockState() external {
        dkg.lockState();
    }

    function start(uint256 seed) external {
        dkg.start(seed);
    }

    function submitResult(FrostDkg.Result calldata result) external {
        dkg.submitResult(result);
    }

    function challengeResult(FrostDkg.Result calldata result)
        external
        returns (bytes32 maliciousResultHash, uint32 maliciousSubmitter)
    {
        return dkg.challengeResult(result);
    }

    function notifyDkgTimeout() external {
        dkg.notifyDkgTimeout();
    }

    function state() external view returns (FrostDkg.State) {
        return dkg.currentState();
    }

    function hasDkgTimedOut() external view returns (bool) {
        return dkg.hasDkgTimedOut();
    }

    function startBlock() external view returns (uint256) {
        return dkg.startBlock;
    }

    function resultSubmissionStartBlockOffset()
        external
        view
        returns (uint256)
    {
        return dkg.resultSubmissionStartBlockOffset;
    }

    function resultSubmissionDeadline() external view returns (uint256) {
        return
            dkg.startBlock +
            dkg.resultSubmissionStartBlockOffset +
            dkg.parameters.resultSubmissionTimeout;
    }
}
