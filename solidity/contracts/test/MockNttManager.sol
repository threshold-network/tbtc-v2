// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

/// @notice Mock NTT Manager for testing
/// @dev Implements the INttManager interface for unit tests
contract MockNttManager {
    uint256 public constant MOCK_DELIVERY_PRICE = 10000000000000000; // 0.01 ETH

    mapping(uint16 => bool) public supportedChains;
    mapping(uint16 => uint256) public chainSpecificPrices;

    constructor() {
        // Set up supported chains for testing
        supportedChains[2] = true; // Ethereum
        supportedChains[32] = true; // Sei
        supportedChains[30] = true; // Base
        supportedChains[23] = true; // Arbitrum
        supportedChains[40] = true; // Sei EVM (alternative)

        // Set chain-specific prices
        chainSpecificPrices[32] = 2000000000000000; // Sei: +0.002 ETH
        chainSpecificPrices[40] = 2000000000000000; // Sei EVM: +0.002 ETH
        chainSpecificPrices[30] = 1500000000000000; // Base: +0.0015 ETH
        chainSpecificPrices[23] = 1000000000000000; // Arbitrum: +0.001 ETH
    }

    /// @notice Mock implementation of quoteDeliveryPrice matching INttManager interface
    function quoteDeliveryPrice(
        uint16 recipientChain,
        bytes memory /* transceiverInstructions */
    ) external view returns (uint256[] memory priceQuotes, uint256 totalPrice) {
        require(supportedChains[recipientChain], "Chain not supported");

        // Create array with single quote (simulating single transceiver)
        priceQuotes = new uint256[](1);

        // Base price + chain-specific price
        uint256 basePrice = MOCK_DELIVERY_PRICE;
        uint256 chainPrice = chainSpecificPrices[recipientChain];
        uint256 totalQuote = basePrice + chainPrice;

        priceQuotes[0] = totalQuote;
        totalPrice = totalQuote;
    }

    /// @notice Add support for a chain (for testing)
    function setSupportedChain(uint16 chainId, bool supported) external {
        supportedChains[chainId] = supported;
    }

    /// @notice Set chain-specific price (for testing)
    function setChainSpecificPrice(uint16 chainId, uint256 price) external {
        chainSpecificPrices[chainId] = price;
    }
}
