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

import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

import "../cross-chain/AbstractL1BTCDepositor.sol";
import "../cross-chain/utils/Crosschain.sol";

/// @title NativeBTCDepositor
/// @notice This contract is part of the direct bridging mechanism allowing
///         users to obtain ERC20 tBTC on the destination chain, without the need
///         to interact with the L1 tBTC ledger chain where minting occurs.
contract NativeBTCDepositor is AbstractL1BTCDepositor {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _tbtcBridge,
        address _tbtcVault
    ) external initializer {
        __AbstractL1BTCDepositor_initialize(_tbtcBridge, _tbtcVault);
        __Ownable_init();
    }

    /// @notice Quotes the payment that must be attached to the `finalizeDeposit`
    ///         function call.
    /// @dev This implementation requires no relayer payment; tBTC is transferred
    ///      directly on Ethereum L1 to the receiver address encoded in bytes32.
    /// @return cost Always 0 for this implementation (in WEI).
    function quoteFinalizeDeposit() external pure returns (uint256 cost) {
        cost = 0;
    }

    /// @notice Transfers ERC20 L1 tBTC directly to the Ethereum L1 receiver address.
    /// @param amount Amount of tBTC L1 ERC20 to transfer (1e18 precision).
    /// @param ethereumReceiverBytes32 Ethereum receiver address encoded as 32 bytes (left-padded).
    function _transferTbtc(
        uint256 amount,
        bytes32 ethereumReceiverBytes32
    ) internal override {
        require(amount > 0, "Amount too low to transfer");
        require(
            ethereumReceiverBytes32 != bytes32(0),
            "Receiver cannot be zero"
        );

        address ethereumReceiver = CrosschainUtils.bytes32ToAddress(
            ethereumReceiverBytes32
        );

        tbtcToken.safeTransfer(ethereumReceiver, amount);
    }
}
