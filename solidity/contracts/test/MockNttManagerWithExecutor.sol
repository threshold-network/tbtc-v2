// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice ExecutorArgs structure for NttManagerWithExecutor
struct ExecutorArgs {
    uint256 value;
    address refundAddress;
    bytes signedQuote;
    bytes instructions;
}

/// @notice FeeArgs structure for NttManagerWithExecutor
struct FeeArgs {
    uint16 dbps;
    address payee;
}

/// @notice Mock NTT Manager With Executor for testing
/// @dev Simulates the behavior of INttManagerWithExecutor for unit tests
contract MockNttManagerWithExecutor {
    using SafeERC20 for IERC20;
    
    uint256 public constant MOCK_DELIVERY_PRICE = 10000000000000000; // 0.01 ETH
    uint64 public nextMsgId = 1;
    
    mapping(uint16 => bool) public supportedChains;
    
    // Mock storage for testing signed quote validation
    mapping(bytes => bool) public validSignedQuotes;
    
    // Mock events to match real implementation
    event MockTransferExecuted(uint64 indexed msgId, uint16 indexed chain, uint256 value);
    event MockExecutorRequested(uint16 indexed chain, bytes32 indexed targetAddress);
    
    constructor() {
        // Set up supported chains for testing
        supportedChains[2] = true;   // Ethereum
        supportedChains[32] = true;  // Sei
        supportedChains[30] = true;  // Base
        supportedChains[23] = true;  // Arbitrum
        supportedChains[40] = true;  // Sei EVM (alternative)
    }
    
    /// @notice Mock implementation of transfer matching real NttManagerWithExecutor
    function transfer(
        address /* nttManager */,
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipientAddress,
        bytes32 /* refundAddress */,
        bytes memory /* encodedInstructions */,
        ExecutorArgs calldata executorArgs,
        FeeArgs calldata feeArgs
    ) external payable returns (uint64 msgId) {
        require(supportedChains[recipientChain], "Chain not supported");
        require(msg.value >= executorArgs.value, "Insufficient executor payment");
        require(executorArgs.signedQuote.length > 0, "Empty signed quote");
        
        msgId = nextMsgId++;
        
        // Mock fee calculation (simplified)
        uint256 fee = calculateFee(amount, feeArgs.dbps);
        uint256 transferAmount = amount;
        if (fee > 0 && feeArgs.payee != address(0)) {
            transferAmount -= fee;
        }
        
        // Emit mock events for testing
        emit MockTransferExecuted(msgId, recipientChain, msg.value);
        emit MockExecutorRequested(recipientChain, recipientAddress);
        
        // Mock refund logic
        uint256 refundAmount = msg.value - executorArgs.value;
        if (refundAmount > 0) {
            // solhint-disable-next-line avoid-low-level-calls
            (bool success,) = payable(executorArgs.refundAddress).call{value: refundAmount}("");
            require(success, "Refund failed");
        }
    }
    
    /// @notice Mock implementation of quoteDeliveryPrice matching real implementation
    function quoteDeliveryPrice(
        address /* nttManager */,
        uint16 recipientChain,
        bytes memory /* encodedInstructions */,
        ExecutorArgs calldata executorArgs,
        FeeArgs calldata /* feeArgs */
    ) external view returns (uint256 totalCost) {
        require(supportedChains[recipientChain], "Chain not supported");
        require(executorArgs.signedQuote.length > 0, "Empty signed quote");
        
        // Base cost for executor service
        uint256 baseCost = MOCK_DELIVERY_PRICE;
        
        // Add chain-specific costs
        if (recipientChain == 32 || recipientChain == 40) { // Sei chains
            baseCost += 2000000000000000; // +0.002 ETH for Sei
        }
        
        // Add executor value
        totalCost = baseCost + executorArgs.value;
        
        return totalCost;
    }
    
    /// @notice Add support for a chain (for testing)
    function setSupportedChain(uint16 chainId, bool supported) external {
        supportedChains[chainId] = supported;
    }
    
    /// @notice Add valid signed quote for testing
    function addValidSignedQuote(bytes memory signedQuote) external {
        validSignedQuotes[signedQuote] = true;
    }
    
    /// @notice Calculate fee matching real implementation
    function calculateFee(uint256 amount, uint16 dbps) public pure returns (uint256 fee) {
        unchecked {
            uint256 q = amount / 100000;
            uint256 r = amount % 100000;
            fee = q * dbps + (r * dbps) / 100000;
        }
    }
    
    /// @notice Receive function for native token refunds
    receive() external payable {}
}
