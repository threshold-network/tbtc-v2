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

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "./MintBurnGuardState.sol";
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
///      This contract uses the upgradeable proxy pattern with storage
///      separation via MintBurnGuardState library.
contract MintBurnGuard is Initializable, OwnableUpgradeable, IMintBurnGuard {
    using SafeERC20Upgradeable for IERC20Upgradeable;
    using MintBurnGuardState for MintBurnGuardState.Storage;

    uint256 private constant TBTC_BASE_UNITS_PER_SAT = 1e10;

    MintBurnGuardState.Storage internal self;

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
    error MintRateLimitExceeded(uint256 windowTotal, uint256 limit);
    error Underflow();
    error AmountConversionOverflow(uint256 amountSats);

    modifier onlyOperator() {
        if (msg.sender != self.operator) {
            revert NotOperator(msg.sender);
        }
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes the contract with the initial owner, operator, and vault.
    /// @param initialOwner Address that will become the contract owner.
    /// @param initialOperator Optional operator address; can be zero and
    ///        set later via `setOperator`.
    /// @param initialVault Optional vault contract; can be zero and
    ///        set later via `setVault`.
    function initialize(
        address initialOwner,
        address initialOperator,
        ITBTCVault initialVault
    ) external initializer {
        __Ownable_init();

        if (initialOwner == address(0)) {
            revert MintBurnGuardState.ZeroAddress("owner");
        }
        _transferOwnership(initialOwner);

        if (initialOperator != address(0)) {
            self.setOperator(initialOperator);
        }
        if (address(initialVault) != address(0)) {
            self.setVault(initialVault);
        }
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

        if (address(self.vault) == address(0)) {
            revert MintBurnGuardState.ZeroAddress("vault");
        }

        uint256 newTotal = _increaseTotalMintedInternal(amount);

        emit BankMintExecuted(self.operator, recipient, amount, newTotal);

        IBridgeController(self.bridge).controllerIncreaseBalance(
            recipient,
            amount
        );
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
            revert MintBurnGuardState.ZeroAddress("from");
        }

        if (address(self.vault) == address(0)) {
            revert MintBurnGuardState.ZeroAddress("vault");
        }

        // Step 1: Reduce global exposure
        uint256 newTotal = _decreaseTotalMintedInternal(amount);

        emit UnmintAndBurnExecuted(self.operator, from, amount, newTotal);

        // Step 2: Transfer TBTC from user to this guard
        // User must have approved TBTC to this guard
        uint256 tbtcBaseUnits = _toTbtcBaseUnits(amount);
        IERC20Upgradeable(self.tbtcToken).safeTransferFrom(
            from,
            address(this),
            tbtcBaseUnits
        );

        // Step 3: Approve vault to spend guard's TBTC
        IERC20Upgradeable(self.tbtcToken).safeIncreaseAllowance(
            address(self.vault),
            tbtcBaseUnits
        );

        // Step 4: Unmint via Vault (guard is now the unminter)
        // This burns guard's TBTC and gives guard Bank balance
        self.vault.unmint(tbtcBaseUnits);

        // Step 5: Burn the guard's Bank balance
        IBank(self.bank).decreaseBalance(amount);
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
            revert MintBurnGuardState.ZeroAddress("from");
        }

        // Step 1: Reduce global exposure
        uint256 newTotal = _decreaseTotalMintedInternal(amount);

        emit BurnExecuted(self.operator, from, amount, newTotal);

        // Step 2: Transfer Bank balance from user to this guard
        // User must have approved Bank balance to this guard
        IBank(self.bank).transferBalanceFrom(from, address(this), amount);

        // Step 3: Burn the guard's Bank balance
        IBank(self.bank).decreaseBalance(amount);
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
        if (self.mintingPaused) {
            revert MintingPausedError();
        }

        _enforceMintRateLimit(amount);

        newTotal = self.totalMinted + amount;

        uint256 cap = self.globalMintCap;
        if (cap != 0 && newTotal > cap) {
            revert MintBurnGuardState.GlobalMintCapExceeded(newTotal, cap);
        }

        self.totalMinted = newTotal;
        emit MintBurnGuardState.TotalMintedIncreased(amount, newTotal);
    }

    /// @notice Internal helper decreasing `totalMinted` with underflow protection.
    function _decreaseTotalMintedInternal(uint256 amount)
        private
        returns (uint256 newTotal)
    {
        uint256 current = self.totalMinted;
        if (amount > current) {
            revert Underflow();
        }

        unchecked {
            newTotal = current - amount;
        }

        self.totalMinted = newTotal;
        emit MintBurnGuardState.TotalMintedDecreased(amount, newTotal);
    }

    /* solhint-disable not-rely-on-time */
    function _enforceMintRateLimit(uint256 amount) private {
        uint256 limit = self.mintRateLimit;
        uint256 window = self.mintRateLimitWindow;
        if (limit == 0 || window == 0) {
            return;
        }

        uint256 currentTimestamp = block.timestamp;
        uint256 windowStart = self.mintRateWindowStart;

        if (currentTimestamp >= windowStart + window) {
            if (amount > limit) {
                revert MintRateLimitExceeded(amount, limit);
            }
            self.mintRateWindowStart = currentTimestamp;
            self.mintRateWindowAmount = amount;
            return;
        }

        uint256 nextWindowAmount = self.mintRateWindowAmount + amount;
        if (nextWindowAmount > limit) {
            revert MintRateLimitExceeded(nextWindowAmount, limit);
        }

        self.mintRateWindowAmount = nextWindowAmount;
    }

    /// @notice Updates the operator address.
    /// @param newOperator Address of the new operator contract.
    /// @dev Can only be called by the owner.
    function setOperator(address newOperator) external onlyOwner {
        self.setOperator(newOperator);
    }

    /// @notice Updates the Vault contract used for unmint helpers.
    /// @param newVault Vault contract used for unminting TBTC.
    /// @dev Can only be called by the owner.
    function setVault(ITBTCVault newVault) external onlyOwner {
        self.setVault(newVault);
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
        return self.setTotalMinted(newTotal);
    }

    /// @notice Updates the global mint cap.
    /// @param newCap New global mint cap in TBTC satoshis (1e8); zero disables.
    /// @dev Can only be called by the owner. When enabled, keep `newCap` at or
    ///      above current `totalMinted` and any active `mintRateLimit` to avoid
    ///      unintended mint reverts. Tightening after pausing is safest.
    function setGlobalMintCap(uint256 newCap) external onlyOwner {
        self.setGlobalMintCap(newCap);
    }

    /// @notice Updates the global minting pause flag.
    /// @param paused New pause state.
    /// @dev Can only be called by the owner.
    function setMintingPaused(bool paused) external onlyOwner {
        self.setMintingPaused(paused);
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
        self.setMintRateLimit(limit, windowSeconds);
    }

    // Public view functions to expose storage for backward compatibility
    function operator() public view returns (address) {
        return self.operator;
    }

    function totalMinted() public view returns (uint256) {
        return self.totalMinted;
    }

    function globalMintCap() public view returns (uint256) {
        return self.globalMintCap;
    }

    function mintingPaused() public view returns (bool) {
        return self.mintingPaused;
    }

    function vault() public view returns (ITBTCVault) {
        return self.vault;
    }

    function bridge() public view returns (address) {
        return self.bridge;
    }

    function bank() public view returns (address) {
        return self.bank;
    }

    function tbtcToken() public view returns (address) {
        return self.tbtcToken;
    }

    function mintRateLimit() public view returns (uint256) {
        return self.mintRateLimit;
    }

    function mintRateLimitWindow() public view returns (uint256) {
        return self.mintRateLimitWindow;
    }

    function mintRateWindowStart() public view returns (uint256) {
        return self.mintRateWindowStart;
    }

    function mintRateWindowAmount() public view returns (uint256) {
        return self.mintRateWindowAmount;
    }
}
