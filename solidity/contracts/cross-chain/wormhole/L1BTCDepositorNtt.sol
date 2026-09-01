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

import "./AbstractFixedDestinationNttDepositor.sol";

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

/// @title L1BTCDepositorNtt
/// @notice This contract is part of the direct bridging mechanism allowing
///         users to obtain native ERC20 tBTC on supported chains, without the need
///         to interact with the L1 tBTC ledger chain where minting occurs.
///         This implementation uses Wormhole's Native Token Transfer (NTT) framework
///         for enhanced security and Hub-and-Spoke model transfers.
///
/// @dev Fixed-destination Hub-and-Spoke Implementation:
///      - This contract operates as the HUB on Ethereum Mainnet L1
///      - Uses "locking" mode: tokens are locked on L1 instead of burned
///      - The destination chain is configured once during initialization
///      - Enhanced security through NTT's multi-transceiver attestations
///      - Rate limiting and access controls provided by NTT framework
///      - Compatible with Bitcoin-backed tBTC minting flow on L1
///      - The Bitcoin deposit extra data is the full 32-byte destination
///        recipient. No chain ID is packed into the recipient.
// slither-disable-next-line reentrancy-vulnerabilities-3
contract L1BTCDepositorNtt is AbstractFixedDestinationNttDepositor {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @notice NTT Manager contract for Hub-and-Spoke cross-chain transfers
    /// @dev Configured in "locking" mode for L1 Hub operation
    INttManager public nttManager;

    /// @dev Retains the storage slot used by the previous `supportedChains`
    ///      mapping for compatibility with ERC1967 proxy upgrades.
    // slither-disable-next-line unused-state
    mapping(uint16 => bool) private __deprecatedSupportedChains;

    /// @notice Wormhole chain ID of the configured destination chain.
    /// @dev Stored in the slot previously used by `defaultSupportedChain`.
    uint16 public destinationChainId;

    /// @dev Marks deposits initialized after the fixed-destination upgrade.
    ///      Unmarked initialized deposits are treated as legacy NTT deposits
    ///      whose extra data used `[2-byte chain id][30-byte recipient]`.
    ///      This legacy-decode branch exists to backfill proxies upgraded
    ///      from the pre-fixed-destination storage layout; as of this PR no
    ///      such proxy has been deployed, so it currently ships as
    ///      forward-compatibility infrastructure for a hypothetical future
    ///      upgrade rather than an active migration path.
    /// @dev A separate mapping (one extra cold SSTORE per deposit) was
    ///      chosen over folding this flag into the shared
    ///      `AbstractL1BTCDepositor.DepositState` enum. Reusing that enum
    ///      would require modifying the state-transition checks in
    ///      `AbstractL1BTCDepositor.initializeDeposit`/`finalizeDeposit`,
    ///      which are inherited by every other live depositor proxy on this
    ///      contract's L1 (Base, Arbitrum, StarkNet, etc.). This mapping
    ///      keeps that shared, already-deployed state machine untouched at
    ///      the cost of one extra SSTORE per deposit on this contract only.
    mapping(uint256 => bool) public fixedDestinationDeposits;

    /// @notice Emitted when tokens are transferred via NTT Hub-and-Spoke framework
    /// @param amount Amount of tBTC transferred and locked on L1
    /// @param destinationChain Wormhole chain ID of the destination
    /// @param recipient Recipient address on destination chain
    /// @param transferSequence NTT transfer sequence number for tracking
    event TokensTransferredNTT(
        uint256 amount,
        uint16 destinationChain,
        bytes32 recipient,
        uint64 transferSequence
    );

    /// @notice Emitted when NTT Manager address is updated
    event NttManagerUpdated(
        address indexed oldManager,
        address indexed newManager
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the L1 Hub depositor contract
    /// @param _tbtcBridge tBTC Bridge contract address
    /// @param _tbtcVault tBTC Vault contract address
    /// @param _nttManager NTT Manager contract address (configured in locking mode)
    /// @param _destinationChainId Wormhole chain ID of the destination chain
    /// @dev The NTT Manager must be deployed and configured in "locking" mode before initializing
    function initialize(
        address _tbtcBridge,
        address _tbtcVault,
        address _nttManager,
        uint16 _destinationChainId
    ) external initializer {
        __AbstractL1BTCDepositor_initialize(_tbtcBridge, _tbtcVault);
        __Ownable_init();

        require(
            _nttManager != address(0),
            "NTT Manager address cannot be zero"
        );
        require(_destinationChainId != 0, "Chain ID cannot be zero");

        nttManager = INttManager(_nttManager);
        destinationChainId = _destinationChainId;
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
            // solhint-disable-next-line avoid-low-level-calls
            (bool success, ) = payable(_to).call{value: _amount}("");
            require(success, "Failed to transfer native token");
        } else {
            IERC20Upgradeable(_token).safeTransfer(_to, _amount);
        }
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
    ///         function call. The payment is necessary
    ///         to cover the cost of the Wormhole NTT Hub-and-Spoke transfer.
    /// @return cost The cost of the `finalizeDeposit` function call in WEI.
    /// @dev This function queries the NTT Manager for delivery pricing,
    ///      which includes fees for all configured transceivers (e.g., Wormhole, Axelar)
    function quoteFinalizeDeposit() external view returns (uint256 cost) {
        uint16 chainId = _destinationChain();
        (, cost) = nttManager.quoteDeliveryPrice(
            chainId,
            "" // Empty transceiver instructions for basic transfer
        );
    }

    /// @notice Returns the current NTT Manager configuration
    /// @return manager Address of the current NTT Hub Manager
    /// @return chainId Wormhole chain ID of the configured destination chain
    function getNttConfiguration()
        external
        view
        returns (address manager, uint16 chainId)
    {
        return (address(nttManager), destinationChainId);
    }

    /// @notice Transfers tBTC to the destination chain using Wormhole NTT Hub-and-Spoke framework.
    ///         The function initiates an NTT transfer that locks L1 tBTC within
    ///         the NTT Manager contract and instructs the destination chain's
    ///         NTT Manager to mint native tokens to the specified receiver address.
    /// @param amount Amount of tBTC to transfer (1e18 precision)
    /// @param destinationChainDepositOwner Full 32-byte recipient on the destination chain
    /// @dev This function is called internally by finalizeDeposit from parent contract
    /// @dev Requirements:
    ///      - The amount must be greater than 0,
    ///      - The appropriate payment for the Wormhole NTT transfer must be
    ///        attached to the call (as calculated by `quoteFinalizeDeposit`).
    ///
    /// @dev Enhanced Hub-and-Spoke NTT Transfer Flow:
    ///      1. Use the configured destination chain and deposit owner recipient
    ///      2. NTT Manager pulls tBTC from this contract (via approval)
    ///      3. NTT Manager locks tBTC tokens on L1 Hub (locking mode)
    ///      4. NTT framework sends cross-chain message via multiple transceivers
    ///      5. Spoke chain receives attested message and mints native tokens to recipient
    ///      6. Result: Bitcoin-backed native tBTC on destination chain
    // slither-disable-next-line reentrancy-vulnerabilities-3
    function _transferTbtc(uint256 amount, bytes32 destinationChainDepositOwner)
        internal
        override
    {
        // External calls are to trusted contracts (tbtcToken, nttManager)
        // Event emission after external calls is correct pattern
        require(amount > 0, "Amount must be greater than 0");

        // Get quote for the transfer to ensure we have sufficient payment
        // This includes fees for all configured transceivers
        uint16 chainId = _destinationChain();
        (, uint256 requiredFee) = nttManager.quoteDeliveryPrice(
            chainId,
            "" // Empty transceiver instructions for basic transfer
        );
        require(
            msg.value == requiredFee,
            "Payment for Wormhole NTT has incorrect value"
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
            chainId,
            destinationChainDepositOwner
        );

        emit TokensTransferredNTT( // slither-disable-line reentrancy-vulnerabilities-3
            amount,
            chainId,
            destinationChainDepositOwner,
            sequence
        );
    }

    function _setDestinationChainId(uint16 _destinationChainId)
        internal
        override
    {
        destinationChainId = _destinationChainId;
    }

    function _markFixedDestinationDeposit(uint256 depositKey)
        internal
        override
    {
        fixedDestinationDeposits[depositKey] = true;
    }

    function _destinationChainIdValue()
        internal
        view
        override
        returns (uint16)
    {
        return destinationChainId;
    }

    function _isFixedDestinationDeposit(uint256 depositKey)
        internal
        view
        override
        returns (bool)
    {
        return fixedDestinationDeposits[depositKey];
    }
}
