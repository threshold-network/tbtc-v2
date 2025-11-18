// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../account-control/interfaces/IBridgeMintingAuthorization.sol";

/// @title MockBridgeMintingAuthorization
/// @notice Minimal Bridge stub implementing IBridgeMintingAuthorization for MintBurnGuard tests.
contract MockBridgeMintingAuthorization is IBridgeMintingAuthorization {
    address public owner;

    mapping(address => bool) private _authorizedIncreasers;

    event ControllerAuthorizationUpdated(
        address indexed controller,
        bool authorized
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "MockBridge: only owner");
        _;
    }

    constructor(
        address /*unusedBank*/
    ) {
        owner = msg.sender;
    }

    /// @notice Updates authorization status for a controller in tests.
    function setAuthorizedBalanceIncreaser(address controller, bool authorized)
        external
        onlyOwner
    {
        _authorizedIncreasers[controller] = authorized;
        emit ControllerAuthorizationUpdated(controller, authorized);
    }

    /// @inheritdoc IBridgeMintingAuthorization
    function controllerIncreaseBalance(
        address, /*recipient*/
        uint256 /*amount*/
    ) external override {
        require(_authorizedIncreasers[msg.sender], "MockBridge: unauthorized");
        // No-op body; external effects are not required for current tests.
    }

    /// @inheritdoc IBridgeMintingAuthorization
    function controllerIncreaseBalances(
        address[] calldata, /*recipients*/
        uint256[] calldata /*amounts*/
    ) external override {
        require(_authorizedIncreasers[msg.sender], "MockBridge: unauthorized");
        // No-op body; external effects are not required for current tests.
    }

    /// @inheritdoc IBridgeMintingAuthorization
    function authorizedBalanceIncreasers(address controller)
        external
        view
        override
        returns (bool)
    {
        return _authorizedIncreasers[controller];
    }

    /// @inheritdoc IBridgeMintingAuthorization
    function getAuthorizedBalanceIncreasers(address[] calldata increasers)
        external
        view
        override
        returns (bool[] memory flags)
    {
        uint256 length = increasers.length;
        flags = new bool[](length);
        for (uint256 i = 0; i < length; i++) {
            flags[i] = _authorizedIncreasers[increasers[i]];
        }
    }
}
