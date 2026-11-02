// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../bridge/RedemptionWatchtower.sol";

/// @notice Test harness for the `RedemptionWatchtower` contract.
/// @dev `RedemptionWatchtower._redemptionDelay` is an internal function whose
///      final `else` arm reverts when the objections count is above the
///      required count. The production callers (`raiseObjection` and
///      `getRedemptionDelay`) can only ever pass an objections count of 0, 1
///      or 2, because the third objection finalizes the veto and deletes the
///      pending redemption. This harness exposes the function so the
///      unreachable arm can be exercised directly.
contract TestRedemptionWatchtower is RedemptionWatchtower {
    /// @notice Sets the delay parameters the function reads.
    /// @param _defaultDelay The delay applied to a redemption request with no
    ///        objections.
    /// @param _levelOneDelay The delay applied after one objection.
    /// @param _levelTwoDelay The delay applied after two objections.
    /// @param _waivedAmountLimit The redemption amount below which no delay
    ///        applies.
    function setDelayParameters(
        uint32 _defaultDelay,
        uint32 _levelOneDelay,
        uint32 _levelTwoDelay,
        uint64 _waivedAmountLimit
    ) external {
        defaultDelay = _defaultDelay;
        levelOneDelay = _levelOneDelay;
        levelTwoDelay = _levelTwoDelay;
        waivedAmountLimit = _waivedAmountLimit;
    }

    /// @notice Calls `RedemptionWatchtower._redemptionDelay`.
    /// @param objectionsCount The number of objections raised against the
    ///        redemption request.
    /// @param requestedAmount The requested redemption amount.
    /// @return The applicable redemption delay.
    function redemptionDelay(
        uint8 objectionsCount,
        uint64 requestedAmount
    ) external view returns (uint32) {
        return _redemptionDelay(objectionsCount, requestedAmount);
    }
}
