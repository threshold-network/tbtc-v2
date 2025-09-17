// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

/// @dev TrimmedAmount is a packed representation of an amount and its decimals
/// The amount is stored as a uint64 and the decimals as a uint8
/// This is used to reduce the size of cross-chain messages
type TrimmedAmount is uint256;

library TrimmedAmountLib {
    /// @notice Extracts the amount from a TrimmedAmount
    /// @param ta The TrimmedAmount to extract from
    /// @return The amount as a uint64
    function getAmount(TrimmedAmount ta) internal pure returns (uint64) {
        return uint64(TrimmedAmount.unwrap(ta) >> 8);
    }

    /// @notice Extracts the decimals from a TrimmedAmount
    /// @param ta The TrimmedAmount to extract from
    /// @return The decimals as a uint8
    function getDecimals(TrimmedAmount ta) internal pure returns (uint8) {
        return uint8(TrimmedAmount.unwrap(ta));
    }

    /// @notice Scales an amount to a different number of decimals
    /// @param amount The amount to scale
    /// @param fromDecimals The current number of decimals
    /// @param toDecimals The target number of decimals
    /// @return The scaled amount
    function scale(uint256 amount, uint8 fromDecimals, uint8 toDecimals) internal pure returns (uint256) {
        if (fromDecimals == toDecimals) {
            return amount;
        } else if (fromDecimals < toDecimals) {
            return amount * (10 ** (toDecimals - fromDecimals));
        } else {
            return amount / (10 ** (fromDecimals - toDecimals));
        }
    }

    /// @notice Trims an amount to fit in a uint64
    /// @param amount The amount to trim
    /// @param decimals The number of decimals
    /// @return The trimmed amount that fits in uint64
    /// @return The adjusted decimals
    function trim(uint256 amount, uint8 decimals) internal pure returns (uint64, uint8) {
        if (amount <= type(uint64).max) {
            return (uint64(amount), decimals);
        }

        // Need to reduce precision to fit in uint64
        uint8 trimmedDecimals = decimals;
        uint256 trimmedAmount = amount;

        while (trimmedAmount > type(uint64).max && trimmedDecimals > 0) {
            trimmedAmount /= 10;
            trimmedDecimals--;
        }

        // If still too large, clamp to max uint64
        if (trimmedAmount > type(uint64).max) {
            trimmedAmount = type(uint64).max;
        }

        return (uint64(trimmedAmount), trimmedDecimals);
    }

    /// @notice Untrim an amount back to its original precision
    /// @param amount The trimmed amount
    /// @param decimals The trimmed decimals
    /// @param targetDecimals The target decimals to scale to
    /// @return The untrimmed amount
    function untrim(uint64 amount, uint8 decimals, uint8 targetDecimals) internal pure returns (uint256) {
        return scale(amount, decimals, targetDecimals);
    }
}

/// @notice Pack an amount and decimals into a TrimmedAmount
/// @param amount The amount to pack
/// @param decimals The decimals to pack
/// @return The packed TrimmedAmount
function packTrimmedAmount(uint64 amount, uint8 decimals) pure returns (TrimmedAmount) {
    return TrimmedAmount.wrap((uint256(amount) << 8) | uint256(decimals));
}

/// @notice Create a TrimmedAmount from a full precision amount
/// @param amount The full precision amount
/// @param decimals The number of decimals
/// @return The TrimmedAmount
function toTrimmedAmount(uint256 amount, uint8 decimals) pure returns (TrimmedAmount) {
    (uint64 trimmedAmount, uint8 trimmedDecimals) = TrimmedAmountLib.trim(amount, decimals);
    return packTrimmedAmount(trimmedAmount, trimmedDecimals);
}
