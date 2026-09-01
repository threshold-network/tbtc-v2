// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

/// @notice Mock NTT Manager for testing
/// @dev Implements the INttManager interface for unit tests
contract MockNttManager {
    uint256 public constant MOCK_DELIVERY_PRICE = 10000000000000000; // 0.01 ETH
    uint64 public nextMsgId = 1;

    mapping(uint16 => bool) public supportedChains;
    mapping(uint16 => uint256) public chainSpecificPrices;

    uint256 public lastAmount;
    uint16 public lastRecipientChain;
    bytes32 public lastRecipient;
    bytes32 public lastRefundAddress;
    bool public lastShouldQueue;
    bytes public lastEncodedInstructions;
    uint256 public lastMsgValue;

    event MockTransferExecuted(
        uint64 indexed msgId,
        uint16 indexed chain,
        bytes32 indexed recipient,
        uint256 amount,
        uint256 value
    );

    constructor() {
        // Set up supported chains for testing
        supportedChains[2] = true; // Ethereum
        supportedChains[32] = true; // Sample destination
        supportedChains[30] = true; // Base
        supportedChains[23] = true; // Arbitrum
        supportedChains[40] = true; // Sample EVM destination

        // Set chain-specific prices
        chainSpecificPrices[32] = 2000000000000000; // Sample destination: +0.002 ETH
        chainSpecificPrices[40] = 2000000000000000; // Sample EVM destination: +0.002 ETH
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

    /// @notice Mock implementation of the simple NTT transfer overload
    function transfer(
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient
    ) external payable returns (uint64 msgId) {
        msgId = _recordTransfer(
            amount,
            recipientChain,
            recipient,
            bytes32(0),
            false,
            ""
        );
    }

    /// @notice Mock implementation of the full NTT transfer overload
    function transfer(
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient,
        bytes32 refundAddress,
        bool shouldQueue,
        bytes memory encodedInstructions
    ) external payable returns (uint64 msgId) {
        msgId = _recordTransfer(
            amount,
            recipientChain,
            recipient,
            refundAddress,
            shouldQueue,
            encodedInstructions
        );
    }

    /// @notice Add support for a chain (for testing)
    function setSupportedChain(uint16 chainId, bool supported) external {
        supportedChains[chainId] = supported;
    }

    /// @notice Set chain-specific price (for testing)
    function setChainSpecificPrice(uint16 chainId, uint256 price) external {
        chainSpecificPrices[chainId] = price;
    }

    function _recordTransfer(
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient,
        bytes32 refundAddress,
        bool shouldQueue,
        bytes memory encodedInstructions
    ) internal returns (uint64 msgId) {
        require(supportedChains[recipientChain], "Chain not supported");

        msgId = nextMsgId++;
        lastAmount = amount;
        lastRecipientChain = recipientChain;
        lastRecipient = recipient;
        lastRefundAddress = refundAddress;
        lastShouldQueue = shouldQueue;
        lastEncodedInstructions = encodedInstructions;
        lastMsgValue = msg.value;

        emit MockTransferExecuted(
            msgId,
            recipientChain,
            recipient,
            amount,
            msg.value
        );
    }
}
