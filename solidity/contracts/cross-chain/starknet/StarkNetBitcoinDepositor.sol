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
import "./interfaces/IStarkGateBridge.sol";

/// @title StarkNet L1 Bitcoin Depositor
/// @notice This contract facilitates Bitcoin deposits that are bridged to StarkNet L2
/// @dev Inherits from AbstractL1BTCDepositor and integrates with StarkGate bridge
///      Implements OpenZeppelin upgradeable pattern for future improvements
contract StarkNetBitcoinDepositor is AbstractL1BTCDepositor {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    // ========== State Variables ==========
    // Note: All state variables must be declared without initialization
    // for upgradeable contracts

    /// @notice The StarkGate bridge contract interface
    IStarkGateBridge public starkGateBridge;

    // ========== Events ==========

    /// @notice Emitted when tBTC is successfully bridged to StarkNet
    /// @param sender The sender address (finalizeDeposit caller)
    /// @param amount The amount of tBTC bridged
    /// @param starkNetRecipient The recipient address on StarkNet L2
    /// @param fee The fee paid for bridging
    event TBTCBridgedToStarkNet(
        address indexed sender,
        uint256 amount,
        uint256 starkNetRecipient,
        uint256 fee
    );

    /// @notice Emitted when the depositor is initialized
    /// @param starkGateBridge The address of the StarkGate bridge
    event StarkNetBitcoinDepositorInitialized(address starkGateBridge);

    // ========== Constructor ==========

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ========== Initializer ==========

    /// @notice Initializes the StarkNet Bitcoin Depositor contract
    /// @param _tbtcBridge Address of the tBTC Bridge contract
    /// @param _tbtcVault Address of the tBTC Vault contract
    /// @param _starkGateBridge Address of the StarkGate bridge contract
    function initialize(
        address _tbtcBridge,
        address _tbtcVault,
        address _starkGateBridge
    ) external initializer {
        require(_tbtcBridge != address(0), "Invalid tBTC Bridge");
        require(_tbtcVault != address(0), "Invalid tBTC Vault");
        require(
            _starkGateBridge != address(0),
            "StarkGate bridge address cannot be zero"
        );

        // Initialize the parent AbstractL1BTCDepositor (this sets tbtcToken)
        __AbstractL1BTCDepositor_initialize(_tbtcBridge, _tbtcVault);

        // Initialize OwnableUpgradeable
        __Ownable_init();

        starkGateBridge = IStarkGateBridge(_starkGateBridge);

        emit StarkNetBitcoinDepositorInitialized(_starkGateBridge);
    }

    // ========== External Functions ==========

    /// @notice Get the estimated fee for a deposit from the StarkGate bridge
    /// @return The estimated fee in wei
    function estimateFee() public view returns (uint256) {
        return starkGateBridge.estimateDepositFeeWei();
    }

    // ========== Internal Functions ==========

    /// @notice Transfers tBTC to StarkNet L2 using StarkGate bridge
    /// @dev This function overrides the abstract function in AbstractL1BTCDepositor
    /// @param amount The amount of tBTC to bridge (in 1e18 precision)
    /// @param destinationChainReceiver The recipient address on StarkNet (as bytes32)
    function _transferTbtc(uint256 amount, bytes32 destinationChainReceiver)
        internal
        override
    {
        // This function is called by finalizeDeposit which is payable
        // The caller must send ETH to cover the StarkGate bridge fee
        uint256 fee = estimateFee();
        require(msg.value >= fee, "Insufficient L1->L2 message fee");
        require(address(tbtcToken) != address(0), "tBTC token not initialized");

        // Convert bytes32 to uint256 for StarkNet address format
        uint256 starkNetRecipient = uint256(destinationChainReceiver);
        require(starkNetRecipient != 0, "Invalid StarkNet address");

        // Approve StarkGate bridge to spend tBTC using safeIncreaseAllowance
        tbtcToken.safeIncreaseAllowance(address(starkGateBridge), amount);

        // Bridge tBTC to StarkNet
        // All msg.value is sent to the bridge (no refund)
        // slither-disable-next-line unused-return
        starkGateBridge.deposit{value: msg.value}(
            address(tbtcToken),
            amount,
            starkNetRecipient
        );

        // Emit event for StarkNet bridging
        // slither-disable-next-line reentrancy-events
        emit TBTCBridgedToStarkNet(
            msg.sender,
            amount,
            starkNetRecipient,
            msg.value
        );
    }
}
