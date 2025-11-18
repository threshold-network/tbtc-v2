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
import "./interfaces/IMintingGuard.sol";

/// @dev Minimal Bank-like interface exposing only the burn primitive needed
///      by MintBurnGuard.
interface IBankLike {
    function decreaseBalance(uint256 amount) external;
}

/// @dev Minimal Vault-like interface exposing only the unmint primitive
///      needed by MintBurnGuard.
interface IVaultLike {
    function unmint(uint256 amount) external;
}

/// @title Mint/Burn Guard
/// @notice Tracks global net-minted exposure for a controller and enforces
///         system-level caps and pause semantics.
/// @dev This contract is intentionally minimal and oblivious to reserve-level
///      details. It is expected that a single controller contract (e.g.
///      AccountControl) reports all mint and burn operations via this guard.
contract MintBurnGuard is Ownable, IMintBurnGuard {
    /// @notice Address of the controller allowed to adjust the total minted
    ///         exposure tracked by this guard and call execution helpers.
    address public controller;

    /// @notice Global net-minted amount reported by the controller.
    /// @dev Expressed in base units agreed upon with the controller, e.g.
    ///      satoshis for TBTC exposure.
    uint256 public totalMinted;

    /// @notice Global mint cap enforced across all controller-managed lines.
    /// @dev A value of zero disables the global cap check.
    uint256 public globalMintCap;

    /// @notice Global pause flag for controller-driven minting.
    /// @dev When set to true, mint-side helpers revert for any amount > 0.
    bool public mintingPaused;

    /// @notice Bridge contract used to mint TBTC into the Bank.
    IBridgeMintingAuthorization public bridge;

    /// @notice Bank contract used for burning TBTC bank balances when needed.
    IBankLike public bank;

    /// @notice Vault contract used for unminting TBTC held in the vault.
    IVaultLike public vault;

    event ControllerUpdated(
        address indexed previousController,
        address indexed newController
    );

    event TotalMintedIncreased(uint256 amount, uint256 newTotal);
    event TotalMintedDecreased(uint256 amount, uint256 newTotal);
    event GlobalMintCapUpdated(uint256 previousCap, uint256 newCap);
    event MintingPaused(bool paused);

    event BankMintExecuted(
        address indexed controller,
        address indexed recipient,
        uint256 amountSats,
        uint256 newTotalMinted
    );

    event BankBurnExecuted(
        address indexed controller,
        address indexed from,
        uint256 amountSats,
        uint256 newTotalMinted
    );

    event VaultUnmintExecuted(
        address indexed controller,
        uint256 amountSats,
        uint256 newTotalMinted
    );

    error NotController(address caller);
    error MintingPausedError();
    error GlobalMintCapExceeded(uint256 newTotal, uint256 cap);

    modifier onlyController() {
        if (msg.sender != controller) {
            revert NotController(msg.sender);
        }
        _;
    }

    /// @notice Sets the initial owner and, optionally, the controller.
    /// @param initialOwner Address that will become the contract owner.
    /// @param initialController Optional controller address; can be zero and
    ///        set later via `setController`.
    constructor(address initialOwner, address initialController) {
        require(initialOwner != address(0), "Owner must not be 0x0");
        _transferOwnership(initialOwner);

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
        require(address(bridge_) != address(0), "Bridge must not be 0x0");
        bridge = bridge_;
    }

    /// @notice Configures the Bank contract used for burn helpers.
    /// @param bank_ Bank contract used for burning TBTC bank balances.
    function setBank(IBankLike bank_) external onlyOwner {
        require(address(bank_) != address(0), "Bank must not be 0x0");
        bank = bank_;
    }

    /// @notice Configures the Vault contract used for unmint helpers.
    /// @param vault_ Vault contract used for unminting TBTC.
    function setVault(IVaultLike vault_) external onlyOwner {
        require(address(vault_) != address(0), "Vault must not be 0x0");
        vault = vault_;
    }

    /// @notice Increases the global net-minted exposure.
    /// @param amount Amount to add to the total minted exposure.
    /// @return newTotal The updated total minted amount.
    /// @dev Can only be called by the configured controller.
    function increaseTotalMinted(uint256 amount)
        external
        onlyController
        returns (uint256 newTotal)
    {
        if (amount == 0) {
            return totalMinted;
        }

        if (mintingPaused) {
            revert MintingPausedError();
        }

        unchecked {
            newTotal = totalMinted + amount;
        }

        uint256 cap = globalMintCap;
        if (cap != 0 && newTotal > cap) {
            revert GlobalMintCapExceeded(newTotal, cap);
        }

        totalMinted = newTotal;
        emit TotalMintedIncreased(amount, newTotal);
    }

    /// @notice Decreases the global net-minted exposure.
    /// @param amount Amount to subtract from the total minted exposure.
    /// @return newTotal The updated total minted amount.
    /// @dev Can only be called by the configured controller.
    function decreaseTotalMinted(uint256 amount)
        external
        onlyController
        returns (uint256 newTotal)
    {
        if (amount == 0) {
            return totalMinted;
        }

        newTotal = _decreaseTotalMintedInternal(amount);
    }

    /// @notice Mints TBTC to the Bank via the Bridge and updates global exposure.
    /// @param recipient Address receiving the TBTC bank balance.
    /// @param amount Amount in TBTC base units (1e18) to add to exposure.
    /// @dev Can only be called by the configured controller.
    // slither-disable-next-line reentrancy-vulnerabilities-3 reentrancy-vulnerabilities-2
    function mintToBank(address recipient, uint256 amount)
        external
        onlyController
    {
        if (amount == 0) {
            return;
        }

        require(address(bridge) != address(0), "MintingGuard: bridge not set");

        uint256 newTotal = _increaseTotalMintedInternal(amount);

        emit BankMintExecuted(controller, recipient, amount, newTotal);
        bridge.controllerIncreaseBalance(recipient, amount);
    }

    /// @notice Reduces exposure and burns TBTC via Bank/Vault as appropriate.
    /// @param from Source address for burns that operate on balances.
    /// @param amount Amount in TBTC base units (1e18) to reduce from exposure.
    /// @dev The controller is responsible for choosing the correct `from`
    ///      semantics per flow. This helper only coordinates accounting and
    ///      emits an accounting event; any concrete Bank/Vault calls must be
    ///      executed by the controller or by dedicated helpers before or after
    ///      calling into this function.
    function reduceExposureAndBurn(address from, uint256 amount)
        external
        onlyController
    {
        if (amount == 0) {
            return;
        }

        uint256 newTotal = _decreaseTotalMintedInternal(amount);

        emit BankBurnExecuted(controller, from, amount, newTotal);
    }

    /// @notice Burns TBTC bank balance and reduces global exposure.
    /// @param from Source address for which the burn semantics are tracked.
    /// @param amount Amount in TBTC base units (1e18) to burn from the Bank.
    /// @dev This helper assumes that the Bank exposes a `decreaseBalance`
    ///      primitive that burns the caller's bank balance. The `from` address
    ///      is emitted for monitoring purposes; it is up to higher-level
    ///      logic to ensure that balances are held in an account that can be
    ///      safely burned by this helper.
    function burnFromBank(address from, uint256 amount)
        external
        onlyController
    {
        if (amount == 0) {
            return;
        }

        require(address(bank) != address(0), "MintBurnGuard: bank not set");

        uint256 newTotal = _decreaseTotalMintedInternal(amount);

        emit BankBurnExecuted(controller, from, amount, newTotal);
        bank.decreaseBalance(amount);
    }

    /// @notice Unmints TBTC via the configured vault and reduces global
    ///         exposure.
    /// @param amount Amount in TBTC base units (1e18) to unmint.
    /// @dev Can only be called by the configured controller.
    function unmintFromVault(uint256 amount) external onlyController {
        if (amount == 0) {
            return;
        }

        require(address(vault) != address(0), "MintBurnGuard: vault not set");

        uint256 newTotal = _decreaseTotalMintedInternal(amount);

        emit VaultUnmintExecuted(controller, amount, newTotal);
        vault.unmint(amount);
    }

    /// @notice Internal helper increasing `totalMinted` with cap and pause checks.
    function _increaseTotalMintedInternal(uint256 amount)
        private
        returns (uint256 newTotal)
    {
        if (mintingPaused) {
            revert MintingPausedError();
        }

        unchecked {
            newTotal = totalMinted + amount;
        }

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
        require(amount <= current, "MintingGuard: underflow");

        unchecked {
            newTotal = current - amount;
        }

        totalMinted = newTotal;
        emit TotalMintedDecreased(amount, newTotal);
    }

    /// @notice Updates the global mint cap.
    /// @param newCap New global mint cap; zero disables the cap.
    /// @dev Can only be called by the owner.
    function setGlobalMintCap(uint256 newCap) external onlyOwner {
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
}
