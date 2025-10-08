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

/// @notice NTT Manager interface for Hub-and-Spoke model transfers
/// @dev Interface matches native-token-transfers/evm/src/interfaces/INttManager.sol
/// Hub mode uses locking/unlocking instead of burning/minting
interface INttManager {
    /// @notice Transfer a given amount to a recipient on a given chain (simple version)
    /// @param amount The amount to transfer
    /// @param recipientChain The Wormhole chain ID for the destination
    /// @param recipient The recipient address (in bytes32 format)
    /// @return msgId The resulting message ID of the transfer
    function transfer(
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient
    ) external payable returns (uint64 msgId);

    /// @notice Transfer a given amount to a recipient on a given chain (full version)
    /// @param amount The amount to transfer
    /// @param recipientChain The Wormhole chain ID for the destination
    /// @param recipient The recipient address (in bytes32 format)
    /// @param refundAddress The address to which a refund for unused gas is issued
    /// @param shouldQueue Whether the transfer should be queued if the outbound limit is hit
    /// @param encodedInstructions Additional instructions to be forwarded to the recipient chain
    /// @return msgId The resulting message ID of the transfer
    function transfer(
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient,
        bytes32 refundAddress,
        bool shouldQueue,
        bytes memory encodedInstructions
    ) external payable returns (uint64 msgId);

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

/// @title L1BTCDepositorNtt (Enhanced Multi-Chain Version)
/// @notice This contract is part of the direct bridging mechanism allowing
///         users to obtain native ERC20 tBTC on supported chains, without the need
///         to interact with the L1 tBTC ledger chain where minting occurs.
///         This implementation uses Wormhole's Native Token Transfer (NTT) framework
///         for enhanced security and Hub-and-Spoke model transfers.
///
/// @dev Enhanced Multi-Chain Hub-and-Spoke Implementation:
///      - This contract operates as the HUB on Ethereum Mainnet L1
///      - Uses "locking" mode: tokens are locked on L1 instead of burned
///      - Spoke chains (L2s, sidechains) use "burning" mode for native tokens
///      - Enhanced security through NTT's multi-transceiver attestations
///      - Rate limiting and access controls provided by NTT framework
///      - Compatible with Bitcoin-backed tBTC minting flow on L1
///      - ENHANCED: Supports multi-chain destination selection via address encoding
///
/// @dev Address Encoding Format:
///      destinationChainReceiver: [2 bytes: Chain ID][30 bytes: Recipient Address]
///      Examples:
///      - 0x0020[Sei address padded]     → Sei (Wormhole Chain ID 32)
///      - 0x2105[Base address padded]    → Base (Wormhole Chain ID 8453)
///      - 0x0000[address]                → Default chain (backward compatibility)
// slither-disable-next-line reentrancy-vulnerabilities-3
contract L1BTCDepositorNtt is AbstractL1BTCDepositor {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @notice NTT Manager contract for Hub-and-Spoke cross-chain transfers
    /// @dev Configured in "locking" mode for L1 Hub operation
    INttManager public nttManager;

    /// @notice Mapping of supported destination chains by Wormhole chain ID
    /// @dev Only registered chains can receive transfers
    mapping(uint16 => bool) public supportedChains;

    /// @notice Default supported chain ID for backward compatibility
    /// @dev Used when no specific chain ID is encoded in receiver address
    uint16 public defaultSupportedChain;

    /// @notice Emitted when tokens are transferred via NTT Hub-and-Spoke framework
    /// @param amount Amount of tBTC transferred and locked on L1
    /// @param destinationChain Wormhole chain ID of the destination
    /// @param actualRecipient Actual recipient address on destination chain (cleaned)
    /// @param transferSequence NTT transfer sequence number for tracking
    /// @param encodedReceiver Original encoded receiver data with chain ID
    event TokensTransferredNTT(
        uint256 amount,
        uint16 destinationChain,
        bytes32 actualRecipient,
        uint64 transferSequence,
        bytes32 encodedReceiver
    );

    /// @notice Emitted when a destination chain is added or removed from supported chains
    /// @param chainId Wormhole chain ID
    /// @param supported Whether the chain is supported
    event SupportedChainUpdated(uint16 indexed chainId, bool supported);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the L1 Hub depositor contract
    /// @param _tbtcBridge tBTC Bridge contract address
    /// @param _tbtcVault tBTC Vault contract address
    /// @param _nttManager NTT Manager contract address (configured in locking mode)
    /// @dev The NTT Manager must be deployed and configured in "locking" mode before initializing
    function initialize(
        address _tbtcBridge,
        address _tbtcVault,
        address _nttManager
    ) external initializer {
        __AbstractL1BTCDepositor_initialize(_tbtcBridge, _tbtcVault);
        __Ownable_init();

        require(
            _nttManager != address(0),
            "NTT Manager address cannot be zero"
        );

        nttManager = INttManager(_nttManager);
    }

    /// @notice Sets the default supported chain for backward compatibility
    /// @param _chainId Wormhole chain ID to set as default
    /// @dev Only callable by contract owner
    function setDefaultSupportedChain(uint16 _chainId) external onlyOwner {
        require(_chainId != 0, "Chain ID cannot be zero");
        require(
            supportedChains[_chainId],
            "Chain must be supported before setting as default"
        );
        defaultSupportedChain = _chainId;
        emit DefaultSupportedChainUpdated(_chainId);
    }

    /// @notice Allows the owner to retrieve tokens from the contract and send to another wallet.
    ///         If the token address is zero, it transfers native token to the given address.
    ///         Otherwise, it transfers the specified amount of the given ERC20 token.
    /// @param _token The address of the token to retrieve. Use address(0) for native token.
    /// @param _to The address to which the tokens or native token will be sent.
    /// @param _amount The amount of tokens or native token to retrieve.
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

    /// @notice Adds or removes support for a destination chain
    /// @param _chainId Wormhole chain ID of the destination chain
    /// @param _supported Whether to support transfers to this chain
    /// @dev Only callable by contract owner
    function setSupportedChain(uint16 _chainId, bool _supported)
        external
        onlyOwner
    {
        require(_chainId != 0, "Chain ID cannot be zero");
        supportedChains[_chainId] = _supported;
        emit SupportedChainUpdated(_chainId, _supported);
    }

    /// @notice Updates the NTT Manager contract address
    /// @param _newNttManager New NTT Manager contract address
    /// @dev Only callable by contract owner. Use with caution as this changes the Hub behavior.
    function updateNttManager(address _newNttManager) external onlyOwner {
        require(
            _newNttManager != address(0),
            "NTT Manager address cannot be zero"
        );

        address oldNttManager = address(nttManager);
        nttManager = INttManager(_newNttManager);

        emit NttManagerUpdated(oldNttManager, _newNttManager);
    }

    /// @notice Quotes the payment that must be attached to the `finalizeDeposit`
    ///         function call for a specific destination chain. The payment is necessary
    ///         to cover the cost of the Wormhole NTT Hub-and-Spoke transfer.
    /// @param _destinationChain Wormhole chain ID of the destination chain
    /// @return cost The cost of the `finalizeDeposit` function call in WEI.
    /// @dev This function queries the NTT Manager for delivery pricing,
    ///      which includes fees for all configured transceivers (e.g., Wormhole, Axelar)
    function quoteFinalizeDeposit(uint16 _destinationChain)
        external
        view
        returns (uint256 cost)
    {
        require(
            supportedChains[_destinationChain],
            "Destination chain not supported"
        );
        (, cost) = nttManager.quoteDeliveryPrice(
            _destinationChain,
            "" // Empty transceiver instructions for basic transfer
        );
    }

    /// @notice Overloaded version that uses the first supported chain for backward compatibility
    /// @return cost The cost for the default destination chain
    /// @dev This maintains compatibility with the abstract base contract
    function quoteFinalizeDeposit() external view returns (uint256 cost) {
        // Find the first supported chain for backward compatibility
        uint16 defaultChain = _getDefaultSupportedChain();
        require(defaultChain != 0, "No supported chains configured");
        (, cost) = nttManager.quoteDeliveryPrice(
            defaultChain,
            "" // Empty transceiver instructions for basic transfer
        );
    }

    /// @notice Returns the current NTT Manager configuration
    /// @return manager Address of the current NTT Hub Manager
    function getNttConfiguration() external view returns (address manager) {
        return address(nttManager);
    }

    /// @notice Utility function to encode destination chain and recipient into receiver format
    /// @param chainId Wormhole chain ID of the destination
    /// @param recipient Recipient address on the destination chain
    /// @return encoded The encoded receiver data: [2 bytes: Chain ID][30 bytes: Recipient]
    /// @dev This is a helper function for frontend/SDK integration
    function encodeDestinationReceiver(uint16 chainId, address recipient)
        external
        pure
        returns (bytes32 encoded)
    {
        // Encode: [2 bytes: Chain ID][30 bytes: Address padded]
        return bytes32((uint256(chainId) << 240) | uint256(uint160(recipient)));
    }

    /// @notice Utility function to decode destination chain and recipient from receiver format
    /// @param encodedReceiver The encoded receiver data
    /// @return chainId The destination chain ID
    /// @return recipient The recipient address
    /// @dev This is a helper function for frontend/SDK integration and testing
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

    /// @notice Transfers tBTC to the destination chain using Wormhole NTT Hub-and-Spoke framework.
    ///         The function initiates an NTT transfer that locks L1 tBTC within
    ///         the NTT Manager contract and instructs the destination chain's
    ///         NTT Manager to mint native tokens to the specified receiver address.
    /// @param amount Amount of tBTC to transfer (1e18 precision)
    /// @param destinationChainReceiver Encoded receiver data: [2 bytes: Chain ID][30 bytes: Recipient]
    /// @dev This function is called internally by finalizeDeposit from parent contract
    /// @dev Requirements:
    ///      - The amount must be greater than 0,
    ///      - The appropriate payment for the Wormhole NTT transfer must be
    ///        attached to the call (as calculated by `quoteFinalizeDeposit`).
    ///
    /// @dev Enhanced Hub-and-Spoke NTT Transfer Flow:
    ///      1. Extract destination chain and recipient from encoded receiver
    ///      2. NTT Manager pulls tBTC from this contract (via approval)
    ///      3. NTT Manager locks tBTC tokens on L1 Hub (locking mode)
    ///      4. NTT framework sends cross-chain message via multiple transceivers
    ///      5. Spoke chain receives attested message and mints native tokens to actual recipient
    ///      6. Result: Bitcoin-backed native tBTC on destination chain
    // slither-disable-next-line reentrancy-vulnerabilities-3
    function _transferTbtc(uint256 amount, bytes32 destinationChainReceiver)
        internal
        override
    {
        // External calls are to trusted contracts (tbtcToken, nttManager)
        // Event emission after external calls is correct pattern
        require(amount > 0, "Amount must be greater than 0");

        // Enhanced: Extract destination chain from encoded receiver address
        uint16 destinationChain = _getDestinationChainFromReceiver(
            destinationChainReceiver
        );
        require(
            supportedChains[destinationChain],
            "Destination chain not supported"
        );

        // Enhanced: Extract actual recipient address (removes chain ID encoding)
        bytes32 actualRecipient = _getRecipientAddressFromReceiver(
            destinationChainReceiver
        );

        // Get quote for the transfer to ensure we have sufficient payment
        // This includes fees for all configured transceivers
        (, uint256 requiredFee) = nttManager.quoteDeliveryPrice(
            destinationChain,
            "" // Empty transceiver instructions for basic transfer
        );
        require(
            msg.value >= requiredFee,
            "Payment for Wormhole NTT is too low"
        );

        // The NTT Manager will pull the tBTC amount from this contract
        // We need to approve the transfer first
        tbtcToken.safeIncreaseAllowance(address(nttManager), amount); // slither-disable-line reentrancy-vulnerabilities-3

        // Execute NTT Hub-and-Spoke transfer with the actual recipient address
        // Uses the simple transfer function - NTT Manager handles the complexity
        // The NTT framework will:
        // 1. Pull tokens from this contract (Hub)
        // 2. Lock them in the NTT Manager (locking mode for Hub)
        // 3. Send cross-chain message via configured transceivers
        // 4. Spoke chain receives attested message and mints native tokens to actual recipient
        uint64 sequence = nttManager.transfer{value: msg.value}( // slither-disable-line reentrancy-vulnerabilities-3
            amount,
            destinationChain,
            actualRecipient // Use cleaned recipient address
        );

        emit TokensTransferredNTT( // slither-disable-line reentrancy-vulnerabilities-3
            amount,
            destinationChain,
            actualRecipient,
            sequence,
            destinationChainReceiver
        );
    }

    /// @notice Enhanced function to get destination chain from encoded receiver address
    /// @param destinationChainReceiver The encoded receiver with chain ID in first 2 bytes
    /// @return chainId The destination chain ID
    /// @dev Enhanced implementation that extracts chain ID from first 2 bytes of receiver address.
    ///      Format: [2 bytes: Chain ID][30 bytes: Recipient Address]
    ///      Falls back to default supported chain if chain ID is 0 or invalid for backward compatibility
    function _getDestinationChainFromReceiver(bytes32 destinationChainReceiver)
        internal
        view
        returns (uint16 chainId)
    {
        // Extract chain ID from first 2 bytes of receiver
        chainId = uint16(bytes2(destinationChainReceiver));

        // If chain ID is 0 or not supported, fall back to default chain
        // This maintains backward compatibility with existing deposits
        if (chainId == 0 || !supportedChains[chainId]) {
            chainId = _getDefaultSupportedChain(); // Fallback for backward compatibility
            require(chainId != 0, "No supported chains configured");
        }

        return chainId;
    }

    /// @notice Internal function to get the default supported chain
    /// @return chainId The default supported chain ID, or 0 if none set
    /// @dev Used for backward compatibility when no chain ID is encoded in receiver
    function _getDefaultSupportedChain()
        internal
        view
        returns (uint16 chainId)
    {
        return defaultSupportedChain;
    }

    /// @param destinationChainReceiver The encoded receiver data with chain ID in first 2 bytes
    /// @return recipient The actual recipient address (last 30 bytes, left-padded to 32 bytes)
    /// @dev Removes the chain ID from first 2 bytes and returns the recipient address
    ///      Format: [2 bytes: Chain ID][30 bytes: Recipient] → [32 bytes: Recipient padded]
    function _getRecipientAddressFromReceiver(bytes32 destinationChainReceiver)
        internal
        pure
        returns (bytes32 recipient)
    {
        // Remove chain ID (first 2 bytes) and keep recipient address (last 30 bytes)
        // Mask: 0x0000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF
        return
            bytes32(
                uint256(destinationChainReceiver) &
                    0x0000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF
            );
    }

    /// @notice Emitted when NTT Manager address is updated
    event NttManagerUpdated(
        address indexed oldManager,
        address indexed newManager
    );

    /// @notice Emitted when default supported chain is updated
    event DefaultSupportedChainUpdated(uint16 indexed chainId);
}
