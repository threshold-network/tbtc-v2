// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../account-control/interfaces/IBridgeController.sol";

/// @title MockBridgeController
/// @notice Minimal Bridge stub implementing IBridgeController for MintBurnGuard tests.
contract MockBridgeController is IBridgeController {
    address public owner;
    address private _mintingController;

    event MintingControllerSet(address controller);

    modifier onlyOwner() {
        require(msg.sender == owner, "MockBridge: only owner");
        _;
    }

    constructor(
        address /*unusedBank*/
    ) {
        owner = msg.sender;
    }

    /// @notice Updates the minting controller referenced in tests.
    function setMintingController(address controller) external onlyOwner {
        _mintingController = controller;
        emit MintingControllerSet(controller);
    }

    /// @inheritdoc IBridgeController
    function controllerIncreaseBalance(
        address, /*recipient*/
        uint256 /*amount*/
    ) external override {
        require(msg.sender == _mintingController, "MockBridge: unauthorized");
        // No-op body; external effects are not required for current tests.
    }

    /// @inheritdoc IBridgeController
    function controllerIncreaseBalances(
        address[] calldata, /*recipients*/
        uint256[] calldata /*amounts*/
    ) external override {
        require(msg.sender == _mintingController, "MockBridge: unauthorized");
        // No-op body; external effects are not required for current tests.
    }

    /// @inheritdoc IBridgeController
    function mintingController() external view override returns (address) {
        return _mintingController;
    }
}
