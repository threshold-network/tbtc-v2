// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../account-control/interfaces/IBridgeMintingAuthorization.sol";

/// @title MockBridgeMintingAuthorization
/// @notice Minimal Bridge stub implementing IBridgeMintingAuthorization for MintBurnGuard tests.
contract MockBridgeMintingAuthorization is IBridgeMintingAuthorization {
    address public owner;
    address private _controllerBalanceIncreaser;

    event ControllerBalanceIncreaserSet(address controller);

    modifier onlyOwner() {
        require(msg.sender == owner, "MockBridge: only owner");
        _;
    }

    constructor(
        address /*unusedBank*/
    ) {
        owner = msg.sender;
    }

    /// @notice Updates the controller referenced in tests.
    function setControllerBalanceIncreaser(address controller)
        external
        onlyOwner
    {
        address previous = _controllerBalanceIncreaser;
        _controllerBalanceIncreaser = controller;
        emit ControllerBalanceIncreaserSet(controller);
    }

    /// @inheritdoc IBridgeMintingAuthorization
    function controllerIncreaseBalance(
        address, /*recipient*/
        uint256 /*amount*/
    ) external override {
        require(
            msg.sender == _controllerBalanceIncreaser,
            "MockBridge: unauthorized"
        );
        // No-op body; external effects are not required for current tests.
    }

    /// @inheritdoc IBridgeMintingAuthorization
    function controllerIncreaseBalances(
        address[] calldata, /*recipients*/
        uint256[] calldata /*amounts*/
    ) external override {
        require(
            msg.sender == _controllerBalanceIncreaser,
            "MockBridge: unauthorized"
        );
        // No-op body; external effects are not required for current tests.
    }

    /// @inheritdoc IBridgeMintingAuthorization
    function controllerBalanceIncreaser()
        external
        view
        override
        returns (address)
    {
        return _controllerBalanceIncreaser;
    }
}
