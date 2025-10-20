// SPDX-License-Identifier: GPL-3.0-only

pragma solidity ^0.8.17;

library GovernanceUtils {
    /// @notice Reverts if the governance delay has not passed since
    ///         the change initiated time or if the change has not been
    ///         initiated.
    /// @param changeInitiatedTimestamp The timestamp at which the change has
    ///        been initiated.
    /// @param delay Governance delay.
    function onlyAfterGovernanceDelay(
        uint256 changeInitiatedTimestamp,
        uint256 delay
    ) internal view {
        require(changeInitiatedTimestamp > 0, "Change not initiated");
        require(
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp - changeInitiatedTimestamp >= delay,
            "Governance delay has not elapsed"
        );
    }

    /// @notice Gets the time remaining until the governable parameter update
    ///         can be committed.
    /// @param changeInitiatedTimestamp Timestamp indicating the beginning of
    ///        the change.
    /// @param delay Governance delay.
    /// @return Remaining time in seconds.
    function getRemainingGovernanceDelay(
        uint256 changeInitiatedTimestamp,
        uint256 delay
    ) internal view returns (uint256) {
        require(changeInitiatedTimestamp > 0, "Change not initiated");
        /* solhint-disable-next-line not-rely-on-time */
        uint256 elapsed = block.timestamp - changeInitiatedTimestamp;
        if (elapsed >= delay) {
            return 0;
        } else {
            return delay - elapsed;
        }
    }
}
