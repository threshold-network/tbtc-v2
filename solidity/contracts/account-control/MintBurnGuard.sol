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
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IBridgeController.sol";
import "./interfaces/IMintBurnGuard.sol";
import "../integrator/IBank.sol";
import "../integrator/ITBTCVault.sol";

/// @title Mint/Burn Guard
/// @notice Tracks global net-minted exposure for an operator and enforces
///         system-level caps and pause semantics.
/// @dev This contract is intentionally minimal and oblivious to reserve-level
///      details. It is expected that a single operator contract (e.g.
///      AccountControl) reports all mint and burn operations via this guard.
contract MintBurnGuard is Ownable, IMintBurnGuard {
    using SafeERC20 for IERC20;

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

    /// @notice Vault contract used for unminting TBTC held in the vault.
    ITBTCVault public vault;

    /// @notice Bank contract cached from vault
    address public bank;

    /// @notice TBTC token contract cached from vault
    address public tbtcToken;

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

    event BankMintExecuted(
        address indexed operator,
        address indexed recipient,
        uint256 amountSats,
        uint256 newTotalMinted
    );

    event UnmintAndBurnExecuted(
        address indexed operator,
        address indexed from,
        uint256 amountSats,
        uint256 newTotalMinted
    );

    event BurnExecuted(
        address indexed operator,
        address indexed from,
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

    /// @notice Sets the initial owner and, optionally, the operator and vault.
    /// @param initialOwner Address that will become the contract owner.
    /// @param initialOperator Optional operator address; can be zero and
    ///        set later via `setOperator`.
    /// @param initialVault Initial Optional vault contract; can be zero and
    ///        set later via `setVault`.
    constructor(
        address initialOwner,
        address initialOperator,
        ITBTCVault initialVault
    ) {
        if (initialOwner == address(0)) {
            revert ZeroAddress("owner");
        }
        _transferOwnership(initialOwner);

        if (initialOperator != address(0)) {
            operator = initialOperator;
        }
        if (address(initialVault) != address(0)) {
            vault = initialVault;
            bank = initialVault.bank();
            tbtcToken = initialVault.tbtcToken();
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

    /// @notice Updates the Vault contract used for unmint helpers.
    /// @param newVault Vault contract used for unminting TBTC.
    /// @dev Can only be called by the owner.
    function setVault(ITBTCVault newVault) external onlyOwner {
        if (address(newVault) == address(0)) {
            revert ZeroAddress("vault");
        }
        address previous = address(vault);
        vault = newVault;
        bank = newVault.bank();
        tbtcToken = newVault.tbtcToken();
        emit VaultUpdated(previous, address(newVault));
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

        if (address(vault) == address(0)) {
            revert ZeroAddress("vault");
        }

        uint256 newTotal = _increaseTotalMintedInternal(amount);

        emit BankMintExecuted(operator, recipient, amount, newTotal);

        IBridgeController bridge = IBridgeController(vault.bridge());
        bridge.controllerIncreaseBalance(recipient, _toTbtcBaseUnits(amount));
    }

    /// @notice Unmints TBTC from a user by first unminting via Vault, then
    ///         transferring and burning the Bank balance atomically.
    /// @param from User whose TBTC will be unminted (must have approved TBTC to guard).
    /// @param amount Amount in TBTC satoshis (1e8) to unmint and burn.
    /// @dev This is an atomic operation that ensures:
    ///      1. Guard receives TBTC from user
    ///      2. Guard approves Vault to spend TBTC
    ///      3. Vault unmints TBTC from guard
    ///      4. Guard receives Bank balance from vault
    ///      5. Guard burns its Bank balance
    ///      6. Global exposure is reduced
    ///
    ///      Flow:
    ///      - User approves TBTC tokens to the Guard
    ///      - Operator calls this function which:
    ///        a) Transfers TBTC from user to guard
    ///        b) Approves vault to spend guard's TBTC
    ///        c) Unmints via vault --> guard gets Bank balance
    ///        d) Burns the Bank balance
    ///        e) Reduces global exposure
    ///
    ///      Prerequisites:
    ///      - User must have TBTC token allowance approved to this guard
    ///
    ///      This guarantees accounting consistency for redemptions.
    // slither-disable-next-line arbitrary-send-erc20
    function unmintAndBurnFrom(address from, uint256 amount)
        external
        onlyOperator
    {
        if (amount == 0) {
            return;
        }

        if (from == address(0)) {
            revert ZeroAddress("from");
        }

        if (address(vault) == address(0)) {
            revert ZeroAddress("vault");
        }

        // Step 1: Reduce global exposure
        uint256 newTotal = _decreaseTotalMintedInternal(amount);

        emit UnmintAndBurnExecuted(operator, from, amount, newTotal);

        // Step 2: Transfer TBTC from user to this guard
        // User must have approved TBTC to this guard
        uint256 tbtcBaseUnits = _toTbtcBaseUnits(amount);
        IERC20(tbtcToken).safeTransferFrom(from, address(this), tbtcBaseUnits);

        // Step 3: Approve vault to spend guard's TBTC
        IERC20(tbtcToken).safeApprove(address(vault), tbtcBaseUnits);

        // Step 4: Unmint via Vault (guard is now the unminter)
        // This burns guard's TBTC and gives guard Bank balance
        vault.unmint(tbtcBaseUnits);

        // Step 5: Burn the guard's Bank balance
        IBank(bank).decreaseBalance(tbtcBaseUnits);
    }

    /// @notice Burns Bank balance from a user and reduces global exposure.
    /// @param from User whose Bank balance will be burned (must have approved Bank balance to guard).
    /// @param amount Amount in TBTC satoshis (1e8) to burn from Bank.
    /// @dev This function assumes the user has already handled their TBTC tokens
    ///      (e.g., unminted via vault) and now only needs to burn the Bank balance.
    ///
    ///      Flow:
    ///      1. User unmints TBTC via vault.unmint() --> gets Bank balance
    ///      2. User approves Bank balance to this guard
    ///      3. Operator calls this function which:
    ///         a) Transfers Bank balance from user to guard
    ///         b) Burns the guard's Bank balance
    ///         c) Reduces global exposure
    ///
    ///      Prerequisites:
    ///      - User must have Bank balance allowance approved to this guard
    ///
    ///      This is used when users handle TBTC token operations themselves
    ///      and only need the guard to burn Bank balance and track exposure.
    function burnFrom(address from, uint256 amount) external onlyOperator {
        if (amount == 0) {
            return;
        }

        if (from == address(0)) {
            revert ZeroAddress("from");
        }

        // Step 1: Reduce global exposure
        uint256 newTotal = _decreaseTotalMintedInternal(amount);

        emit BurnExecuted(operator, from, amount, newTotal);

        // Step 2: Transfer Bank balance from user to this guard
        // User must have approved Bank balance to this guard
        IBank(bank).transferBalanceFrom(from, address(this), amount);

        // Step 3: Burn the guard's Bank balance
        uint256 tbtcBaseUnits = _toTbtcBaseUnits(amount);
        IBank(bank).decreaseBalance(tbtcBaseUnits);
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
