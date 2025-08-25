// SPDX-License-Identifier: GPL-3.0-only

pragma solidity ^0.8.17;

import "./L2WormholeGateway.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

/// @notice Wormhole gateway for L2 Arbitrum - upgraded version.
/// @dev This contract is intended solely for testing purposes. As it currently
///      stands in the implementation of L2WormholeGateway.sol, there are no
///      reserved storage gap slots available, thereby limiting the upgradability
///      to a child contract only.
contract ArbitrumWormholeGatewayUpgraded is L2WormholeGateway {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice This function is called when the user sends their token from L2.
    ///         The contract burns the canonical tBTC from the user and sends
    ///         wormhole tBTC representation over the bridge.
    ///         Keep in mind that when multiple bridges receive a minting
    ///         authority on the canonical tBTC, this function may not be able
    ///         to send all amounts of tBTC through the Wormhole bridge. The
    ///         capability of Wormhole Bridge to send tBTC from the chain is
    ///         limited to the amount of tBTC bridged through Wormhole to that
    ///         chain.
    /// @dev Requirements:
    ///      - The native chain doesn't have a Wormhole tBTC gateway, so the token
    ///        minted by Wormhole should be considered canonical.
    ///      - The sender must have at least `amount` of the canonical tBTC and
    ///        it has to be approved for L2WormholeGateway.
    ///      - The L2WormholeGateway must have at least `amount` of the wormhole
    ///        tBTC.
    ///      - The recipient must not be 0x0.
    ///      - The amount to transfer must not be 0,
    ///      - The amount to transfer must be >= 10^10 (1e18 precision).
    ///      This function uses `transferTokensWithPayload` to send tBTC directly
    ///      to the `recipient` contract address on the recipient chain. The `arbiterFee` is
    ///      not applicable and implicitly 0.
    /// @param amount The amount of tBTC to be sent.
    /// @param recipientNativeChain The Wormhole chain ID of the recipient chain.
    /// @param recipient The Wormhole-formatted address of the target contract on the recipient chain
    ///                  that will receive the tokens and process the payload.
    /// @param nonce The Wormhole nonce used to batch messages together.
    /// @param payload The arbitrary data to be passed to and processed by the `recipient`
    ///                contract on the recipient chain.
    /// @return The Wormhole sequence number.
    function sendTbtcWithPayloadToNativeChain(
        uint256 amount,
        uint16 recipientNativeChain,
        bytes32 recipient,
        uint32 nonce,
        bytes calldata payload
    ) external payable nonReentrant returns (uint64) {
        require(
            gateways[recipientNativeChain] == bytes32(0),
            "No Wormhole tBTC gateway on the native chain"
        );
        require(recipient != bytes32(0), "0x0 recipient not allowed");
        require(amount != 0, "Amount must not be 0");

        // Normalize the amount to bridge. The dust can not be bridged due to
        // the decimal shift in the Wormhole Bridge contract.
        amount = normalize(amount);

        // Check again after dropping the dust.
        require(amount != 0, "Amount too low to bridge");

        require(
            bridgeToken.balanceOf(address(this)) >= amount,
            "Not enough wormhole tBTC in the gateway to bridge"
        );

        emit WormholeTbtcSent(
            amount,
            recipientNativeChain,
            bytes32(0), // No specific tBTC gateway from 'gateways' mapping is used; 'recipient' is the direct target contract.
            recipient,
            0, // arbiterFee is 0 as this function sends with payload
            nonce
        );

        require(
            mintedAmount >= amount,
            "L2WormholeGateway: amount to send exceeds minted amount"
        );
        mintedAmount -= amount;
        tbtc.burnFrom(msg.sender, amount);
        bridgeToken.safeApprove(address(bridge), amount);

        return
            bridge.transferTokensWithPayload{value: msg.value}(
                address(bridgeToken),
                amount,
                recipientNativeChain,
                recipient,
                nonce,
                payload
            );
    }
}
