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

import "../AbstractL1BTCDepositor.sol";
import "./TransceiverStructs.sol";

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

/// @notice NTT Manager With Executor interface for cross-chain transfers with executor support
/// @dev Interface for the enhanced NTT Manager that supports Wormhole Executor integration
interface INttManagerWithExecutor {
    /// @notice Transfer tokens with executor support for automatic destination chain execution
    /// @param nttManager Address of the underlying NTT Manager contract
    /// @param amount Amount of tokens to transfer
    /// @param recipientChain Wormhole chain ID of the destination
    /// @param recipientAddress Recipient address on destination chain (bytes32 format)
    /// @param refundAddress Address to receive refunds for unused gas
    /// @param encodedInstructions Additional instructions for the transfer (transceiver instructions)
    /// @param executorArgs Parameters for the Wormhole Executor service
    /// @param feeArgs Fee configuration for the executor
    /// @return msgId The message ID of the transfer
    function transfer(
        address nttManager,
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipientAddress,
        bytes32 refundAddress,
        bytes memory encodedInstructions,
        ExecutorArgs memory executorArgs,
        FeeArgs memory feeArgs
    ) external payable returns (uint64 msgId);

    /// @notice Quote the total cost for a transfer including executor fees
    /// @param nttManager Address of the underlying NTT Manager contract
    /// @param recipientChain Wormhole chain ID of the destination
    /// @param encodedInstructions Additional instructions for the transfer (transceiver instructions)
    /// @param executorArgs Parameters for the Wormhole Executor service
    /// @param feeArgs Fee configuration for the executor
    /// @return totalCost Total cost in wei for the transfer
    function quoteDeliveryPrice(
        address nttManager,
        uint16 recipientChain,
        bytes memory encodedInstructions,
        ExecutorArgs memory executorArgs,
        FeeArgs memory feeArgs
    ) external view returns (uint256 totalCost);
}

