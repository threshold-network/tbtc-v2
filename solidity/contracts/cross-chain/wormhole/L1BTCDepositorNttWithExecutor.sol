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

import "../AbstractL1BTCDepositorV2.sol";
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

/// @notice NTT Manager interface for basic cross-chain transfers
/// @dev Interface for the underlying NTT Manager contract
interface INttManager {
    /// @notice Quote the delivery price for a given recipient chain transfer
    /// @param recipientChain The Wormhole chain ID of the target chain
    /// @param transceiverInstructions Additional instructions for transceivers
    /// @return priceQuotes Array of individual transceiver price quotes
    /// @return totalPrice Total price for the transfer
    function quoteDeliveryPrice(
        uint16 recipientChain,
        bytes memory transceiverInstructions
    ) external view returns (uint256[] memory priceQuotes, uint256 totalPrice);
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
// slither-disable-next-line reentrancy-vulnerabilities-3
contract L1BTCDepositorNttWithExecutor is AbstractL1BTCDepositorV2 {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @notice Executor parameter set with metadata for nonce-based storage
    struct ExecutorParameterSet {
        ExecutorArgs executorArgs;
        FeeArgs feeArgs;
        address user;
        uint256 timestamp;
        bool exists;
    }

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

    /// @notice Default TBTC platform fee in basis points
    /// @dev Default is 0 (no fee). 100 = 0.1% (100/100000)
    uint16 public defaultPlatformFeeBps;

    /// @notice Default platform fee recipient address
    /// @dev Address to receive TBTC platform fees
    address public defaultPlatformFeeRecipient;

    /// @notice Maximum basis points value (100%)
    /// @dev NttManagerWithExecutor uses 100000 as divisor, so 100% = 10000 dbps
    uint16 public constant MAX_BPS = 10000;

    /// @notice Default destination gas limit for execution (500k gas)
    uint256 private constant DEFAULT_DESTINATION_GAS_LIMIT = 500000;

    /// @notice Default executor fee in basis points
    /// @dev Used when no specific fee is configured (e.g., 100 = 1%)
    uint16 public defaultExecutorFeeBps;

    /// @notice Default executor fee recipient
    address public defaultExecutorFeeRecipient;

    /// @notice Mapping of nonce to executor parameter sets for parallel user support
    mapping(bytes32 => ExecutorParameterSet) private parametersByNonce;

    /// @notice Mapping of user address to their current nonce sequence counter
    mapping(address => uint256) private userNonceCounter;

    /// @notice Parameter expiration time in seconds (default: 1 hour)
    uint256 public parameterExpirationTime;

    /// @notice Emitted when executor parameters are set
    /// @param sender Address that set the parameters
    /// @param signedQuoteLength Length of the signed quote in bytes
    /// @param executorValue Value in wei for executor service
    event ExecutorParametersSet(
        address indexed sender,
        bytes32 indexed nonce,
        uint256 signedQuoteLength,
        uint256 executorValue
    );

    /// @notice Emitted when executor parameters are refreshed by the same user
    /// @param sender Address of the user refreshing parameters
    /// @param nonce Unique nonce hash for these parameters
    /// @param signedQuoteLength Length of the signed quote in bytes
    /// @param executorValue Value in wei for executor service
    event ExecutorParametersRefreshed(
        address indexed sender,
        bytes32 indexed nonce,
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
        address indexed sender,
        bytes32 indexed nonce,
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

    /// @notice Emitted when the default destination gas limit is updated
    event DefaultDestinationGasLimitUpdated(
        uint256 indexed oldGasLimit,
        uint256 indexed newGasLimit
    );

    /// @notice Emitted when the default platform fee basis points is updated
    event DefaultPlatformFeeBpsUpdated(
        uint16 indexed oldFeeBps,
        uint16 indexed newFeeBps
    );

    /// @notice Emitted when the default platform fee recipient is updated
    event DefaultPlatformFeeRecipientUpdated(
        address indexed oldRecipient,
        address indexed newRecipient
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
        defaultDestinationGasLimit = DEFAULT_DESTINATION_GAS_LIMIT;
        defaultExecutorFeeBps = 0; // 0% executor fee by default
        defaultExecutorFeeRecipient = address(0); // No fee recipient by default
        defaultPlatformFeeBps = 0; // 0% platform fee by default
        defaultPlatformFeeRecipient = 0x9F6e831c8F8939DC0C830C6e492e7cEf4f9C2F5f; // Threshold Committee wallet
        parameterExpirationTime = 3600; // 1 hour default expiration time
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
    function setSupportedChain(
        uint16 _chainId,
        bool _supported
    ) external onlyOwner {
        require(_chainId != 0, "Chain ID cannot be zero");
        supportedChains[_chainId] = _supported;
        emit SupportedChainUpdated(_chainId, _supported);
    }

    /// @notice Updates default parameters for executor transfers
    /// @param _gasLimit Default gas limit for destination chain execution
    /// @param _feeBps Default executor fee in basis points (max 10000 = 100%)
    /// @param _feeRecipient Default executor fee recipient
    /// @param _platformFeeBps Default TBTC platform fee in basis points (max 10000 = 100%)
    /// @param _platformFeeRecipient Default TBTC platform fee recipient
    function setDefaultParameters(
        uint256 _gasLimit,
        uint16 _feeBps,
        address _feeRecipient,
        uint16 _platformFeeBps,
        address _platformFeeRecipient
    ) external onlyOwner {
        require(_feeBps <= MAX_BPS, "Fee cannot exceed 100% (10000 bps)");
        require(
            _platformFeeBps <= MAX_BPS,
            "Platform fee cannot exceed 100% (10000 bps)"
        );
        require(
            _feeRecipient != address(0) || _feeBps == 0,
            "Fee recipient cannot be zero when fee is set"
        );
        require(
            _platformFeeRecipient != address(0) || _platformFeeBps == 0,
            "Platform fee recipient cannot be zero when platform fee is set"
        );
        defaultDestinationGasLimit = _gasLimit;
        defaultExecutorFeeBps = _feeBps;
        defaultExecutorFeeRecipient = _feeRecipient;
        defaultPlatformFeeBps = _platformFeeBps;
        defaultPlatformFeeRecipient = _platformFeeRecipient;

        emit DefaultParametersUpdated(_gasLimit, _feeBps, _feeRecipient);
    }

    /// @notice Updates the default destination gas limit
    /// @param _newGasLimit New default gas limit for destination chain execution
    function setDefaultDestinationGasLimit(
        uint256 _newGasLimit
    ) external onlyOwner {
        require(_newGasLimit > 0, "Gas limit must be greater than zero");
        uint256 oldGasLimit = defaultDestinationGasLimit;
        defaultDestinationGasLimit = _newGasLimit;
        emit DefaultDestinationGasLimitUpdated(oldGasLimit, _newGasLimit);
    }

    /// @notice Sets the default TBTC platform fee in basis points
    /// @param _newFeeBps New default platform fee in basis points (100 = 0.1%)
    function setDefaultPlatformFeeBps(uint16 _newFeeBps) external onlyOwner {
        require(_newFeeBps <= MAX_BPS, "Fee cannot exceed 100% (10000 bps)");
        uint16 oldFeeBps = defaultPlatformFeeBps;
        defaultPlatformFeeBps = _newFeeBps;
        emit DefaultPlatformFeeBpsUpdated(oldFeeBps, _newFeeBps);
    }

    /// @notice Sets the default platform fee recipient address
    /// @param _newRecipient New platform fee recipient address
    function setDefaultPlatformFeeRecipient(
        address _newRecipient
    ) external onlyOwner {
        require(
            _newRecipient != address(0) || defaultPlatformFeeBps == 0,
            "Recipient address cannot be zero when platform fee is set"
        );
        address oldRecipient = defaultPlatformFeeRecipient;
        defaultPlatformFeeRecipient = _newRecipient;
        emit DefaultPlatformFeeRecipientUpdated(oldRecipient, _newRecipient);
    }

    /// @notice Updates the underlying NTT Manager address
    /// @param _newNttManager New underlying NTT Manager address
    function updateUnderlyingNttManager(
        address _newNttManager
    ) external onlyOwner {
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
    function updateNttManagerWithExecutor(
        address _newNttManagerWithExecutor
    ) external onlyOwner {
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
            // Use call instead of transfer for better error handling and gas efficiency
            // solhint-disable-next-line avoid-low-level-calls
            (bool success, ) = payable(_to).call{value: _amount}("");
            require(success, "Failed to transfer native token");
        } else {
            IERC20Upgradeable(_token).safeTransfer(_to, _amount);
        }
    }

    /// @notice Sets executor parameters and returns the nonce for reference
    /// @param executorArgs Real executor arguments with valid signed quote from Wormhole Executor API
    /// @param feeArgs Fee arguments for the executor service
    /// @return nonce The nonce hash for these parameters (for informational purposes)
    /// @dev Must be called before finalizeDeposit() to provide real signed quote
    function setExecutorParameters(
        ExecutorArgs memory executorArgs,
        FeeArgs memory feeArgs
    ) external returns (bytes32 nonce) {
        // CRITICAL: Validate that we have a real signed quote
        require(
            executorArgs.signedQuote.length > 0,
            "Real signed quote from Wormhole Executor API is required"
        );
        _validateSignedQuoteFormat(executorArgs.signedQuote);

        // Validate fee basis points
        require(feeArgs.dbps <= MAX_BPS, "Fee cannot exceed 100% (10000 bps)");
        require(
            feeArgs.dbps >= defaultPlatformFeeBps,
            "Fee must be at least the default platform fee"
        );

        // FEE THEFT VULNERABILITY FIX: Validate fee payee to prevent deposit theft
        // Fee payee must match the protocol-controlled platform fee recipient
        // Exception: If platform fee is zero, payee can be zero address
        if (defaultPlatformFeeBps > 0) {
            require(
                feeArgs.payee == defaultPlatformFeeRecipient,
                "Fee payee must match default platform fee recipient"
            );
        } else {
            // When platform fee is zero, allow zero address
            require(
                feeArgs.payee == defaultPlatformFeeRecipient ||
                    feeArgs.payee == address(0),
                "Fee payee must match default platform fee recipient or be zero"
            );
        }

        // SAFETY CHECK: Handle existing parameters - allow refresh or prevent new workflow
        if (userNonceCounter[msg.sender] > 0) {
            bytes32 latestNonce = _generateNonce(
                msg.sender,
                userNonceCounter[msg.sender] - 1
            );
            ExecutorParameterSet storage existingParams = parametersByNonce[
                latestNonce
            ];

            if (existingParams.exists) {
                // Check if parameters have expired
                // solhint-disable-next-line not-rely-on-time
                bool expired = block.timestamp >
                    existingParams.timestamp + parameterExpirationTime;

                if (!expired) {
                    // Allow refreshing existing parameters (same user, same nonce)
                    existingParams.executorArgs = executorArgs;
                    existingParams.feeArgs = feeArgs;
                    // PARAMETER VALIDATION FIX: Do NOT refresh timestamp to prevent artificially
                    // extending quote validity beyond Wormhole Executor's intended expiration
                    // Keep original timestamp for accurate expiration tracking

                    emit ExecutorParametersRefreshed(
                        msg.sender,
                        latestNonce,
                        executorArgs.signedQuote.length,
                        executorArgs.value
                    );

                    return latestNonce; // Return existing nonce
                }
            }
        }

        // Generate nonce for this user's current sequence
        uint256 currentSequence = userNonceCounter[msg.sender];
        nonce = _generateNonce(msg.sender, currentSequence);

        // Increment sequence for next time
        userNonceCounter[msg.sender] = currentSequence + 1;

        // Store parameters with metadata
        parametersByNonce[nonce] = ExecutorParameterSet({
            executorArgs: executorArgs,
            feeArgs: feeArgs,
            user: msg.sender,
            timestamp: block.timestamp, // solhint-disable-line not-rely-on-time
            exists: true
        });

        emit ExecutorParametersSet(
            msg.sender,
            nonce,
            executorArgs.signedQuote.length,
            executorArgs.value
        );

        return nonce; // Return for informational purposes
    }

    /// @notice Clears the latest executor parameters for msg.sender
    /// @dev Users can clear their own latest parameters if needed
    function clearExecutorParameters() external {
        // Allow clearing even when no parameters are set (backward compatibility)
        if (userNonceCounter[msg.sender] == 0) {
            return; // Nothing to clear
        }

        bytes32 latestNonce = _generateNonce(
            msg.sender,
            userNonceCounter[msg.sender] - 1
        );

        ExecutorParameterSet storage params = parametersByNonce[latestNonce];
        if (params.exists) {
            delete parametersByNonce[latestNonce];
        }
        // If parameters don't exist, that's fine - already cleared
    }

    /// @notice Sets the parameter expiration time (owner only)
    /// @param newExpirationTime New expiration time in seconds
    function setParameterExpirationTime(
        uint256 newExpirationTime
    ) external onlyOwner {
        require(
            newExpirationTime > 0,
            "Expiration time must be greater than 0"
        );
        parameterExpirationTime = newExpirationTime;
    }

    /// @notice Quotes cost using the latest parameters for msg.sender
    /// @return cost Total cost for the transfer
    function quoteFinalizeDeposit() external view returns (uint256 cost) {
        require(
            userNonceCounter[msg.sender] > 0,
            "Executor parameters not set"
        );

        bytes32 latestNonce = _generateNonce(
            msg.sender,
            userNonceCounter[msg.sender] - 1
        );

        ExecutorParameterSet storage params = parametersByNonce[latestNonce];
        require(params.exists, "Executor parameters not set");

        uint16 defaultChain = _getDefaultSupportedChain();
        require(defaultChain != 0, "No supported chains configured");

        // INCOMPATIBILITY FIX (MB-M2): Query underlying NTT manager directly
        // The deployed NttManagerWithExecutor doesn't expose quoteDeliveryPrice()
        INttManager nttManager = INttManager(underlyingNttManager);
        (, uint256 nttDeliveryPrice) = nttManager.quoteDeliveryPrice(
            defaultChain,
            "" // Empty transceiver instructions for basic transfer
        );

        return nttDeliveryPrice + params.executorArgs.value;
    }

    /// @notice Quotes cost for specific destination chain using latest parameters
    /// @param destinationChain Target chain ID
    /// @return cost Total cost for the transfer
    function quoteFinalizeDeposit(
        uint16 destinationChain
    ) external view returns (uint256 cost) {
        require(
            userNonceCounter[msg.sender] > 0,
            "Executor parameters not set"
        );
        require(
            supportedChains[destinationChain],
            "Destination chain not supported"
        );

        bytes32 latestNonce = _generateNonce(
            msg.sender,
            userNonceCounter[msg.sender] - 1
        );

        ExecutorParameterSet storage params = parametersByNonce[latestNonce];
        require(params.exists, "Executor parameters not set");

        // INCOMPATIBILITY FIX (MB-M2): Query underlying NTT manager directly
        // The deployed NttManagerWithExecutor doesn't expose quoteDeliveryPrice()
        INttManager nttManager = INttManager(underlyingNttManager);
        (, uint256 nttDeliveryPrice) = nttManager.quoteDeliveryPrice(
            destinationChain,
            "" // Empty transceiver instructions for basic transfer
        );

        return nttDeliveryPrice + params.executorArgs.value;
    }

    /// @notice Quotes the underlying NTT delivery price and total cost including executor fees
    /// @param destinationChain Target chain ID
    /// @return nttDeliveryPrice The NTT delivery price from the underlying manager
    /// @return executorCost The executor cost from the signed quote
    /// @return totalCost The total cost (NTT + executor)
    /// @dev This function calls the underlying NTT manager's quoteDeliveryPrice and returns
    ///      the breakdown of costs. The caller should validate that their msg.value >= totalCost
    function quoteFinalizedDeposit(
        uint16 destinationChain
    )
        external
        view
        returns (
            uint256 nttDeliveryPrice,
            uint256 executorCost,
            uint256 totalCost
        )
    {
        require(
            userNonceCounter[msg.sender] > 0,
            "Executor parameters not set"
        );
        require(
            supportedChains[destinationChain],
            "Destination chain not supported"
        );

        bytes32 latestNonce = _generateNonce(
            msg.sender,
            userNonceCounter[msg.sender] - 1
        );

        ExecutorParameterSet storage params = parametersByNonce[latestNonce];
        require(params.exists, "Executor parameters not set");

        // Get NTT delivery price from underlying manager
        INttManager nttManager = INttManager(underlyingNttManager);
        (, nttDeliveryPrice) = nttManager.quoteDeliveryPrice(
            destinationChain,
            "" // Empty transceiver instructions for basic transfer
        );

        // Get executor cost from the signed quote (value field)
        executorCost = params.executorArgs.value;

        // Calculate total cost
        totalCost = nttDeliveryPrice + executorCost;
    }

    /// @notice Checks if the current user has executor parameters set
    /// @return isSet True if parameters are set and ready for finalizeDeposit
    /// @return nonce The nonce of the latest parameters (if set)
    function areExecutorParametersSet()
        external
        view
        returns (bool isSet, bytes32 nonce)
    {
        if (userNonceCounter[msg.sender] == 0) {
            return (false, bytes32(0));
        }

        nonce = _generateNonce(msg.sender, userNonceCounter[msg.sender] - 1);
        ExecutorParameterSet storage params = parametersByNonce[nonce];

        return (params.exists, nonce);
    }

    /// @notice Gets the stored executor value for the latest parameters
    /// @return value The executor value in wei, or 0 if not set
    function getStoredExecutorValue() external view returns (uint256 value) {
        if (userNonceCounter[msg.sender] == 0) {
            return 0;
        }

        bytes32 latestNonce = _generateNonce(
            msg.sender,
            userNonceCounter[msg.sender] - 1
        );

        ExecutorParameterSet storage params = parametersByNonce[latestNonce];
        return params.exists ? params.executorArgs.value : 0;
    }

    /// @notice Checks if a user has an active workflow (parameters set but not used)
    /// @param user The user address to check
    /// @return hasActiveWorkflow True if user has parameters set and ready for transfer
    /// @return nonce The nonce of the active workflow (if any)
    /// @return timestamp When the parameters were set
    function getUserWorkflowStatus(
        address user
    )
        external
        view
        returns (bool hasActiveWorkflow, bytes32 nonce, uint256 timestamp)
    {
        if (userNonceCounter[user] == 0) {
            return (false, bytes32(0), 0);
        }

        nonce = _generateNonce(user, userNonceCounter[user] - 1);
        ExecutorParameterSet storage params = parametersByNonce[nonce];

        if (!params.exists) {
            return (false, bytes32(0), 0);
        }

        // Check if parameters have expired
        // solhint-disable-next-line not-rely-on-time
        bool expired = block.timestamp >
            params.timestamp + parameterExpirationTime;

        return (!expired, nonce, params.timestamp);
    }

    /// @notice Checks if a user can start a new workflow (no active workflow exists)
    /// @param user The user address to check
    /// @return canStart True if user can start a new workflow
    function canUserStartNewWorkflow(
        address user
    ) external view returns (bool canStart) {
        if (userNonceCounter[user] == 0) {
            return true;
        }

        bytes32 latestNonce = _generateNonce(user, userNonceCounter[user] - 1);
        ExecutorParameterSet storage params = parametersByNonce[latestNonce];

        if (!params.exists) {
            return true;
        }

        // Check if parameters have expired
        // solhint-disable-next-line not-rely-on-time
        bool expired = block.timestamp >
            params.timestamp + parameterExpirationTime;

        return expired;
    }

    /// @notice Gets comprehensive workflow information for a user (UI helper)
    /// @param user The user address to check
    /// @return hasActiveWorkflow True if user has an active workflow
    /// @return nonce The nonce of the active workflow (if any)
    /// @return timestamp When the parameters were set
    /// @return timeRemaining Seconds until expiration (0 if expired or no workflow)
    function getUserWorkflowInfo(
        address user
    )
        external
        view
        returns (
            bool hasActiveWorkflow,
            bytes32 nonce,
            uint256 timestamp,
            uint256 timeRemaining
        )
    {
        if (userNonceCounter[user] == 0) {
            return (false, bytes32(0), 0, 0);
        }

        nonce = _generateNonce(user, userNonceCounter[user] - 1);
        ExecutorParameterSet storage params = parametersByNonce[nonce];

        if (!params.exists) {
            return (false, bytes32(0), 0, 0);
        }

        timestamp = params.timestamp;
        uint256 expirationTime = timestamp + parameterExpirationTime;

        // Check if parameters have expired
        // solhint-disable-next-line not-rely-on-time
        bool expired = block.timestamp > expirationTime;

        if (expired) {
            return (false, nonce, timestamp, 0);
        }

        // solhint-disable-next-line not-rely-on-time
        timeRemaining = expirationTime - block.timestamp;
        return (true, nonce, timestamp, timeRemaining);
    }

    /// @notice Transfers tBTC using NTT Manager With Executor for automatic destination execution
    /// @dev Uses the latest executor parameters for msg.sender (auto-nonce approach)
    /// @param amount Amount of tBTC to transfer
    /// @param destinationChainReceiver Encoded receiver data with chain ID and recipient
    function _transferTbtc(
        uint256 amount,
        bytes32 destinationChainReceiver
    ) internal override {
        require(
            userNonceCounter[msg.sender] > 0,
            "Executor parameters not set"
        );

        // Calculate the latest nonce for this user
        bytes32 latestNonce = _generateNonce(
            msg.sender,
            userNonceCounter[msg.sender] - 1 // Most recent sequence
        );

        ExecutorParameterSet storage params = parametersByNonce[latestNonce];
        require(params.exists, "Executor parameters not set");

        // Optional: Add expiration check
        require(
            block.timestamp <= params.timestamp + parameterExpirationTime, // solhint-disable-line not-rely-on-time
            "Executor parameters expired"
        );

        // Call internal transfer with stored parameters
        _transferTbtcWithExecutor(
            amount,
            destinationChainReceiver,
            params.executorArgs,
            params.feeArgs,
            latestNonce
        );

        // Clear parameters after use to prevent reuse
        delete parametersByNonce[latestNonce];
    }

    /// @notice Enhanced transfer function that requires real executor parameters
    /// @param amount Amount of tBTC to transfer
    /// @param destinationChainReceiver Encoded receiver data with chain ID and recipient
    /// @param executorArgs Real executor arguments with valid signed quote
    /// @param feeArgs Fee arguments for the executor
    /// @param nonce The nonce used for this transfer
    // slither-disable-next-line reentrancy-vulnerabilities-3
    function _transferTbtcWithExecutor(
        uint256 amount,
        bytes32 destinationChainReceiver,
        ExecutorArgs memory executorArgs,
        FeeArgs memory feeArgs,
        bytes32 nonce
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
        _validateSignedQuoteFormat(executorArgs.signedQuote);
        
        // PARAMETER VALIDATION FIX: Validate embedded expiry time
        _validateAndExtractQuoteExpiry(executorArgs.signedQuote);

        // PARAMETER VALIDATION FIX: Validate total payment includes executor cost + NTT delivery price
        {
            (, uint256 nttDeliveryPrice) = INttManager(underlyingNttManager)
                .quoteDeliveryPrice(destinationChain, "");
            require(
                msg.value >= executorArgs.value + nttDeliveryPrice,
                "Insufficient payment for executor service and NTT delivery"
            );
        }

        // Approve the NttManagerWithExecutor to spend tBTC
        tbtcToken.safeIncreaseAllowance( // slither-disable-line reentrancy-vulnerabilities-3
            address(nttManagerWithExecutor),
            amount
        );

        // Execute the transfer with executor support
        uint64 sequence = nttManagerWithExecutor.transfer{value: msg.value}( // slither-disable-line reentrancy-vulnerabilities-3
            underlyingNttManager,
            amount,
            destinationChain,
            actualRecipient,
            bytes32(uint256(uint160(msg.sender))), // refundAddress as bytes32
            "", // Empty transceiver instructions for basic transfer
            executorArgs,
            feeArgs
        );

        emit TokensTransferredNttWithExecutor( // slither-disable-line reentrancy-vulnerabilities-3
            msg.sender,
            nonce,
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
    function _getDestinationChainFromReceiver(
        bytes32 destinationChainReceiver
    ) internal view returns (uint16 chainId) {
        chainId = uint16(bytes2(destinationChainReceiver));

        // CRITICAL: No fallback to default chain - user must specify valid chain
        if (chainId == 0) {
            revert("Chain ID cannot be zero");
        }

        if (!supportedChains[chainId]) {
            revert("Destination chain not supported");
        }

        return chainId;
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
    function _getRecipientAddressFromReceiver(
        bytes32 destinationChainReceiver
    ) internal pure returns (bytes32 recipient) {
        return
            bytes32(
                uint256(destinationChainReceiver) &
                    0x0000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF
            );
    }

    /// @notice Validates the format of a signed quote from Wormhole Executor API
    /// @param signedQuote The signed quote bytes to validate
    /// @dev Keep validation minimal - NttManagerWithExecutor handles detailed validation
    function _validateSignedQuoteFormat(
        bytes memory signedQuote
    ) internal pure {
        require(signedQuote.length > 0, "Signed quote cannot be empty");
        require(signedQuote.length >= 32, "Signed quote too short");
    }

    /// @notice Extracts and validates the embedded expiry time from a signed quote
    /// @param signedQuote The signed quote bytes from Wormhole Executor API
    /// @dev The expiry timestamp is embedded at byte offset 60 in the signed quote
    function _validateAndExtractQuoteExpiry(
        bytes memory signedQuote
    ) internal view returns (uint64 quoteExpiry) {
        require(signedQuote.length >= 92, "Signed quote too short for expiry extraction");
        
        // Extract expiry timestamp from signed quote (at byte offset 60)
        assembly {
            // signedQuote in memory: [length (32 bytes)][data...]
            // Byte offset 60 in data = 60 + 32 (length prefix) = 92
            quoteExpiry := mload(add(signedQuote, 92))
            // Shift right to get the actual uint64 value (8 bytes)
            quoteExpiry := shr(192, quoteExpiry)
        }
        
        // solhint-disable-next-line not-rely-on-time
        require(
            quoteExpiry > block.timestamp,
            "Signed quote expired - embedded expiry time has passed"
        );
    }

    /// @notice Generates a unique nonce for a user's parameter set
    /// @param user The user address
    /// @param sequence The sequence number for this user
    /// @return nonce A unique nonce hash
    function _generateNonce(
        address user,
        uint256 sequence
    ) internal pure returns (bytes32 nonce) {
        return keccak256(abi.encodePacked(user, sequence));
    }
}
