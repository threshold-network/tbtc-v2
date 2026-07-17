// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice This interface contains the only RMN-related functions that might be used on-chain by other CCIP contracts.
interface IRMN {
    /// @notice Iff there is an active global curse, or an active curse for `subject`, this function returns true.
    /// @param subject To check whether a particular chain is cursed, set to bytes16(uint128(chainSelector)).
    function isCursed(bytes16 subject) external view returns (bool);
}