/// @title L1BTCDepositorNttWithExecutor
/// @notice Enhanced version of L1BTCDepositorNtt that uses NttManagerWithExecutor for automatic
/// destination chain execution via the Wormhole Executor service.
///
/// @dev This contract extends the direct bridging mechanism to support automatic execution
/// on the destination chain, eliminating the need for manual transaction completion.
/// The Wormhole Executor service handles the destination chain transaction automatically.
///
/// @dev Key differences from L1BTCDepositorNtt:
/// - Uses NttManagerWithExecutor instead of direct NTT Manager
/// - Requires executor quotes and fee configuration
/// - Supports automatic destination chain execution
/// - Handles more complex fee structures (executor fees + destination gas)
/// - Provides better UX by eliminating manual claim steps
///
/// @dev Executor Integration:
/// - Fetches signed quotes from Wormhole Executor API
/// - Configures gas limits for destination chain execution
/// - Handles fee payments to executor service
/// - Provides refund mechanisms for unused gas
contract L1BTCDepositorNttWithExecutor is AbstractL1BTCDepositor {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @notice NTT Manager With Executor contract for enhanced cross-chain transfers
    INttManagerWithExecutor public nttManagerWithExecutor;

    /// @notice Address of the underlying NTT Manager contract
    /// @dev This is passed to the NttManagerWithExecutor during transfers
    address public underlyingNttManager;

    /// @notice Mapping of supported destination chains by Wormhole chain ID
    mapping(uint16 => bool) public supportedChains;

    /// @notice Default supported chain ID for backward compatibility
    uint16 public defaultSupportedChain;

    /// @notice Default gas limit for destination chain execution
    /// @dev Used when no specific gas limit is provided in relay instructions
    uint256 public defaultDestinationGasLimit;

    /// @notice Default executor fee in basis points
    /// @dev Used when no specific fee is configured (e.g., 100 = 1%)
    uint16 public defaultExecutorFeeBps;

    /// @notice Default executor fee recipient
    address public defaultExecutorFeeRecipient;

    /// @notice Stored executor arguments for the next transfer
    /// @dev Set via setExecutorParameters before calling finalizeDeposit
    ExecutorArgs private storedExecutorArgs;

    /// @notice Stored fee arguments for the next transfer
    /// @dev Set via setExecutorParameters before calling finalizeDeposit
    FeeArgs private storedFeeArgs;

    /// @notice Flag indicating if executor parameters have been set
    bool private executorParametersSet;

    /// @notice Emitted when executor parameters are set
    /// @param sender Address that set the parameters
    /// @param signedQuoteLength Length of the signed quote in bytes
    /// @param executorValue Value in wei for executor service
    event ExecutorParametersSet(
        address indexed sender,
        uint256 signedQuoteLength,
        uint256 executorValue
    );

    /// @notice Emitted when tokens are transferred via NTT Manager With Executor
    /// @param amount Amount of tBTC transferred
    /// @param destinationChain Wormhole chain ID of the destination
    /// @param actualRecipient Actual recipient address on destination chain
    /// @param transferSequence NTT transfer sequence number
    /// @param encodedReceiver Original encoded receiver data
    /// @param executorCost Cost paid to executor service in wei
    event TokensTransferredNttWithExecutor(
        uint256 amount,
        uint16 destinationChain,
        bytes32 actualRecipient,
        uint64 transferSequence,
        bytes32 encodedReceiver,
        uint256 executorCost
    );

    /// @notice Emitted when a destination chain is added or removed
    event SupportedChainUpdated(uint16 indexed chainId, bool supported);

    /// @notice Emitted when default supported chain is updated
    event DefaultSupportedChainUpdated(uint16 indexed chainId);

    /// @notice Emitted when default parameters are updated
    event DefaultParametersUpdated(
        uint256 gasLimit,
        uint16 feeBps,
        address feeRecipient
    );

    /// @notice Emitted when the underlying NTT Manager is updated
    event UnderlyingNttManagerUpdated(
        address indexed oldManager,
        address indexed newManager
    );

    /// @notice Emitted when the NTT Manager With Executor is updated
    event NttManagerWithExecutorUpdated(
        address indexed oldManager,
        address indexed newManager
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the L1 depositor contract with executor support
    /// @param _tbtcBridge tBTC Bridge contract address
    /// @param _tbtcVault tBTC Vault contract address
    /// @param _nttManagerWithExecutor NTT Manager With Executor contract address
    /// @param _underlyingNttManager Underlying NTT Manager contract address
    function initialize(
        address _tbtcBridge,
        address _tbtcVault,
        address _nttManagerWithExecutor,
        address _underlyingNttManager
    ) external initializer {
        __AbstractL1BTCDepositor_initialize(_tbtcBridge, _tbtcVault);
        __Ownable_init();

        require(
            _nttManagerWithExecutor != address(0),
            "NTT Manager With Executor address cannot be zero"
        );
        require(
            _underlyingNttManager != address(0),
            "Underlying NTT Manager address cannot be zero"
        );

        nttManagerWithExecutor = INttManagerWithExecutor(
            _nttManagerWithExecutor
        );
        underlyingNttManager = _underlyingNttManager;

        // Set reasonable defaults
        defaultDestinationGasLimit = 500000; // 500k gas for destination execution
        defaultExecutorFeeBps = 0; // 0% executor fee by default
        defaultExecutorFeeRecipient = address(0); // No fee recipient by default
    }

    /// @notice Sets the default supported chain for backward compatibility
    /// @param _chainId Wormhole chain ID to set as default
    function setDefaultSupportedChain(uint16 _chainId) external onlyOwner {
        require(_chainId != 0, "Chain ID cannot be zero");
        require(
            supportedChains[_chainId],
            "Chain must be supported before setting as default"
        );
        defaultSupportedChain = _chainId;
        emit DefaultSupportedChainUpdated(_chainId);
    }

    /// @notice Adds or removes support for a destination chain
    /// @param _chainId Wormhole chain ID of the destination chain
    /// @param _supported Whether to support transfers to this chain
    function setSupportedChain(uint16 _chainId, bool _supported)
        external
        onlyOwner
    {
        require(_chainId != 0, "Chain ID cannot be zero");
        supportedChains[_chainId] = _supported;
        emit SupportedChainUpdated(_chainId, _supported);
    }

    /// @notice Updates default parameters for executor transfers
    /// @param _gasLimit Default gas limit for destination chain execution
    /// @param _feeBps Default executor fee in basis points
    /// @param _feeRecipient Default executor fee recipient
    function setDefaultParameters(
        uint256 _gasLimit,
        uint16 _feeBps,
        address _feeRecipient
    ) external onlyOwner {
        require(
            _feeRecipient != address(0) || _feeBps == 0,
            "Fee recipient cannot be zero when fee is set"
        );
        defaultDestinationGasLimit = _gasLimit;
        defaultExecutorFeeBps = _feeBps;
        defaultExecutorFeeRecipient = _feeRecipient;

        emit DefaultParametersUpdated(_gasLimit, _feeBps, _feeRecipient);
    }

    /// @notice Updates the underlying NTT Manager address
    /// @param _newNttManager New underlying NTT Manager address
    function updateUnderlyingNttManager(address _newNttManager)
        external
        onlyOwner
    {
        require(
            _newNttManager != address(0),
            "NTT Manager address cannot be zero"
        );
        address oldManager = underlyingNttManager;
        underlyingNttManager = _newNttManager;
        emit UnderlyingNttManagerUpdated(oldManager, _newNttManager);
    }

    /// @notice Updates the NTT Manager With Executor address
    /// @param _newNttManagerWithExecutor New NTT Manager With Executor address
    function updateNttManagerWithExecutor(address _newNttManagerWithExecutor)
        external
        onlyOwner
    {
        require(
            _newNttManagerWithExecutor != address(0),
            "Address cannot be zero"
        );
        address oldManager = address(nttManagerWithExecutor);
        nttManagerWithExecutor = INttManagerWithExecutor(
            _newNttManagerWithExecutor
        );
        emit NttManagerWithExecutorUpdated(
            oldManager,
            _newNttManagerWithExecutor
        );
    }

    /// @notice Allows the owner to retrieve tokens from the contract
    /// @param _token The address of the token to retrieve (address(0) for native token)
    /// @param _to The address to send the tokens to
    /// @param _amount The amount of tokens to retrieve
    function retrieveTokens(
        address _token,
        address _to,
        uint256 _amount
    ) external onlyOwner {
        require(
            _to != address(0),
            "Cannot retrieve tokens to the zero address"
        );

        if (_token == address(0)) {
            payable(_to).transfer(_amount);
        } else {
            IERC20Upgradeable(_token).safeTransfer(_to, _amount);
        }
    }

    /// @notice Quotes the cost using stored executor parameters
    /// @dev Must call setExecutorParameters() first with real signed quote
    /// @return cost Total cost for the transfer using stored parameters
    function quoteFinalizeDeposit() external view returns (uint256 cost) {
        require(
            executorParametersSet,
            "Must call setExecutorParameters() first with real signed quote"
        );

        // Extract destination chain from stored executor parameters
        // We'll use the default chain since we don't have the receiver encoded in stored params
        uint16 defaultChain = _getDefaultSupportedChain();
        require(defaultChain != 0, "No supported chains configured");

        return
            nttManagerWithExecutor.quoteDeliveryPrice(
                underlyingNttManager,
                defaultChain,
                "", // Empty transceiver instructions for basic transfer
                storedExecutorArgs,
                storedFeeArgs
            );
    }

    /// @notice Sets executor parameters for the next finalizeDeposit call
    /// @param executorArgs Real executor arguments with valid signed quote from Wormhole Executor API
    /// @param feeArgs Fee arguments for the executor service
    /// @dev Must be called before finalizeDeposit() to provide real signed quote
    function setExecutorParameters(
        ExecutorArgs memory executorArgs,
        FeeArgs memory feeArgs
    ) external {
        // CRITICAL: Validate that we have a real signed quote
        require(
            executorArgs.signedQuote.length > 0,
            "Real signed quote from Wormhole Executor API is required"
        );
        _validateSignedQuote(executorArgs.signedQuote);

        // Store the parameters for use in finalizeDeposit
        storedExecutorArgs = executorArgs;
        storedFeeArgs = feeArgs;
        executorParametersSet = true;

        emit ExecutorParametersSet(
            msg.sender,
            executorArgs.signedQuote.length,
            executorArgs.value
        );
    }

    /// @notice Quotes the cost for a specific destination chain using stored executor parameters
    /// @param _destinationChain Wormhole chain ID of the destination
    /// @return cost Total cost for the transfer to the specified chain
    function quoteFinalizeDeposit(uint16 _destinationChain)
        external
        view
        returns (uint256 cost)
    {
        require(
            executorParametersSet,
            "Must call setExecutorParameters() first with real signed quote"
        );
        require(
            supportedChains[_destinationChain],
            "Destination chain not supported"
        );

        return
            nttManagerWithExecutor.quoteDeliveryPrice(
                underlyingNttManager,
                _destinationChain,
                "", // Empty transceiver instructions for basic transfer
                storedExecutorArgs,
                storedFeeArgs
            );
    }

    /// @notice Clears stored executor parameters
    /// @dev Called automatically after successful transfer or can be called manually
    function clearExecutorParameters() external {
        delete storedExecutorArgs;
        delete storedFeeArgs;
        executorParametersSet = false;
    }

    /// @notice Checks if executor parameters have been set
    /// @return isSet True if executor parameters are set and ready for finalizeDeposit
    function areExecutorParametersSet() external view returns (bool isSet) {
        return executorParametersSet;
    }

    /// @notice Gets the stored executor value (for informational purposes)
    /// @return value The executor value in wei, or 0 if not set
    function getStoredExecutorValue() external view returns (uint256 value) {
        return executorParametersSet ? storedExecutorArgs.value : 0;
    }

    /// @notice Transfers tBTC using NTT Manager With Executor for automatic destination execution
    /// @dev Uses stored executor parameters set via setExecutorParameters()
    /// @param amount Amount of tBTC to transfer
    /// @param destinationChainReceiver Encoded receiver data with chain ID and recipient
    function _transferTbtc(uint256 amount, bytes32 destinationChainReceiver)
        internal
        override
    {
        require(
            executorParametersSet,
            "Must call setExecutorParameters() first with real signed quote"
        );

        // Use stored executor parameters
        _transferTbtcWithExecutor(
            amount,
            destinationChainReceiver,
            storedExecutorArgs,
            storedFeeArgs
        );

        // Clear parameters after use to prevent reuse
        delete storedExecutorArgs;
        delete storedFeeArgs;
        executorParametersSet = false;
    }

    /// @notice Enhanced transfer function that requires real executor parameters
    /// @param amount Amount of tBTC to transfer
    /// @param destinationChainReceiver Encoded receiver data with chain ID and recipient
    /// @param executorArgs Real executor arguments with valid signed quote
    /// @param feeArgs Fee arguments for the executor
    function _transferTbtcWithExecutor(
        uint256 amount,
        bytes32 destinationChainReceiver,
        ExecutorArgs memory executorArgs,
        FeeArgs memory feeArgs
    ) internal {
        // External calls are to trusted contracts (tbtcToken, nttManagerWithExecutor)
        // Event emission after external calls is correct pattern
        require(amount > 0, "Amount must be greater than 0");

        // Extract destination chain and recipient
        uint16 destinationChain = _getDestinationChainFromReceiver(
            destinationChainReceiver
        );
        require(
            supportedChains[destinationChain],
            "Destination chain not supported"
        );

        bytes32 actualRecipient = _getRecipientAddressFromReceiver(
            destinationChainReceiver
        );

        // CRITICAL: Validate that we have a real signed quote
        require(
            executorArgs.signedQuote.length > 0,
            "Real signed quote from Wormhole Executor API is required"
        );
        _validateSignedQuote(executorArgs.signedQuote);

        // Approve the NttManagerWithExecutor to spend tBTC
        // slither-disable-next-line reentrancy-vulnerabilities-3
        tbtcToken.safeIncreaseAllowance(
            address(nttManagerWithExecutor),
            amount
        );

        // Execute the transfer with executor support
        // slither-disable-next-line reentrancy-vulnerabilities-3
        uint64 sequence = nttManagerWithExecutor.transfer{value: msg.value}(
            underlyingNttManager,
            amount,
            destinationChain,
            actualRecipient,
            bytes32(uint256(uint160(msg.sender))), // refundAddress as bytes32
            "", // Empty transceiver instructions for basic transfer
            executorArgs,
            feeArgs
        );

        emit TokensTransferredNttWithExecutor(
            amount,
            destinationChain,
            actualRecipient,
            sequence,
            destinationChainReceiver,
            msg.value
        );
    }

    /// @notice Extract destination chain from encoded receiver address
    /// @param destinationChainReceiver Encoded receiver with chain ID in first 2 bytes
    /// @return chainId The destination chain ID
    function _getDestinationChainFromReceiver(bytes32 destinationChainReceiver)
        internal
        view
        returns (uint16 chainId)
    {
        chainId = uint16(bytes2(destinationChainReceiver));

        // CRITICAL: No fallback to default chain - user must specify valid chain
        if (chainId == 0) {
            revert("Chain ID cannot be zero");
        }

        if (!supportedChains[chainId]) {
            revert(
                string(
                    abi.encodePacked(
                        "Chain ",
                        _uint16ToString(chainId),
                        " not supported"
                    )
                )
            );
        }

        return chainId;
    }

    /// @notice Convert uint16 to string for error messages
    /// @param value The uint16 value to convert
    /// @return str The string representation
    function _uint16ToString(uint16 value)
        internal
        pure
        returns (string memory str)
    {
        if (value == 0) {
            return "0";
        }

        uint16 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }

        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }

        return string(buffer);
    }

    /// @notice Get the default supported chain ID
    /// @return chainId The default supported chain ID
    function _getDefaultSupportedChain()
        internal
        view
        returns (uint16 chainId)
    {
        return defaultSupportedChain;
    }

    /// @notice Extract recipient address from encoded receiver data
    /// @param destinationChainReceiver Encoded receiver data
    /// @return recipient The recipient address (last 30 bytes, padded to 32 bytes)
    function _getRecipientAddressFromReceiver(bytes32 destinationChainReceiver)
        internal
        pure
        returns (bytes32 recipient)
    {
        return
            bytes32(
                uint256(destinationChainReceiver) &
                    0x0000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF
            );
    }

    /// @notice Validates the format of a signed quote from Wormhole Executor API
    /// @param signedQuote The signed quote bytes to validate
    /// @dev This function validates basic format requirements of the executor quote
    /// @notice Basic validation of signed quote from Wormhole Executor API
    /// @param signedQuote The signed quote bytes to validate
    /// @dev Keep validation minimal - NttManagerWithExecutor handles detailed validation
    function _validateSignedQuote(bytes memory signedQuote) internal pure {
        require(signedQuote.length > 0, "Signed quote cannot be empty");
        require(signedQuote.length >= 32, "Signed quote too short");
    }

    /// @notice Utility function to encode destination chain and recipient
    /// @param chainId Wormhole chain ID of the destination
    /// @param recipient Recipient address on the destination chain
    /// @return encoded The encoded receiver data
    function encodeDestinationReceiver(uint16 chainId, address recipient)
        external
        pure
        returns (bytes32 encoded)
    {
        return bytes32((uint256(chainId) << 240) | uint256(uint160(recipient)));
    }

    /// @notice Utility function to decode destination chain and recipient
    /// @param encodedReceiver The encoded receiver data
    /// @return chainId The destination chain ID
    /// @return recipient The recipient address
    function decodeDestinationReceiver(bytes32 encodedReceiver)
        external
        pure
        returns (uint16 chainId, address recipient)
    {
        chainId = uint16(bytes2(encodedReceiver));
        recipient = address(
            uint160(
                uint256(encodedReceiver) &
                    0x0000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF
            )
        );
    }
}
