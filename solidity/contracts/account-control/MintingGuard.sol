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

/// @title Minting Guard
/// @notice Tracks global net-minted exposure for a controller and enforces
///         system-level caps and pause semantics.
/// @dev This contract is intentionally minimal and oblivious to reserve-level
///      details. It is expected that a single controller contract (e.g.
///      AccountControl) reports all mint and burn operations via this guard.
contract MintingGuard is Ownable {
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
    // slither-disable-next-line reentrancy-vulnerabilities-3
    function mintToBank(address recipient, uint256 amount)
        external
        onlyController
    {
        if (amount == 0) {
            return;
        }

        uint256 newTotal = _increaseTotalMintedInternal(amount);

        require(address(bridge) != address(0), "MintingGuard: bridge not set");

        bridge.controllerIncreaseBalance(recipient, amount);

        emit BankMintExecuted(controller, recipient, amount, newTotal);
    }

    /// @notice Reduces exposure and burns TBTC via Bank/Vault as appropriate.
    /// @param from Source address for burns that operate on balances.
    /// @param amount Amount in TBTC base units (1e18) to reduce from exposure.
    /// @dev The controller is responsible for choosing the correct `from`
    ///      semantics per flow. This helper only coordinates accounting and
    ///      calls into the configured Bank/Vault.
    function reduceExposureAndBurn(address from, uint256 amount)
        external
        onlyController
    {
        if (amount == 0) {
            return;
        }

        uint256 newTotal = _decreaseTotalMintedInternal(amount);

        // This helper only coordinates global exposure accounting; the actual
        // Bank/Vault burns are executed by the controller (e.g. AccountControl)
        // before calling into this function.
        emit BankBurnExecuted(controller, from, amount, newTotal);
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
