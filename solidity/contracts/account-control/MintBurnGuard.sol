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
import "./interfaces/IBridgeMintingAuthorization.sol";
import "./interfaces/IMintBurnGuard.sol";
import "../integrator/ITBTCVault.sol";

/// @dev Minimal Bank-like interface exposing only the burn primitive needed
///      by MintBurnGuard.
interface IBankLike {
    function decreaseBalance(uint256 amount) external;
}

/// @title Mint/Burn Guard
/// @notice Tracks global net-minted exposure for a controller and enforces
///         system-level caps and pause semantics.
/// @dev This contract is intentionally minimal and oblivious to reserve-level
///      details. It is expected that a single controller contract (e.g.
///      AccountControl) reports all mint and burn operations via this guard.
/// @notice Unit conventions:
///         - All amounts, caps, and totals use TBTC base units (1e18).
contract MintBurnGuard is Ownable, IMintBurnGuard {
    /// @notice Address of the controller allowed to adjust the total minted
    ///         exposure tracked by this guard and call execution helpers.
    address public controller;

    /// @notice Global net-minted amount reported by the controller.
    /// @dev Expressed in TBTC base units (1e18).
    uint256 public totalMintedTbtc;

    /// @notice Global mint cap enforced across all controller-managed lines.
    /// @dev A value of zero disables the global cap check.
    uint256 public globalMintCapTbtc;

    /// @notice Global pause flag for controller-driven minting.
    /// @dev When set to true, mint-side helpers revert for any amount > 0.
    bool public mintingPaused;

    /// @notice Bridge contract used to mint TBTC into the Bank.
    IBridgeMintingAuthorization public bridge; 

    /// @notice Bank contract used for burning TBTC bank balances when needed.
    IBankLike public bank;

    /// @notice Vault contract used for unminting TBTC held in the vault.
    ITBTCVault public vault;

    /// @notice Maximum amount that may be minted within a single rate window.
    /// @dev A value of zero disables rate limiting entirely.
    uint256 public mintRateLimitTbtc;

    /// @notice Duration, in seconds, of the rate window governed by `mintRateLimitTbtc`.
    /// @dev This value must be non-zero when `mintRateLimitTbtc` is enabled.
    uint256 public mintRateLimitWindowSeconds;

    /// @notice Timestamp (seconds) that marks the beginning of the current rate window.
    uint256 public mintRateWindowStartTimestamp;

    /// @notice Amount minted so far during the current rate window (1e18).
    uint256 public mintRateWindowAmountTbtc;

    event ControllerUpdated(
        address indexed previousController,
        address indexed newController
    );

    event TotalMintedIncreased(uint256 amountTbtc, uint256 newTotalMintedTbtc);
    event TotalMintedDecreased(uint256 amountTbtc, uint256 newTotalMintedTbtc);
    event TotalMintedSet(
        uint256 previousTotalMintedTbtc,
        uint256 newTotalMintedTbtc
    );
    event GlobalMintCapUpdated(uint256 previousCapTbtc, uint256 newCapTbtc);
    event MintingPaused(bool paused);
    event MintRateLimitUpdated(
        uint256 previousLimitTbtc,
        uint256 previousWindowSeconds,
        uint256 newLimitTbtc,
        uint256 newWindowSeconds
    );

    event BankMintExecuted(
        address indexed controller,
        address indexed recipient,
        uint256 amountTbtc,
        uint256 newTotalMintedTbtc
    );

    event BankBurnExecuted(
        address indexed controller,
        address indexed from,
        uint256 amountTbtc,
        uint256 newTotalMintedTbtc
    );

    event VaultUnmintExecuted(
        address indexed controller,
        uint256 amountTbtc,
        uint256 newTotalMintedTbtc
    );

    event ExposureReduced(
        address indexed controller,
        address indexed from,
        uint256 amountTbtc,
        uint256 newTotalMintedTbtc
    );

    error NotController(address caller);
    error MintingPausedError();
    error GlobalMintCapExceeded(uint256 newTotalTbtc, uint256 capTbtc);
    error MintRateLimitExceeded(uint256 windowTotalTbtc, uint256 limitTbtc);

    modifier onlyController() {
        if (msg.sender != controller) {
            revert NotController(msg.sender);
        }
        _;
    }

    /// @notice Sets the initial owner, controller, and accounting state.
    /// @param initialOwner Address that will become the contract owner.
    /// @param initialController Optional controller address; can be zero and
    ///        set later via `setController`.
    /// @param initialTotalMintedTbtc Initial net-minted exposure to seed.
    /// @param initialGlobalMintCapTbtc Initial global mint cap; zero disables the cap.
    constructor(
        address initialOwner,
        address initialController,
        uint256 initialTotalMintedTbtc,
        uint256 initialGlobalMintCapTbtc
    ) {
        require(initialOwner != address(0), "Owner must not be 0x0");
        _transferOwnership(initialOwner);

        if (
            initialGlobalMintCapTbtc != 0 &&
            initialTotalMintedTbtc > initialGlobalMintCapTbtc
        ) {
            revert GlobalMintCapExceeded(
                initialTotalMintedTbtc,
                initialGlobalMintCapTbtc
            );
        }

        globalMintCapTbtc = initialGlobalMintCapTbtc;
        totalMintedTbtc = initialTotalMintedTbtc;

        if (initialGlobalMintCapTbtc != 0) {
            emit GlobalMintCapUpdated(0, initialGlobalMintCapTbtc);
        }

        if (initialTotalMintedTbtc != 0) {
            emit TotalMintedSet(0, initialTotalMintedTbtc);
        }

        if (initialController != address(0)) {
            controller = initialController;
            emit ControllerUpdated(address(0), initialController);
        }
    }

    /// @notice Updates the controller address.
    /// @param newController Address of the new controller contract.
    /// @dev Can only be called by the owner.
    function setController(address newController) external onlyOwner {
        require(newController != address(0), "Controller must not be 0x0");
        address previous = controller;
        controller = newController;
        emit ControllerUpdated(previous, newController);
    }

    /// @notice Configures the Bridge contract used for execution helpers.
    /// @param bridge_ Bridge contract used for controller-based minting.
    function setBridge(IBridgeMintingAuthorization bridge_) external onlyOwner {
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
        IBridgeMintingAuthorization bridge_,
        IBankLike bank_,
        ITBTCVault vault_
    ) external onlyOwner {
        _setBridge(bridge_);
        _setBank(bank_);
        _setVault(vault_);
    }

    function _setBridge(IBridgeMintingAuthorization bridge_) private {
        require(address(bridge_) != address(0), "Bridge must not be 0x0");
        bridge = bridge_;
    }

    function _setBank(IBankLike bank_) private {
        require(address(bank_) != address(0), "Bank must not be 0x0");
        bank = bank_;
    }

    function _setVault(ITBTCVault vault_) private {
        require(address(vault_) != address(0), "Vault must not be 0x0");
        vault = vault_;
    }

    /// @notice Increases the global net-minted exposure.
    /// @param amountTbtc Amount to add to the total minted exposure (1e18).
    /// @return newTotalTbtc The updated total minted amount (1e18).
    /// @dev Can only be called by the configured controller.
    function increaseTotalMinted(uint256 amountTbtc)
        external
        onlyController
        returns (uint256 newTotalTbtc)
    {
        if (amountTbtc == 0) {
            return totalMintedTbtc;
        }

        newTotalTbtc = _increaseTotalMintedInternal(amountTbtc);
    }

    /// @notice Decreases the global net-minted exposure.
    /// @param amountTbtc Amount to subtract from the total minted exposure (1e18).
    /// @return newTotalTbtc The updated total minted amount (1e18).
    /// @dev Can only be called by the configured controller.
    function decreaseTotalMinted(uint256 amountTbtc)
        external
        onlyController
        returns (uint256 newTotalTbtc)
    {
        if (amountTbtc == 0) {
            return totalMintedTbtc;
        }

        newTotalTbtc = _decreaseTotalMintedInternal(amountTbtc);
    }

    /// @notice Mints TBTC to the Bank via the Bridge and updates global exposure.
    /// @param recipient Address receiving the TBTC bank balance.
    /// @param amountTbtc Amount in TBTC base units (1e18) to add to exposure.
    /// @dev Can only be called by the configured controller.
    // slither-disable-next-line reentrancy-vulnerabilities-3 reentrancy-vulnerabilities-2
    function mintToBank(address recipient, uint256 amountTbtc)
        external
        onlyController
    {
        if (amountTbtc == 0) {
            return;
        }

        require(address(bridge) != address(0), "MintBurnGuard: bridge not set");

        uint256 newTotalTbtc = _increaseTotalMintedInternal(amountTbtc);

        emit BankMintExecuted(controller, recipient, amountTbtc, newTotalTbtc);
        bridge.controllerIncreaseBalance(recipient, amountTbtc);
    }

    /// @notice Reduces exposure and burns TBTC via Bank/Vault as appropriate.
    /// @param from Source address for burns that operate on balances.
    /// @param amountTbtc Amount in TBTC base units (1e18) to reduce from exposure.
    /// @dev The controller is responsible for choosing the correct `from`
    ///      semantics per flow. This helper only coordinates accounting and
    ///      emits an accounting event; any concrete Bank/Vault calls must be
    ///      executed by the controller or by dedicated helpers before or after
    ///      calling into this function.
    function reduceExposureAndBurn(address from, uint256 amountTbtc)
        external
        onlyController
    {
        if (amountTbtc == 0) {
            return;
        }

        uint256 newTotalTbtc = _decreaseTotalMintedInternal(amountTbtc);

        emit ExposureReduced(controller, from, amountTbtc, newTotalTbtc);
    }

    /// @notice Burns TBTC bank balance and reduces global exposure.
    /// @param from Source address for which the burn semantics are tracked.
    /// @param amountTbtc Amount in TBTC base units (1e18) to burn from the Bank.
    /// @dev This helper assumes that the Bank exposes a `decreaseBalance`
    ///      primitive that burns the caller's bank balance. The `from` address
    ///      is emitted for monitoring purposes; it is up to higher-level
    ///      logic to ensure that balances are held in an account that can be
    ///      safely burned by this helper.
    function burnFromBank(address from, uint256 amountTbtc)
        external
        onlyController
    {
        if (amountTbtc == 0) {
            return;
        }

        require(address(bank) != address(0), "MintBurnGuard: bank not set");

        uint256 newTotalTbtc = _decreaseTotalMintedInternal(amountTbtc);

        emit BankBurnExecuted(controller, from, amountTbtc, newTotalTbtc);
        bank.decreaseBalance(amountTbtc);
    }

    /// @notice Unmints TBTC via the configured vault and reduces global
    ///         exposure.
    /// @param amountTbtc Amount in TBTC base units (1e18) to unmint.
    /// @dev Can only be called by the configured controller.
    function unmintFromVault(uint256 amountTbtc) external onlyController {
        if (amountTbtc == 0) {
            return;
        }

        require(address(vault) != address(0), "MintBurnGuard: vault not set");

        uint256 newTotalTbtc = _decreaseTotalMintedInternal(amountTbtc);

        emit VaultUnmintExecuted(controller, amountTbtc, newTotalTbtc);
        vault.unmint(amountTbtc);
    }

    /// @notice Internal helper increasing `totalMintedTbtc` with cap and pause checks.
    function _increaseTotalMintedInternal(uint256 amountTbtc)
        private
        returns (uint256 newTotalTbtc)
    {
        if (mintingPaused) {
            revert MintingPausedError();
        }

        _enforceMintRateLimit(amountTbtc);

        // Rely on Solidity's built-in overflow checks to prevent wrap-around when
        // mint limits are disabled and extremely large amounts are minted.
        newTotalTbtc = totalMintedTbtc + amountTbtc;

        uint256 cap = globalMintCapTbtc;
        if (cap != 0 && newTotalTbtc > cap) {
            revert GlobalMintCapExceeded(newTotalTbtc, cap);
        }

        totalMintedTbtc = newTotalTbtc;
        emit TotalMintedIncreased(amountTbtc, newTotalTbtc);
    }

    /// @notice Internal helper decreasing `totalMintedTbtc` with underflow protection.
    function _decreaseTotalMintedInternal(uint256 amountTbtc)
        private
        returns (uint256 newTotalTbtc)
    {
        uint256 current = totalMintedTbtc;
        require(amountTbtc <= current, "MintBurnGuard: underflow");

        unchecked {
            newTotalTbtc = current - amountTbtc;
        }

        totalMintedTbtc = newTotalTbtc;
        emit TotalMintedDecreased(amountTbtc, newTotalTbtc);
    }

    /* solhint-disable not-rely-on-time */
    function _enforceMintRateLimit(uint256 amountTbtc) private {
        uint256 limitTbtc = mintRateLimitTbtc;
        uint256 windowSeconds = mintRateLimitWindowSeconds;
        if (limitTbtc == 0 || windowSeconds == 0) {
            return;
        }

        uint256 currentTimestamp = block.timestamp;
        uint256 windowStart = mintRateWindowStartTimestamp;

        if (currentTimestamp >= windowStart + windowSeconds) {
            if (amountTbtc > limitTbtc) {
                revert MintRateLimitExceeded(amountTbtc, limitTbtc);
            }
            mintRateWindowStartTimestamp = currentTimestamp;
            mintRateWindowAmountTbtc = amountTbtc;
            return;
        }

        uint256 nextWindowAmountTbtc = mintRateWindowAmountTbtc + amountTbtc;
        if (nextWindowAmountTbtc > limitTbtc) {
            revert MintRateLimitExceeded(nextWindowAmountTbtc, limitTbtc);
        }

        mintRateWindowAmountTbtc = nextWindowAmountTbtc;
    }

    /* solhint-enable not-rely-on-time */

    /// @notice Updates the global mint cap.
    /// @param newCapTbtc New global mint cap; zero disables the cap.
    /// @dev Can only be called by the owner.
    function setGlobalMintCapTbtc(uint256 newCapTbtc) external onlyOwner {
        uint256 previousCapTbtc = globalMintCapTbtc;
        globalMintCapTbtc = newCapTbtc;
        emit GlobalMintCapUpdated(previousCapTbtc, newCapTbtc);
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

    /// @notice Updates the global net-minted exposure tracked by the guard.
    /// @param newTotalTbtc New total minted amount (1e18).
    /// @dev Can only be called by the owner.
    function setTotalMintedTbtc(uint256 newTotalTbtc) external onlyOwner {
        uint256 cap = globalMintCapTbtc;
        if (cap != 0 && newTotalTbtc > cap) {
            revert GlobalMintCapExceeded(newTotalTbtc, cap);
        }

        uint256 previousTotalTbtc = totalMintedTbtc;
        if (newTotalTbtc == previousTotalTbtc) {
            return;
        }

        totalMintedTbtc = newTotalTbtc;
        emit TotalMintedSet(previousTotalTbtc, newTotalTbtc);
    }

    /// @notice Configures the mint rate limit parameters.
    /// @param limitTbtc Maximum TBTC base units allowed per window; zero disables.
    /// @param windowSeconds Duration of the rate window in seconds.
    /// @dev When `limitTbtc` is non-zero, `windowSeconds` must also be non-zero.
    function setMintRateLimit(uint256 limitTbtc, uint256 windowSeconds)
        external
        onlyOwner
    {
        uint256 previousLimitTbtc = mintRateLimitTbtc;
        uint256 previousWindowSeconds = mintRateLimitWindowSeconds;

        if (limitTbtc == 0) {
            mintRateLimitTbtc = 0;
            mintRateLimitWindowSeconds = 0;
        } else {
            require(windowSeconds != 0, "MintBurnGuard: window must not be 0");
            mintRateLimitTbtc = limitTbtc;
            mintRateLimitWindowSeconds = windowSeconds;
        }

        mintRateWindowStartTimestamp = 0;
        mintRateWindowAmountTbtc = 0;

        emit MintRateLimitUpdated(
            previousLimitTbtc,
            previousWindowSeconds,
            mintRateLimitTbtc,
            mintRateLimitWindowSeconds
        );
    }
}
