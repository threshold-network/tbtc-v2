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

import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IBridgeController.sol";
import "./interfaces/IMintBurnGuard.sol";
import "../integrator/ITBTCVault.sol";

/// @dev Minimal Bank-like interface exposing only the burn primitive needed
///      by MintBurnGuard.
interface IBankLike {
    function decreaseBalance(uint256 amount) external;
}

/// @title Mint/Burn Guard
/// @notice Tracks global net-minted exposure for an operator and enforces
///         system-level caps and pause semantics.
/// @dev This contract is intentionally minimal and oblivious to reserve-level
///      details. It is expected that a single operator contract (e.g.
///      AccountControl) reports all mint and burn operations via this guard.
contract MintBurnGuard is Ownable, IMintBurnGuard {
    uint256 private constant TBTC_BASE_UNITS_PER_SAT = 1e10;

    /// @notice Address of the operator allowed to adjust the total minted
    ///         exposure tracked by this guard and call execution helpers.
    address public operator;

    /// @notice Global net-minted amount reported by the operator.
    /// @dev Expressed in TBTC satoshis (1e8).
    uint256 public totalMinted;

    /// @notice Global mint cap enforced across all operator-managed lines.
    /// @dev Expressed in TBTC satoshis (1e8). A value of zero disables the
    ///      global cap check.
    uint256 public globalMintCap;

    /// @notice Global pause flag for operator-driven minting.
    /// @dev When true, `mintToBank` reverts for any amount > 0; burn/unmint
    ///      helpers remain available to reduce exposure.
    bool public mintingPaused;

    /// @notice Bridge contract used to mint TBTC into the Bank.
    IBridgeController public bridge;

    /// @notice Bank contract used for burning TBTC bank balances when needed.
    IBankLike public bank;

    /// @notice Vault contract used for unminting TBTC held in the vault.
    ITBTCVault public vault;

    /// @notice Maximum amount (in satoshis) that may be minted within a single
    ///         rate window.
    /// @dev A value of zero disables rate limiting entirely.
    uint256 public mintRateLimit;

    /// @notice Duration, in seconds, of the rate window governed by `mintRateLimit`.
    /// @dev This value must be non-zero when `mintRateLimit` is enabled.
    uint256 public mintRateLimitWindow;

    /// @notice Timestamp that marks the beginning of the current rate window.
    uint256 public mintRateWindowStart;

    /// @notice Amount minted so far during the current rate window (satoshis).
    uint256 public mintRateWindowAmount;

    event OperatorUpdated(
        address indexed previousOperator,
        address indexed newOperator
    );

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

    event BankMintExecuted(
        address indexed operator,
        address indexed recipient,
        uint256 amountSats,
        uint256 newTotalMinted
    );

    event BankBurnExecuted(
        address indexed operator,
        address indexed from,
        uint256 amountSats,
        uint256 newTotalMinted
    );

    event VaultUnmintExecuted(
        address indexed operator,
        uint256 amountSats,
        uint256 newTotalMinted
    );

    error NotOperator(address caller);
    error MintingPausedError();
    error ZeroAddress(string field);
    error WindowMustNotBeZero();
    error GlobalMintCapExceeded(uint256 newTotal, uint256 cap);
    error MintRateLimitExceeded(uint256 windowTotal, uint256 limit);
    error CapBelowRateLimit(uint256 cap, uint256 rateLimit);
    error Underflow();
    error AmountConversionOverflow(uint256 amountSats);

    modifier onlyOperator() {
        if (msg.sender != operator) {
            revert NotOperator(msg.sender);
        }
        _;
    }

    /// @notice Sets the initial owner and, optionally, the operator.
    /// @param initialOwner Address that will become the contract owner.
    /// @param initialOperator Optional operator address; can be zero and
    ///        set later via `setOperator`.
    constructor(address initialOwner, address initialOperator) {
        if (initialOwner == address(0)) {
            revert ZeroAddress("owner");
        }
        _transferOwnership(initialOwner);

        if (initialOperator != address(0)) {
            operator = initialOperator;
            emit OperatorUpdated(address(0), initialOperator);
        }
    }

    /// @notice Updates the operator address.
    /// @param newOperator Address of the new operator contract.
    /// @dev Can only be called by the owner.
    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) {
            revert ZeroAddress("operator");
        }
        address previous = operator;
        operator = newOperator;
        emit OperatorUpdated(previous, newOperator);
    }

    /// @notice Configures the Bridge contract used for execution helpers.
    /// @param bridge_ Bridge contract used for controller-based minting.
    function setBridge(IBridgeController bridge_) external onlyOwner {
        _setBridge(bridge_);
    }

    /// @notice Configures the Bank contract used for burn helpers.
    /// @param bank_ Bank contract used for burning TBTC bank balances.
    function setBank(IBankLike bank_) external onlyOwner {
        _setBank(bank_);
    }

    /// @notice Configures the Vault contract used for unmint helpers.
    /// @param vault_ Vault contract used for unminting TBTC.
    function setVault(ITBTCVault vault_) external onlyOwner {
        _setVault(vault_);
    }

    /// @notice Atomically wires Bridge, Bank, and Vault addresses.
    /// @dev Prevents partial deployments that forget to configure one of the
    ///      execution targets when enabling mint/burn helpers.
    function configureExecutionTargets(
        IBridgeController bridge_,
        IBankLike bank_,
        ITBTCVault vault_
    ) external onlyOwner {
        _setBridge(bridge_);
        _setBank(bank_);
        _setVault(vault_);
    }

    function _setBridge(IBridgeController bridge_) private {
        if (address(bridge_) == address(0)) {
            revert ZeroAddress("bridge");
        }
        bridge = bridge_;
    }

    function _setBank(IBankLike bank_) private {
        if (address(bank_) == address(0)) {
            revert ZeroAddress("bank");
        }
        bank = bank_;
    }

    function _setVault(ITBTCVault vault_) private {
        if (address(vault_) == address(0)) {
            revert ZeroAddress("vault");
        }
        vault = vault_;
    }

    /// @notice Owner-only helper to set global net-minted exposure for
    ///         migrations or accounting corrections.
    /// @param newTotal New total minted amount in TBTC satoshis (1e8).
    /// @return The updated total minted amount in TBTC satoshis (1e8).
    function setTotalMinted(uint256 newTotal)
        external
        onlyOwner
        returns (uint256)
    {
        uint256 cap = globalMintCap;
        if (cap != 0 && newTotal > cap) {
            revert GlobalMintCapExceeded(newTotal, cap);
        }

        uint256 current = totalMinted;
        if (newTotal == current) {
            return current;
        }

        totalMinted = newTotal;
        // Reset rate window to avoid stale in-flight counters after manual override.
        mintRateWindowStart = 0;
        mintRateWindowAmount = 0;

        if (newTotal > current) {
            emit TotalMintedIncreased(newTotal - current, newTotal);
        } else {
            emit TotalMintedDecreased(current - newTotal, newTotal);
        }

        return newTotal;
    }

    /// @notice Mints TBTC to the Bank via the Bridge and updates global exposure.
    /// @param recipient Address receiving the TBTC bank balance.
    /// @param amount Amount in TBTC satoshis (1e8) to add to exposure.
    /// @dev Can only be called by the configured operator.
    // slither-disable-next-line reentrancy-vulnerabilities-3 reentrancy-vulnerabilities-2
    function mintToBank(address recipient, uint256 amount)
        external
        onlyOperator
    {
        if (amount == 0) {
            return;
        }

        if (address(bridge) == address(0)) {
            revert ZeroAddress("bridge");
        }

        uint256 newTotal = _increaseTotalMintedInternal(amount);

        emit BankMintExecuted(operator, recipient, amount, newTotal);
        bridge.controllerIncreaseBalance(recipient, _toTbtcBaseUnits(amount));
    }

    /// @notice Burns TBTC bank balance and reduces global exposure.
    /// @param from Source address for which the burn semantics are tracked.
    /// @param amount Amount in TBTC satoshis (1e8) to burn from the Bank.
    /// @dev Burns the guard contract's own Bank balance via `decreaseBalance`;
    ///      reverts if the guard lacks balance. `from` is emitted for
    ///      monitoring only and does not affect which balance is burned.
    function burnFromBank(address from, uint256 amount) external onlyOperator {
        if (amount == 0) {
            return;
        }

        if (address(bank) == address(0)) {
            revert ZeroAddress("bank");
        }

        uint256 newTotal = _decreaseTotalMintedInternal(amount);

        emit BankBurnExecuted(operator, from, amount, newTotal);
        bank.decreaseBalance(_toTbtcBaseUnits(amount));
    }

    /// @notice Unmints TBTC via the configured vault and reduces global
    ///         exposure.
    /// @param amount Amount in TBTC satoshis (1e8) to unmint.
    /// @dev Burns TBTC held/approved to the guard via `vault.unmint`; reverts
    ///      if the guard lacks TBTC/allowance. Bank balance is returned to the
    ///      guard contract.
    function unmintFromVault(uint256 amount) external onlyOperator {
        if (amount == 0) {
            return;
        }

        if (address(vault) == address(0)) {
            revert ZeroAddress("vault");
        }

        uint256 newTotal = _decreaseTotalMintedInternal(amount);

        emit VaultUnmintExecuted(operator, amount, newTotal);
        vault.unmint(_toTbtcBaseUnits(amount));
    }

    /// @notice Converts a TBTC amount expressed in satoshis (1e8) to base units
    ///         (1e18) used by TBTC ERC20/Banks/Vaults.
    function _toTbtcBaseUnits(uint256 amountSats)
        private
        pure
        returns (uint256)
    {
        // Avoid overflow when converting large satoshi amounts to 1e18 units.
        if (amountSats > type(uint256).max / TBTC_BASE_UNITS_PER_SAT) {
            revert AmountConversionOverflow(amountSats);
        }
        return amountSats * TBTC_BASE_UNITS_PER_SAT;
    }

    /// @notice Internal helper increasing `totalMinted` with cap and pause checks.
    function _increaseTotalMintedInternal(uint256 amount)
        private
        returns (uint256 newTotal)
    {
        if (mintingPaused) {
            revert MintingPausedError();
        }

        _enforceMintRateLimit(amount);

        newTotal = totalMinted + amount;

        uint256 cap = globalMintCap;
        if (cap != 0 && newTotal > cap) {
            revert GlobalMintCapExceeded(newTotal, cap);
        }

        totalMinted = newTotal;
        emit TotalMintedIncreased(amount, newTotal);
    }

    /// @notice Internal helper decreasing `totalMinted` with underflow protection.
    function _decreaseTotalMintedInternal(uint256 amount)
        private
        returns (uint256 newTotal)
    {
        uint256 current = totalMinted;
        if (amount > current) {
            revert Underflow();
        }

        unchecked {
            newTotal = current - amount;
        }

        totalMinted = newTotal;
        emit TotalMintedDecreased(amount, newTotal);
    }

    /* solhint-disable not-rely-on-time */
    function _enforceMintRateLimit(uint256 amount) private {
        uint256 limit = mintRateLimit;
        uint256 window = mintRateLimitWindow;
        if (limit == 0 || window == 0) {
            return;
        }

        uint256 currentTimestamp = block.timestamp;
        uint256 windowStart = mintRateWindowStart;

        if (currentTimestamp >= windowStart + window) {
            if (amount > limit) {
                revert MintRateLimitExceeded(amount, limit);
            }
            mintRateWindowStart = currentTimestamp;
            mintRateWindowAmount = amount;
            return;
        }

        uint256 nextWindowAmount = mintRateWindowAmount + amount;
        if (nextWindowAmount > limit) {
            revert MintRateLimitExceeded(nextWindowAmount, limit);
        }

        mintRateWindowAmount = nextWindowAmount;
    }

    /* solhint-enable not-rely-on-time */

    /// @notice Updates the global mint cap.
    /// @param newCap New global mint cap in TBTC satoshis (1e8); zero disables.
    /// @dev Can only be called by the owner. When enabled, keep `newCap` at or
    ///      above current `totalMinted` and any active `mintRateLimit` to avoid
    ///      unintended mint reverts. Tightening after pausing is safest.
    function setGlobalMintCap(uint256 newCap) external onlyOwner {
        if (mintRateLimit != 0 && newCap != 0 && newCap < mintRateLimit) {
            revert CapBelowRateLimit(newCap, mintRateLimit);
        }
        uint256 previousCap = globalMintCap;
        globalMintCap = newCap;
        emit GlobalMintCapUpdated(previousCap, newCap);
    }

    /// @notice Updates the global minting pause flag.
    /// @param paused New pause state.
    /// @dev Can only be called by the owner.
    function setMintingPaused(bool paused) external onlyOwner {
        if (mintingPaused == paused) {
            return;
        }
        mintingPaused = paused;
        emit MintingPaused(paused);
    }

    /// @notice Configures the mint rate limit parameters.
    /// @param limit Maximum TBTC satoshis (1e8) allowed per window; zero disables.
    /// @param windowSeconds Duration of the rate window in seconds.
    /// @dev When `limit` is non-zero, `windowSeconds` must also be non-zero and
    ///      `limit` must not exceed `globalMintCap` (when cap is set). Resets
    ///      the rate window; tighten limits after pausing to avoid mid-window
    ///      reverts.
    function setMintRateLimit(uint256 limit, uint256 windowSeconds)
        external
        onlyOwner
    {
        uint256 previousLimit = mintRateLimit;
        uint256 previousWindow = mintRateLimitWindow;

        if (limit == 0) {
            mintRateLimit = 0;
            mintRateLimitWindow = 0;
        } else {
            if (windowSeconds == 0) {
                revert WindowMustNotBeZero();
            }
            if (globalMintCap != 0 && globalMintCap < limit) {
                revert CapBelowRateLimit(globalMintCap, limit);
            }
            mintRateLimit = limit;
            mintRateLimitWindow = windowSeconds;
        }

        mintRateWindowStart = 0;
        mintRateWindowAmount = 0;

        emit MintRateLimitUpdated(
            previousLimit,
            previousWindow,
            mintRateLimit,
            mintRateLimitWindow
        );
    }
}
