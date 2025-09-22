// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

/// @notice A library for handling trimmed amounts with decimals
/// @dev This library provides utilities for working with amounts that have been trimmed
///      to remove unnecessary precision while preserving the decimal information
library TrimmedAmountLib {
    /// @notice Error thrown when the amount exceeds the maximum allowed value
    /// @dev Selector 0x4e487b71
    error AmountTooLarge(uint256 amount);

    /// @notice Error thrown when the decimals value exceeds the maximum allowed value
    /// @dev Selector 0x4e487b72
    error DecimalsTooLarge(uint8 decimals);

    /// @notice Maximum allowed amount (2^64 - 1)
    uint256 constant MAX_AMOUNT = type(uint64).max;
    
    /// @notice Maximum allowed decimals (255)
    uint8 constant MAX_DECIMALS = type(uint8).max;

    /// @notice Pack an amount and decimals into a single uint256
    /// @param amount The amount to pack (must be <= MAX_AMOUNT)
    /// @param decimals The number of decimals (must be <= MAX_DECIMALS)
    /// @return packed The packed amount and decimals
    function packTrimmedAmount(uint64 amount, uint8 decimals) internal pure returns (uint256) {
        if (amount > MAX_AMOUNT) {
            revert AmountTooLarge(amount);
        }
        if (decimals > MAX_DECIMALS) {
            revert DecimalsTooLarge(decimals);
        }
        
        // Pack amount in the lower 64 bits and decimals in the upper 8 bits
        return (uint256(decimals) << 64) | uint256(amount);
    }

    /// @notice Unpack a packed amount and decimals
    /// @param packed The packed amount and decimals
    /// @return amount The unpacked amount
    /// @return decimals The unpacked decimals
    function unpackTrimmedAmount(uint256 packed) internal pure returns (uint64, uint8) {
        return (uint64(packed & MAX_AMOUNT), uint8(packed >> 64));
    }

    /// @notice Get the amount from a packed value
    /// @param packed The packed amount and decimals
    /// @return amount The amount
    function getAmount(uint256 packed) internal pure returns (uint64) {
        return uint64(packed & MAX_AMOUNT);
    }

    /// @notice Get the decimals from a packed value
    /// @param packed The packed amount and decimals
    /// @return decimals The decimals
    function getDecimals(uint256 packed) internal pure returns (uint8) {
        return uint8(packed >> 64);
    }
}

/// @notice A struct representing a trimmed amount with decimals
/// @dev This struct is used to represent amounts that have been trimmed
///      to remove unnecessary precision while preserving decimal information
struct TrimmedAmount {
    uint256 packed;
}

/// @notice Pack a TrimmedAmount from amount and decimals
/// @param amount The amount
/// @param decimals The number of decimals
/// @return trimmed The packed TrimmedAmount
function packTrimmedAmount(uint64 amount, uint8 decimals) pure returns (TrimmedAmount memory trimmed) {
    trimmed.packed = TrimmedAmountLib.packTrimmedAmount(amount, decimals);
}

/// @notice Unpack a TrimmedAmount into amount and decimals
/// @param trimmed The TrimmedAmount to unpack
/// @return amount The amount
/// @return decimals The number of decimals
function unpackTrimmedAmount(TrimmedAmount memory trimmed) pure returns (uint64 amount, uint8 decimals) {
    (amount, decimals) = TrimmedAmountLib.unpackTrimmedAmount(trimmed.packed);
}

/// @notice Get the amount from a TrimmedAmount
/// @param trimmed The TrimmedAmount
/// @return amount The amount
function getAmount(TrimmedAmount memory trimmed) pure returns (uint64 amount) {
    amount = TrimmedAmountLib.getAmount(trimmed.packed);
}

/// @notice Get the decimals from a TrimmedAmount
/// @param trimmed The TrimmedAmount
/// @return decimals The number of decimals
function getDecimals(TrimmedAmount memory trimmed) pure returns (uint8 decimals) {
    decimals = TrimmedAmountLib.getDecimals(trimmed.packed);
}
