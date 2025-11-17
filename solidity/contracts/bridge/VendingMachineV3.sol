// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../token/TBTC.sol";

/// @title VendingMachineV3
/// @notice VendingMachineV3 is used to exchange tBTC v1 to tBTC v2 in a 1:1
///         ratio after the tBTC v1 bridge sunsetting is completed. Since
///         tBTC v1 bridge is no longer working, tBTC v1 tokens can not be used
///         to perform BTC redemptions. This contract allows tBTC v1 owners to
///         upgrade to tBTC v2 without any deadline. This way, tBTC v1 tokens
///         left on the market are always backed by Bitcoin. The governance will
///         deposit tBTC v2 into the contract in the amount equal to tBTC v1
///         supply. The governance is allowed to withdraw tBTC v2 only if tBTC
///         v2 left in this contract is enough to cover the upgrade of all tBTC
///         v1 left on the market. This contract is owned by the governance.
contract VendingMachineV3 is Ownable {
    using SafeERC20 for IERC20;
    using SafeERC20 for TBTC;

    IERC20 public immutable tbtcV1;
    TBTC public immutable tbtcV2;

    event Exchanged(address indexed to, uint256 amount);
    event Deposited(address from, uint256 amount);
    event TbtcV2Withdrawn(address to, uint256 amount);
    event FundsRecovered(address token, address to, uint256 amount);

    constructor(IERC20 _tbtcV1, TBTC _tbtcV2) {
        tbtcV1 = _tbtcV1;
        tbtcV2 = _tbtcV2;
    }

    /// @notice Exchange tBTC v1 for tBTC v2 in a 1:1 ratio.
    ///         The caller needs to have at least `amount` of tBTC v1 balance
    ///         approved for transfer to the `VendingMachineV3` before calling
    ///         this function.
    /// @param amount The amount of tBTC v1 to exchange for tBTC v2.
    function exchange(uint256 amount) external {
        _exchange(msg.sender, amount);
    }

    /// @notice Exchange tBTC v1 for tBTC v2 in a 1:1 ratio.
    ///         The caller needs to have at least `amount` of tBTC v1 balance
    ///         approved for transfer to the `VendingMachineV3` before calling
    ///         this function.
    /// @dev This function is a shortcut for `approve` + `exchange`. Only tBTC
    ///      v1 caller is allowed and only tBTC v1 is allowed as a token to
    ///      transfer.
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
    ///         `VendingMachineV3` can not mint tBTC v2 tokens so tBTC v2 needs
    ///         to be deposited into the contract so that tBTC v1 to tBTC v2
    ///         exchange can happen.
    ///         The caller needs to have at least `amount` of tBTC v2 balance
    ///         approved for transfer to the `VendingMachineV3` before calling
    ///         this function.
    /// @dev This function is for the redeemer and tBTC v1 operators. This is
    ///      NOT a function for tBTC v1 token holders.
    /// @param amount The amount of tBTC v2 to deposit into the contract.
    function depositTbtcV2(uint256 amount) external {
        emit Deposited(msg.sender, amount);
        tbtcV2.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Allows the governance to withdraw tBTC v2 deposited into this
    ///         contract. The governance is allowed to withdraw tBTC v2
    ///         only if tBTC v2 left in this contract is enough to cover the
    ///         upgrade of all tBTC v1 left on the market.
    /// @param recipient The address which should receive withdrawn tokens.
    /// @param amount The amount to withdraw.
    function withdrawTbtcV2(address recipient, uint256 amount)
        external
        onlyOwner
    {
        require(
            tbtcV1.totalSupply() <= tbtcV2.balanceOf(address(this)) - amount,
            "tBTC v1 must not be left unbacked"
        );

        emit TbtcV2Withdrawn(recipient, amount);
        tbtcV2.safeTransfer(recipient, amount);
    }

    /// @notice Allows the governance to recover ERC20 sent to this contract
    ///         by mistake or tBTC v1 locked in the contract to exchange to
    ///         tBTC v2. No tBTC v2 can be withdrawn using this function.
    /// @param token The address of a token to recover.
    /// @param recipient The address which should receive recovered tokens.
    /// @param amount The amount to recover.
    function recoverFunds(
        IERC20 token,
        address recipient,
        uint256 amount
    ) external onlyOwner {
        require(
            address(token) != address(tbtcV2),
            "tBTC v2 tokens can not be recovered, use withdrawTbtcV2 instead"
        );

        emit FundsRecovered(address(token), recipient, amount);
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
