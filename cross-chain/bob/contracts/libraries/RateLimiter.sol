// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Library for rate limiting functionality
library RateLimiter {
    /// @notice Configuration for rate limiting
    struct Config {
        uint128 rate; // Tokens per second
        uint128 capacity; // Maximum tokens
        bool isEnabled; // Whether rate limiting is enabled
    }

    /// @notice Token bucket for rate limiting
    struct TokenBucket {
        uint128 rate; // Tokens per second
        uint128 capacity; // Maximum tokens
        uint128 tokens; // Current tokens
        uint32 lastUpdated; // Last update timestamp
        bool isEnabled; // Whether rate limiting is enabled
    }

    /// @notice Validates token bucket configuration
    /// @param config The configuration to validate
    /// @param isEnabled Whether rate limiting should be enabled
    function _validateTokenBucketConfig(
        Config memory config,
        bool isEnabled
    ) internal pure {
        if (isEnabled && !config.isEnabled) {
            revert("Rate limiting must be enabled");
        }
        if (config.rate == 0) {
            revert("Rate must be greater than 0");
        }
        if (config.capacity == 0) {
            revert("Capacity must be greater than 0");
        }
    }

    /// @notice Consumes tokens from the bucket
    /// @param bucket The token bucket
    /// @param amount The amount to consume
    function _consume(
        TokenBucket storage bucket,
        uint256 amount,
        address /* token */
    ) internal {
        if (!bucket.isEnabled) {
            return;
        }

        _updateTokens(bucket);

        if (bucket.tokens < amount) {
            revert("Rate limit exceeded");
        }

        bucket.tokens -= uint128(amount);
    }

    /// @notice Updates the token count based on time elapsed
    /// @param bucket The token bucket to update
    function _updateTokens(TokenBucket storage bucket) internal {
        uint32 now_ = uint32(block.timestamp); // solhint-disable-line not-rely-on-time
        uint32 timeElapsed = now_ - bucket.lastUpdated;

        if (timeElapsed > 0) {
            uint256 newTokens = uint256(bucket.rate) * timeElapsed;
            uint256 totalTokens = uint256(bucket.tokens) + newTokens;

            if (totalTokens > bucket.capacity) {
                bucket.tokens = bucket.capacity;
            } else {
                bucket.tokens = uint128(totalTokens);
            }

            bucket.lastUpdated = now_;
        }
    }

    /// @notice Sets the token bucket configuration
    /// @param bucket The token bucket to configure
    /// @param config The new configuration
    function _setTokenBucketConfig(
        TokenBucket storage bucket,
        Config memory config
    ) internal {
        _validateTokenBucketConfig(config, true);

        bucket.rate = config.rate;
        bucket.capacity = config.capacity;
        bucket.isEnabled = config.isEnabled;
        bucket.lastUpdated = uint32(block.timestamp); // solhint-disable-line not-rely-on-time
        bucket.tokens = config.capacity; // Start with full capacity
    }

    /// @notice Gets the current state of the token bucket
    /// @param bucket The token bucket
    /// @return The current token bucket state
    function _currentTokenBucketState(
        TokenBucket storage bucket
    ) internal view returns (TokenBucket memory) {
        TokenBucket memory currentBucket = bucket;
        _updateTokensView(currentBucket);
        return currentBucket;
    }

    /// @notice Updates the token count for view functions
    /// @param bucket The token bucket to update (memory copy)
    function _updateTokensView(TokenBucket memory bucket) internal view {
        uint32 now_ = uint32(block.timestamp); // solhint-disable-line not-rely-on-time
        uint32 timeElapsed = now_ - bucket.lastUpdated;

        if (timeElapsed > 0) {
            uint256 newTokens = uint256(bucket.rate) * timeElapsed;
            uint256 totalTokens = uint256(bucket.tokens) + newTokens;

            if (totalTokens > bucket.capacity) {
                bucket.tokens = bucket.capacity;
            } else {
                bucket.tokens = uint128(totalTokens);
            }

            bucket.lastUpdated = now_;
        }
    }
}
