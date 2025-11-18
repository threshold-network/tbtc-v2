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

/// @title Minting Guard
/// @notice Tracks global net-minted exposure for a controller and enforces
///         system-level caps and pause semantics.
/// @dev This contract is intentionally minimal and oblivious to reserve-level
///      details. It is expected that a single controller contract (e.g.
///      AccountControl) reports all mint and burn operations via this guard.
contract MintingGuard is Ownable {
    /// @notice Address of the controller allowed to adjust the total minted
    ///         exposure tracked by this guard.
    address public controller;

    /// @notice Global net-minted amount reported by the controller.
    /// @dev Expressed in base units agreed upon with the controller, e.g.
    ///      satoshis for TBTC exposure.
    uint256 public totalMinted;

    /// @notice Global mint cap enforced across all controller-managed lines.
    /// @dev A value of zero disables the global cap check.
    uint256 public globalMintCap;

    /// @notice Global pause flag for controller-driven minting.
    /// @dev When set to true, `increaseTotalMinted` reverts for any amount
    ///      greater than zero.
    bool public mintingPaused;

    event ControllerUpdated(
        address indexed previousController,
        address indexed newController
    );

    event TotalMintedIncreased(uint256 amount, uint256 newTotal);
    event TotalMintedDecreased(uint256 amount, uint256 newTotal);
    event GlobalMintCapUpdated(uint256 previousCap, uint256 newCap);
    event MintingPaused(bool paused);

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
