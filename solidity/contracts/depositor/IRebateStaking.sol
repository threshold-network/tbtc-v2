// SPDX-License-Identifier: GPL-3.0-only

// ██████████████     ▐████▌     ██████████████
// ██████████████     ▐████▌     ██████████████
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
// ██████████████     ▐████▌     ██████████████
// ██████████████     ▐████▌     ██████████████
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌

pragma solidity 0.8.17;

/// @notice Minimal view interface into the `RebateStaking` contract used by
///         depositors to gate fee waivers on a receiver's T stake. Kept
///         intentionally narrow to avoid coupling depositors to the full
///         `RebateStaking` storage layout. The concrete `RebateStaking`
///         contract is not declared as implementing this interface to avoid
///         expanding the audited contract's surface; the function signature
///         matches by convention.
// slither-disable-next-line missing-inheritance
interface IRebateStaking {
    /// @notice Returns the raw `stakedAmount` recorded for `user`. This is
    ///         the gross stake and is not reduced by an in-progress unstake.
    function getStake(address user) external view returns (uint96 stakedAmount);
}
