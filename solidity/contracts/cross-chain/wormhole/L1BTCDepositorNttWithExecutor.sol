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
/// @dev Used to specify tBTC-denominated platform fees.
struct FeeArgs {
    /// @notice Fee in executor dbps units (100 = 0.1%)
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

    /// @notice Quote the total cost for a transfer including executor wrapper costs
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
/// - Requires executor quotes and platform fee configuration
/// - Supports automatic destination chain execution
/// - Handles executor costs, platform fees, and destination gas
/// - Provides better UX by eliminating manual claim steps
///
/// @dev Executor Integration:
/// - Fetches signed quotes from Wormhole Executor API
/// - Configures gas limits for destination chain execution
/// - Handles executor payments and gas refunds
/// - Provides refund mechanisms for unused gas
// slither-disable-next-line reentrancy-vulnerabilities-3
contract L1BTCDepositorNttWithExecutor is AbstractL1BTCDepositor {
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

    /// @dev Retains the storage slot used by the previous `supportedChains`
    ///      mapping for compatibility with ERC1967 proxy upgrades.
    // slither-disable-next-line unused-state
    mapping(uint16 => bool) private __deprecatedSupportedChains;

    /// @notice Wormhole chain ID of the configured destination chain.
    /// @dev Stored in the slot previously used by `defaultSupportedChain`.
    uint16 public destinationChainId;

    /// @notice Default gas limit for destination chain execution
    /// @dev Used when no specific gas limit is provided in relay instructions
    uint256 public defaultDestinationGasLimit;

    /// @notice Default TBTC platform fee in executor dbps units
    /// @dev Default is 0 (no fee). 100 = 0.1% (100/100000)
    uint16 public defaultPlatformFeeDbps;

    /// @notice Default platform fee recipient address
    /// @dev Address to receive TBTC platform fees
    address public defaultPlatformFeeRecipient;

    /// @notice Maximum platform fee in executor dbps units
    /// @dev NttManagerWithExecutor uses 100000 as divisor, so 10000 = 10%
    uint16 public constant MAX_PLATFORM_FEE_DBPS = 10000;

    /// @notice Default destination gas limit for execution (500k gas)
    uint256 private constant DEFAULT_DESTINATION_GAS_LIMIT = 500000;

    /// @dev Deprecated storage slot previously used by `defaultExecutorFeeBps`.
    ///      FeeArgs is now reserved for platform fees.
    // slither-disable-next-line unused-state
    uint16 private __deprecatedDefaultExecutorFeeBps;

    /// @dev Deprecated storage slot previously used by `defaultExecutorFeeRecipient`.
    ///      FeeArgs is now reserved for platform fees.
    // slither-disable-next-line unused-state
    address private __deprecatedDefaultExecutorFeeRecipient;

    /// @notice Mapping of nonce to executor parameter sets for parallel user support
    mapping(bytes32 => ExecutorParameterSet) private parametersByNonce;

    /// @notice Mapping of user address to their current nonce sequence counter
    mapping(address => uint256) private userNonceCounter;

    /// @notice Parameter expiration time in seconds (default: 1 hour)
    uint256 public parameterExpirationTime;

    /// @notice Optional destination-chain account that receives refunds of
    ///         unused execution gas from the Wormhole Executor.
    /// @dev Stored in Wormhole's 32-byte universal address format. When left
    ///      unset (`bytes32(0)`), refunds fall back to the deposit recipient so
    ///      they are always deliverable on the destination chain, including
    ///      non-EVM chains (Solana, Sui) where a left-padded EVM address is not
    ///      a controllable account. Owners can point it at a dedicated relayer
    ///      or treasury account via `setDestinationRefundAddress`.
    bytes32 public destinationRefundAddress;

    /// @dev Marks deposits initialized after the fixed-destination upgrade.
    ///      Unmarked initialized deposits are treated as legacy NTT deposits
    ///      whose extra data used `[2-byte chain id][30-byte recipient]`.
    mapping(uint256 => bool) public fixedDestinationDeposits;

    uint256 private constant LEGACY_DESTINATION_RECEIVER_MASK = type(uint240)
        .max;

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
    /// @param recipient Recipient address on destination chain
    /// @param transferSequence NTT transfer sequence number
    /// @param transferCost Total native token cost paid for the transfer
    event TokensTransferredNttWithExecutor(
        address indexed sender,
        bytes32 indexed nonce,
        uint256 amount,
        uint16 destinationChain,
        bytes32 recipient,
        uint64 transferSequence,
        uint256 transferCost
    );

    /// @notice Emitted when default parameters are updated
    event DefaultParametersUpdated(
        uint256 gasLimit,
        uint16 platformFeeDbps,
        address platformFeeRecipient
    );

    /// @notice Emitted when the default destination gas limit is updated
    event DefaultDestinationGasLimitUpdated(
        uint256 indexed oldGasLimit,
        uint256 indexed newGasLimit
    );

    /// @notice Emitted when the default platform fee dbps value is updated
    event DefaultPlatformFeeDbpsUpdated(
        uint16 indexed oldFeeDbps,
        uint16 indexed newFeeDbps
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

    /// @notice Emitted when the fixed NTT destination chain is migrated.
    event DestinationChainUpdated(
        uint16 indexed oldDestinationChain,
        uint16 indexed newDestinationChain
    );

    /// @notice Emitted when the destination refund address is updated
    event DestinationRefundAddressUpdated(
        bytes32 indexed oldRefundAddress,
        bytes32 indexed newRefundAddress
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
    /// @param _destinationChainId Wormhole chain ID of the destination chain
    function initialize(
        address _tbtcBridge,
        address _tbtcVault,
        address _nttManagerWithExecutor,
        address _underlyingNttManager,
        uint16 _destinationChainId
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
        require(_destinationChainId != 0, "Chain ID cannot be zero");

        nttManagerWithExecutor = INttManagerWithExecutor(
            _nttManagerWithExecutor
        );
        underlyingNttManager = _underlyingNttManager;
        destinationChainId = _destinationChainId;

        // Set reasonable defaults
        defaultDestinationGasLimit = DEFAULT_DESTINATION_GAS_LIMIT;
        parameterExpirationTime = 3600; // 1 hour default expiration time
    }

    /// @notice Migrates the fixed destination chain during a proxy upgrade.
    /// @param _destinationChainId Wormhole chain ID of the destination chain
    /// @dev Intended as a one-time backfill hook for proxies that were
    ///      initialized before the fixed-destination slot existed and had no
    ///      default destination set. Fresh deployments configure the
    ///      destination during `initialize` and cannot use this hook to
    ///      retarget in-flight deposits.
    function initializeV2DestinationChain(
        uint16 _destinationChainId
    ) external onlyOwner reinitializer(2) {
        require(
            destinationChainId == 0,
            "Destination chain already configured"
        );
        _updateDestinationChain(_destinationChainId);
    }

    /// @notice Updates default parameters for executor transfers
    /// @param _gasLimit Default gas limit for destination chain execution
    /// @param _platformFeeDbps Default TBTC platform fee in executor dbps units
    /// @param _platformFeeRecipient Default TBTC platform fee recipient
    function setDefaultParameters(
        uint256 _gasLimit,
        uint16 _platformFeeDbps,
        address _platformFeeRecipient
    ) external onlyOwner {
        require(_gasLimit > 0, "Gas limit must be greater than zero");
        require(
            _platformFeeDbps <= MAX_PLATFORM_FEE_DBPS,
            "Platform fee exceeds maximum"
        );
        require(
            _platformFeeRecipient != address(0) || _platformFeeDbps == 0,
            "Platform fee recipient cannot be zero when platform fee is set"
        );
        defaultDestinationGasLimit = _gasLimit;
        defaultPlatformFeeDbps = _platformFeeDbps;
        defaultPlatformFeeRecipient = _platformFeeRecipient;

        emit DefaultParametersUpdated(
            _gasLimit,
            _platformFeeDbps,
            _platformFeeRecipient
        );
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

    /// @notice Sets the destination-chain account that receives refunds of
    ///         unused execution gas.
    /// @param _destinationRefundAddress Refund account in Wormhole's 32-byte
    ///        universal address format, or `bytes32(0)` to refund the deposit
    ///        recipient by default.
    /// @dev Use this to point refunds at a controllable account on non-EVM
    ///      destinations, or at a dedicated relayer/treasury account on EVM
    ///      destinations (left-padded EVM address).
    function setDestinationRefundAddress(
        bytes32 _destinationRefundAddress
    ) external onlyOwner {
        bytes32 oldRefundAddress = destinationRefundAddress;
        destinationRefundAddress = _destinationRefundAddress;
        emit DestinationRefundAddressUpdated(
            oldRefundAddress,
            _destinationRefundAddress
        );
    }

    /// @notice Sets the default TBTC platform fee in executor dbps units
    /// @param _newFeeDbps New default platform fee in executor dbps units (100 = 0.1%)
    function setDefaultPlatformFeeDbps(uint16 _newFeeDbps) external onlyOwner {
        require(
            _newFeeDbps <= MAX_PLATFORM_FEE_DBPS,
            "Fee exceeds maximum"
        );
        require(
            defaultPlatformFeeRecipient != address(0) || _newFeeDbps == 0,
            "Recipient address cannot be zero when platform fee is set"
        );
        uint16 oldFeeDbps = defaultPlatformFeeDbps;
        defaultPlatformFeeDbps = _newFeeDbps;
        emit DefaultPlatformFeeDbpsUpdated(oldFeeDbps, _newFeeDbps);
    }

    /// @notice Sets the default platform fee recipient address
    /// @param _newRecipient New platform fee recipient address
    function setDefaultPlatformFeeRecipient(
        address _newRecipient
    ) external onlyOwner {
        require(
            _newRecipient != address(0) || defaultPlatformFeeDbps == 0,
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
    /// @param feeArgs Platform fee arguments
    /// @return nonce The nonce hash for these parameters (for informational purposes)
    /// @dev Must be called before finalizeDeposit() to provide real signed quote.
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

        require(
            executorArgs.refundAddress == msg.sender,
            "Executor refund address must be caller"
        );

        // Validate fee amount in executor dbps units.
        require(
            feeArgs.dbps <= MAX_PLATFORM_FEE_DBPS,
            "Fee exceeds maximum"
        );
        require(
            feeArgs.dbps >= defaultPlatformFeeDbps,
            "Fee must be at least the default platform fee"
        );
        require(
            defaultPlatformFeeRecipient != address(0) || feeArgs.dbps == 0,
            "Platform fee recipient cannot be zero when fee is set"
        );
        feeArgs.payee = defaultPlatformFeeRecipient;

        uint16 chainId = _destinationChain();
        uint256 requiredPayment = nttManagerWithExecutor.quoteDeliveryPrice(
            underlyingNttManager,
            chainId,
            "",
            executorArgs,
            feeArgs
        );
        require(requiredPayment >= executorArgs.value, "Insufficient payment for executor service");
        // Remove one expired entry before minting a new nonce
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
                if (block.timestamp > existingParams.timestamp + parameterExpirationTime) {
                    delete parametersByNonce[latestNonce];
                }
            }
        }

        // SAFETY CHECK: Handle existing parameters - allow refresh or prevent new workflow
        // (Re-using the refresh logic but checking for existence)
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
                    existingParams.executorArgs = executorArgs;
                    existingParams.feeArgs = feeArgs;
                    // solhint-disable-next-line not-rely-on-time
                    existingParams.timestamp = block.timestamp;

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

        uint16 chainId = _destinationChain();
        return
            nttManagerWithExecutor.quoteDeliveryPrice(
                underlyingNttManager,
                chainId,
                "",
                params.executorArgs,
                params.feeArgs
            );
    }

    /// @notice Quotes the underlying NTT delivery price and total cost including executor costs
    /// @return nttDeliveryPrice The NTT delivery price from the underlying manager
    /// @return executorCost Cost charged by the executor wrapper on top of NTT delivery
    /// @return totalCost The exact total cost required by finalizeDeposit
    /// @dev The total is quoted through NttManagerWithExecutor, matching the
    ///      value enforced during finalizeDeposit.
    function quoteFinalizeDepositBreakdown()
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

        bytes32 latestNonce = _generateNonce(
            msg.sender,
            userNonceCounter[msg.sender] - 1
        );

        ExecutorParameterSet storage params = parametersByNonce[latestNonce];
        require(params.exists, "Executor parameters not set");

        uint16 chainId = _destinationChain();

        // Get NTT delivery price from underlying manager
        INttManager nttManager = INttManager(underlyingNttManager);
        (, nttDeliveryPrice) = nttManager.quoteDeliveryPrice(
            chainId,
            "" // Empty transceiver instructions for basic transfer
        );

        totalCost = nttManagerWithExecutor.quoteDeliveryPrice(
            underlyingNttManager,
            chainId,
            "",
            params.executorArgs,
            params.feeArgs
        );

        // Report the wrapper/executor component without assuming it is exactly
        // executorArgs.value; wrappers may add surcharges or aggregate costs.
        executorCost = totalCost > nttDeliveryPrice
            ? totalCost - nttDeliveryPrice
            : 0;
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
    /// @param destinationChainDepositOwner Full 32-byte recipient on the destination chain
    function _transferTbtc(
        uint256 amount,
        bytes32 destinationChainDepositOwner
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

        // Cache the parameters we need before clearing storage so the
        // post-clear external call still sees the staged values.
        ExecutorParameterSet memory cachedParams = params;

        // Clear parameters BEFORE the external call so a reentrant call
        // path (e.g. via the ETH refund inside `_transferTbtcWithExecutor`)
        // cannot replay the same staged parameters against a second deposit.
        delete parametersByNonce[latestNonce];

        // Call internal transfer with the cached parameters
        _transferTbtcWithExecutor(
            amount,
            destinationChainDepositOwner,
            cachedParams.executorArgs,
            cachedParams.feeArgs,
            latestNonce
        );
    }

    /// @notice Enhanced transfer function that requires real executor parameters
    /// @param amount Amount of tBTC to transfer
    /// @param destinationChainDepositOwner Full 32-byte recipient on the destination chain
    /// @param executorArgs Real executor arguments with valid signed quote
    /// @param feeArgs Platform fee arguments
    /// @param nonce The nonce used for this transfer
    // slither-disable-next-line reentrancy-vulnerabilities-3
    function _transferTbtcWithExecutor(
        uint256 amount,
        bytes32 destinationChainDepositOwner,
        ExecutorArgs memory executorArgs,
        FeeArgs memory feeArgs,
        bytes32 nonce
    ) internal {
        // External calls are to trusted contracts (tbtcToken, nttManagerWithExecutor)
        // Event emission after external calls is correct pattern
        require(amount > 0, "Amount must be greater than 0");

        // CRITICAL: Validate that we have a real signed quote
        require(
            executorArgs.signedQuote.length > 0,
            "Real signed quote from Wormhole Executor API is required"
        );
        _validateSignedQuoteFormat(executorArgs.signedQuote);

        uint16 chainId = _destinationChain();

        // CRITICAL: Validate payment amount before calling NTT manager
        uint256 requiredCost = nttManagerWithExecutor.quoteDeliveryPrice(
            underlyingNttManager,
            chainId,
            "",
            executorArgs,
            feeArgs
        );
        require(
            msg.value == requiredCost,
            "Payment for Wormhole NTT has incorrect value"
        );

        // Approve the NttManagerWithExecutor to spend tBTC
        tbtcToken.safeIncreaseAllowance( // slither-disable-line reentrancy-vulnerabilities-3
            address(nttManagerWithExecutor),
            amount
        );

        // Refund unused destination-chain execution gas to the configured
        // refund account, or to the deposit recipient by default. Defaulting to
        // the recipient keeps the refund deliverable on any destination chain,
        // including non-EVM chains (Solana, Sui) where a left-padded EVM address
        // is not a controllable account.
        bytes32 refundAddress = destinationRefundAddress != bytes32(0)
            ? destinationRefundAddress
            : destinationChainDepositOwner;

        // Execute the transfer with executor support
        uint64 sequence = nttManagerWithExecutor.transfer{value: requiredCost}( // slither-disable-line reentrancy-vulnerabilities-3
            underlyingNttManager,
            amount,
            chainId,
            destinationChainDepositOwner,
            refundAddress,
            "", // Empty transceiver instructions for basic transfer
            executorArgs,
            feeArgs
        );

        emit TokensTransferredNttWithExecutor( // slither-disable-line reentrancy-vulnerabilities-3
            msg.sender,
            nonce,
            amount,
            chainId,
            destinationChainDepositOwner,
            sequence,
            msg.value
        );

    }

    /// @notice Updates the fixed destination chain.
    function _updateDestinationChain(uint16 _destinationChainId) internal {
        require(_destinationChainId != 0, "Chain ID cannot be zero");

        uint16 oldDestinationChainId = destinationChainId;
        destinationChainId = _destinationChainId;

        emit DestinationChainUpdated(
            oldDestinationChainId,
            _destinationChainId
        );
    }

    /// @notice Marks deposits initialized under the fixed-destination format.
    function _afterDepositInitialized(
        uint256 depositKey,
        bytes32 // destinationChainDepositOwner
    ) internal override {
        fixedDestinationDeposits[depositKey] = true;
    }

    /// @notice Requires destination configuration before deposit initialization.
    function _beforeDepositInitialized(
        bytes32 // destinationChainDepositOwner
    ) internal view override {
        _destinationChain();
    }

    /// @notice Decodes legacy packed recipients for in-flight upgraded deposits.
    function _destinationChainDepositOwnerForTransfer(
        uint256 depositKey,
        bytes32 destinationChainDepositOwner
    ) internal view override returns (bytes32) {
        if (fixedDestinationDeposits[depositKey]) {
            return destinationChainDepositOwner;
        }

        uint16 legacyDestinationChain = uint16(
            uint256(destinationChainDepositOwner) >> 240
        );
        require(
            legacyDestinationChain == _destinationChain(),
            "Legacy destination chain mismatch"
        );

        return
            bytes32(
                uint256(destinationChainDepositOwner) &
                    LEGACY_DESTINATION_RECEIVER_MASK
            );
    }

    /// @notice Returns the configured destination chain and reverts if unset.
    function _destinationChain() internal view returns (uint16 chainId) {
        chainId = destinationChainId;
        require(chainId != 0, "Destination chain not configured");
    }

    /// @notice Validates the format of a signed quote from Wormhole Executor API
    /// @param signedQuote The signed quote bytes to validate
    /// @dev Keep validation minimal - NttManagerWithExecutor handles detailed validation
    function _validateSignedQuoteFormat(
        bytes memory signedQuote
    ) internal pure {
        require(signedQuote.length >= 32, "Signed quote too short");
    }

    /// @notice Generates a unique nonce for a user and sequence
    /// @param user The user address
    /// @param sequence The sequence number
    /// @return nonce The generated nonce
    function _generateNonce(
        address user,
        uint256 sequence
    ) internal pure returns (bytes32 nonce) {
        return keccak256(abi.encodePacked(user, sequence));
    }
}
