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

import "../integrator/ITBTCVault.sol";

/// @title MintBurnGuard State
/// @notice Storage library for the MintBurnGuard contract following the
///         upgradeable proxy pattern.
/// @dev This library defines the storage layout for MintBurnGuard to enable
///      upgrades without storage conflicts. All state variables are contained
///      in a single Storage struct.
library MintBurnGuardState {
    struct Storage {
        /// @notice Address of the operator allowed to adjust the total minted
        ///         exposure tracked by this guard and call execution helpers.
        address operator;
        /// @notice Global net-minted amount reported by the operator.
        /// @dev Expressed in TBTC satoshis (1e8).
        uint256 totalMinted;
        /// @notice Global mint cap enforced across all operator-managed lines.
        /// @dev Expressed in TBTC satoshis (1e8). A value of zero disables the
        ///      global cap check.
        uint256 globalMintCap;
        /// @notice Global pause flag for operator-driven minting.
        /// @dev When true, `mintToBank` reverts for any amount > 0; burn/unmint
        ///      helpers remain available to reduce exposure.
        bool mintingPaused;
        /// @notice Vault contract used for unminting TBTC held in the vault.
        ITBTCVault vault;
        /// @notice TBTC Bridge contract cached from vault
        address bridge;
        /// @notice Bank contract cached from vault
        address bank;
        /// @notice TBTC token contract cached from vault
        address tbtcToken;
        /// @notice Maximum amount (in satoshis) that may be minted within a single
        ///         rate window.
        /// @dev A value of zero disables rate limiting entirely.
        uint256 mintRateLimit;
        /// @notice Duration, in seconds, of the rate window governed by `mintRateLimit`.
        /// @dev This value must be non-zero when `mintRateLimit` is enabled.
        uint256 mintRateLimitWindow;
        /// @notice Timestamp that marks the beginning of the current rate window.
        uint256 mintRateWindowStart;
        /// @notice Amount minted so far during the current rate window (satoshis).
        uint256 mintRateWindowAmount;
        /// @notice Reserved storage space to allow for layout changes in the future.
        /// @dev Following OpenZeppelin's upgradeable contract pattern, we reserve
        ///      50 storage slots for future additions without breaking storage layout.
        uint256[50] __gap;
    }

    event OperatorUpdated(
        address indexed previousOperator,
        address indexed newOperator
    );

    event VaultUpdated(address indexed previousVault, address indexed newVault);

    event TotalMintedIncreased(uint256 amount, uint256 newTotal);
    event TotalMintedDecreased(uint256 amount, uint256 newTotal);
    event GlobalMintCapUpdated(uint256 previousCap, uint256 newCap);
    event MintingPaused(bool paused);
    event MintRateLimitUpdated(
        uint256 previousLimit,
        uint256 previousWindow,
        uint256 newLimit,
        uint256 newWindow
    );

    error ZeroAddress(string field);
    error WindowMustNotBeZero();
    error GlobalMintCapExceeded(uint256 newTotal, uint256 cap);
    error CapBelowRateLimit(uint256 cap, uint256 rateLimit);

    /// @notice Updates the operator address.
    /// @param newOperator Address of the new operator contract.
    function setOperator(Storage storage self, address newOperator) internal {
        if (newOperator == address(0)) {
            revert ZeroAddress("operator");
        }
        address previous = self.operator;
        self.operator = newOperator;
        emit OperatorUpdated(previous, newOperator);
    }

    /// @notice Updates the Vault contract used for unmint helpers.
    /// @param newVault Vault contract used for unminting TBTC.
    function setVault(Storage storage self, ITBTCVault newVault) internal {
        if (address(newVault) == address(0)) {
            revert ZeroAddress("vault");
        }
        address previous = address(self.vault);
        self.vault = newVault;
        self.bridge = newVault.bridge();
        self.bank = newVault.bank();
        self.tbtcToken = newVault.tbtcToken();
        emit VaultUpdated(previous, address(newVault));
    }

    /// @notice Owner-only helper to set global net-minted exposure for
    ///         migrations or accounting corrections.
    /// @param newTotal New total minted amount in TBTC satoshis (1e8).
    /// @return The updated total minted amount in TBTC satoshis (1e8).
    function setTotalMinted(Storage storage self, uint256 newTotal)
        internal
        returns (uint256)
    {
        uint256 cap = self.globalMintCap;
        if (cap != 0 && newTotal > cap) {
            revert GlobalMintCapExceeded(newTotal, cap);
        }

        uint256 current = self.totalMinted;
        if (newTotal == current) {
            return current;
        }

        self.totalMinted = newTotal;
        // Reset rate window to avoid stale in-flight counters after manual override.
        self.mintRateWindowStart = 0;
        self.mintRateWindowAmount = 0;

        if (newTotal > current) {
            emit TotalMintedIncreased(newTotal - current, newTotal);
        } else {
            emit TotalMintedDecreased(current - newTotal, newTotal);
        }

        return newTotal;
    }

    /// @notice Updates the global mint cap.
    /// @param newCap New global mint cap in TBTC satoshis (1e8); zero disables.
    function setGlobalMintCap(Storage storage self, uint256 newCap) internal {
        if (
            self.mintRateLimit != 0 &&
            newCap != 0 &&
            newCap < self.mintRateLimit
        ) {
            revert CapBelowRateLimit(newCap, self.mintRateLimit);
        }
        uint256 previousCap = self.globalMintCap;
        self.globalMintCap = newCap;
        emit GlobalMintCapUpdated(previousCap, newCap);
    }

    /// @notice Updates the global minting pause flag.
    /// @param paused New pause state.
    function setMintingPaused(Storage storage self, bool paused) internal {
        if (self.mintingPaused == paused) {
            return;
        }
        self.mintingPaused = paused;
        emit MintingPaused(paused);
    }

    /// @notice Configures the mint rate limit parameters.
    /// @param limit Maximum TBTC satoshis (1e8) allowed per window; zero disables.
    /// @param windowSeconds Duration of the rate window in seconds.
    function setMintRateLimit(
        Storage storage self,
        uint256 limit,
        uint256 windowSeconds
    ) internal {
        uint256 previousLimit = self.mintRateLimit;
        uint256 previousWindow = self.mintRateLimitWindow;

        if (limit == 0) {
            self.mintRateLimit = 0;
            self.mintRateLimitWindow = 0;
        } else {
            if (windowSeconds == 0) {
                revert WindowMustNotBeZero();
            }
            if (self.globalMintCap != 0 && self.globalMintCap < limit) {
                revert CapBelowRateLimit(self.globalMintCap, limit);
            }
            self.mintRateLimit = limit;
            self.mintRateLimitWindow = windowSeconds;
        }

        self.mintRateWindowStart = 0;
        self.mintRateWindowAmount = 0;

        emit MintRateLimitUpdated(
            previousLimit,
            previousWindow,
            self.mintRateLimit,
            self.mintRateLimitWindow
        );
    }
}
