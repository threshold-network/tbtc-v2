// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "../account-control/interfaces/IMintBurnGuard.sol";
import "../integrator/ITBTCVault.sol";
import "../integrator/IBank.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title Mock AccountControl
/// @notice Mock contract simulating how AccountControl interacts with MintBurnGuard.
/// @dev Used for testing MintBurnGuard integration with a realistic operator.
contract MockAccountControl {
    IMintBurnGuard public immutable mintBurnGuard;
    ITBTCVault public immutable vault;

    event MintExecuted(
        address indexed reserve,
        address indexed recipient,
        uint256 amount
    );
    event ReturnExecuted(address indexed reserve, uint256 amount);
    event RedemptionExecuted(
        address indexed reserve,
        address indexed user,
        uint256 amount
    );

    constructor(IMintBurnGuard _guard, ITBTCVault _vault) {
        mintBurnGuard = _guard;
        vault = _vault;
    }

    /// @notice Simulates AccountControl.mintTBTC() flow
    /// @dev Calls guard.mintToBank() to mint TBTC to a recipient
    /// @param reserve The reserve address (not used by guard, just for event)
    /// @param recipient Address receiving the TBTC bank balance
    /// @param amount Amount in satoshis to mint
    function mintTBTC(
        address reserve,
        address recipient,
        uint256 amount
    ) external {
        mintBurnGuard.mintToBank(recipient, amount);
        emit MintExecuted(reserve, recipient, amount);
    }

    /// @notice Simulates AccountControl.returnTBTC() flow
    /// @dev Reserve returns TBTC to vault instead of delivering BTC.
    ///      Calls guard.unmintAndBurnFrom() to unmint and burn.
    /// @param reserve The reserve returning TBTC
    /// @param amount Amount in satoshis to return
    function returnTBTC(address reserve, uint256 amount) external {
        // In real AccountControl, this would be called by the reserve
        // The reserve must have approved TBTC tokens to the guard
        mintBurnGuard.unmintAndBurnFrom(reserve, amount);
        emit ReturnExecuted(reserve, amount);
    }

    /// @notice Simulates AccountControl.notifyRedemption() flow
    /// @dev Burns user's bank balance after redemption is finalized.
    ///      Calls guard.burnFrom() to burn bank balance.
    /// @param reserve The reserve handling the redemption
    /// @param user The user whose bank balance will be burned
    /// @param amount Amount in satoshis to burn
    function notifyRedemption(
        address reserve,
        address user,
        uint256 amount
    ) external {
        // In real AccountControl, this checks roles and reserve authorization
        // For testing, we just call the guard
        mintBurnGuard.burnFrom(user, amount);
        emit RedemptionExecuted(reserve, user, amount);
    }
}
