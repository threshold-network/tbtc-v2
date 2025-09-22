// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

// Import the structs directly since they're defined in the same file
// struct ExecutorArgs and FeeArgs are defined below

/// @notice Executor arguments for NttManagerWithExecutor transfers
/// @dev These parameters are used by the Wormhole Executor service
struct ExecutorArgs {
    /// @notice Value in wei to pay for executor service
    uint256 value;
    /// @notice Address to receive refunds for unused gas
    address refundAddress;
    /// @notice Signed quote from the Wormhole Executor API
    bytes signedQuote;
    /// @notice Relay instructions for gas configuration on destination chain
    bytes instructions;
}

/// @notice Fee arguments for NttManagerWithExecutor transfers
/// @dev Used to specify fees taken by the executor service
struct FeeArgs {
    /// @notice Fee in basis points (e.g., 100 = 1%)
    uint16 dbps;
    /// @notice Address to receive the fee payment
    address payee;
}

/// @notice Mock implementation of NttManagerWithExecutor for testing
/// @dev Provides a simple mock that implements the required interface for testing
contract MockNttManagerWithExecutor {
    // Mock constants
    uint256 public constant MOCK_DELIVERY_PRICE = 10000000000000000; // 0.01 ETH
    
    // State variables
    mapping(uint16 => bool) public supportedChains;
    
    // Events
    event TransferExecuted(
        address indexed nttManager,
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipientAddress,
        uint64 msgId
    );
    
    event SupportedChainUpdated(uint16 chainId, bool supported);
    
    constructor() {
        // Initialize with some default supported chains if needed
    }
    
    /// @notice Set whether a chain is supported
    /// @param chainId The Wormhole chain ID
    /// @param supported Whether the chain is supported
    function setSupportedChain(uint16 chainId, bool supported) external {
        supportedChains[chainId] = supported;
        emit SupportedChainUpdated(chainId, supported);
    }
    
    /// @notice Mock transfer function that implements the INttManagerWithExecutor interface
    /// @param amount Amount of tokens to transfer
    /// @param recipientChain Wormhole chain ID of the destination
    /// @param recipientAddress Recipient address on destination chain (bytes32 format)
    /// @return msgId The message ID of the transfer
    function transfer(
        address /* nttManager */,
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipientAddress,
        bytes32 /* refundAddress */,
        bytes memory /* encodedInstructions */,
        ExecutorArgs memory /* executorArgs */,
        FeeArgs memory /* feeArgs */
    ) external payable returns (uint64 msgId) {
        // Validate that the chain is supported
        require(supportedChains[recipientChain], "Chain not supported");
        
        // Mock message ID (just use a simple counter or timestamp)
        msgId = uint64(block.timestamp);
        
        // Emit event for testing
        emit TransferExecuted(
            address(0), // nttManager address not used in mock
            amount,
            recipientChain,
            recipientAddress,
            msgId
        );
        
        // In a real implementation, this would interact with the actual NTT Manager
        // For testing, we just return the mock message ID
        return msgId;
    }
    
    /// @notice Mock quote function that returns a fixed delivery price
    /// @param recipientChain Wormhole chain ID of the destination
    /// @param executorArgs Parameters for the Wormhole Executor service
    /// @return totalCost Total cost in wei for the transfer
    function quoteDeliveryPrice(
        address /* nttManager */,
        uint16 recipientChain,
        bytes memory /* encodedInstructions */,
        ExecutorArgs memory executorArgs,
        FeeArgs memory /* feeArgs */
    ) external view returns (uint256 totalCost) {
        // Validate that the chain is supported
        require(supportedChains[recipientChain], "Chain not supported");
        
        // Return the mock delivery price plus any executor value
        return MOCK_DELIVERY_PRICE + executorArgs.value;
    }
    
    /// @notice Calculate fee based on amount and basis points
    /// @param amount The amount to calculate fee for
    /// @param dbps The basis points (e.g., 100 = 1%)
    /// @return fee The calculated fee
    function calculateFee(uint256 amount, uint16 dbps) external pure returns (uint256 fee) {
        return (amount * dbps) / 10000;
    }
    
    /// @notice Check if a chain is supported
    /// @param chainId The Wormhole chain ID
    /// @return supported Whether the chain is supported
    function isChainSupported(uint16 chainId) external view returns (bool supported) {
        return supportedChains[chainId];
    }
}
