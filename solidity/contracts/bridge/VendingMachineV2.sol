// SPDX-License-Identifier: GPL-3.0-only

pragma solidity ^0.8.17;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../token/TBTC.sol";

/// @title VendingMachineV2
/// @notice VendingMachineV2 is used to exchange tBTC v1 to tBTC v2 in a 1:1
///         ratio during the process of tBTC v1 bridge sunsetting. The redeemer
///         selected by the DAO based on the "TIP-027b tBTC v1: The Sunsetting"
///         proposal will deposit tBTC v2 tokens into VendingMachineV2 so that
///         outstanding tBTC v1 token owners can  upgrade to tBTC v2 tokens.
///         The redeemer will withdraw the tBTC v1 tokens deposited into the
///         contract to perform tBTC v1 redemptions.
///         The redeemer may decide to withdraw their deposited tBTC v2 at any
///         moment in time. The amount withdrawable is lower than the amount
///         deposited in case tBTC v1 was exchanged for tBTC v2.
///         This contract is owned by the redeemer.
contract VendingMachineV2 is Ownable {
    using SafeERC20 for IERC20;
    using SafeERC20 for TBTC;

    IERC20 public immutable tbtcV1;
    TBTC public immutable tbtcV2;

    event Exchanged(address indexed to, uint256 amount);
    event Deposited(address from, uint256 amount);
    event Withdrawn(address token, address to, uint256 amount);

    constructor(IERC20 _tbtcV1, TBTC _tbtcV2) {
        tbtcV1 = _tbtcV1;
        tbtcV2 = _tbtcV2;
    }

    /// @notice Exchange tBTC v1 for tBTC v2 in a 1:1 ratio.
    ///         The caller needs to have at least `amount` of tBTC v1 balance
    ///         approved for transfer to the `VendingMachineV2` before calling
    ///         this function.
    /// @param amount The amount of tBTC v1 to exchange for tBTC v2.
    function exchange(uint256 amount) external {
        _exchange(msg.sender, amount);
    }

    /// @notice Exchange tBTC v1 for tBTC v2 in a 1:1 ratio.
    ///         The caller needs to have at least `amount` of tBTC v1 balance
    ///         approved for transfer to the `VendingMachineV2` before calling
    ///         this function.
    /// @dev This function is a shortcut for `approve` + `exchange`. Only tBTC
    ///      v1 token caller is allowed and only tBTC v1 is allowed as a token
    ///      to transfer.
    /// @param from tBTC v1 token holder exchanging tBTC v1 to tBTC v2.
    /// @param amount The amount of tBTC v1 to exchange for tBTC v2.
    /// @param token tBTC v1 token address.
    function receiveApproval(
        address from,
        uint256 amount,
        address token,
        bytes calldata
    ) external {
        require(token == address(tbtcV1), "Token is not tBTC v1");
        require(msg.sender == address(tbtcV1), "Only tBTC v1 caller allowed");
        _exchange(from, amount);
    }

    /// @notice Allows to deposit tBTC v2 tokens to the contract.
    ///         VendingMachineV2 can not mint tBTC v2 tokens so tBTC v2 needs
    ///         to be deposited into the contract so that tBTC v1 to tBTC v2
    ///         exchange can happen.
    ///         The caller needs to have at least `amount` of tBTC v2 balance
    ///         approved for transfer to the `VendingMachineV2` before calling
    ///         this function.
    /// @dev This function is for the redeemer and tBTC v1 operators. This is
    ///      NOT a function for tBTC v1 token holders.
    /// @param amount The amount of tBTC v2 to deposit into the contract.
    function depositTbtcV2(uint256 amount) external {
        emit Deposited(msg.sender, amount);
        tbtcV2.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Allows the contract owner to withdraw tokens. This function is
    ///         used in two cases: 1) when the redeemer wants to redeem tBTC v1
    ///         tokens to perform tBTC v2 redemptions; 2) when the deadline for
    ///         tBTC v1 -> tBTC v2 exchange passed and the redeemer wants their
    ///         tBTC v2 back.
    /// @dev This function is for the redeemer. This is NOT a function for
    ///      tBTC v1 token holders.
    /// @param token The address of a token to withdraw.
    /// @param recipient The address which should receive withdrawn tokens.
    /// @param amount The amount to withdraw.
    function withdrawFunds(
        IERC20 token,
        address recipient,
        uint256 amount
    ) external onlyOwner {
        emit Withdrawn(address(token), recipient, amount);
        token.safeTransfer(recipient, amount);
    }

    function _exchange(address tokenOwner, uint256 amount) internal {
        require(
            tbtcV2.balanceOf(address(this)) >= amount,
            "Not enough tBTC v2 available in the Vending Machine"
        );

        emit Exchanged(tokenOwner, amount);
        tbtcV1.safeTransferFrom(tokenOwner, address(this), amount);

        tbtcV2.safeTransfer(tokenOwner, amount);
    }
}
