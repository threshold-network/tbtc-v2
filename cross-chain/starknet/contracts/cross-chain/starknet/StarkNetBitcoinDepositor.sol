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

    /// @notice The StarkNet L2 tBTC token address
    uint256 public starkNetTBTCToken;

    /// @notice The L1→L2 message fee required for StarkGate bridge
    uint256 public l1ToL2MessageFee;

    /// @notice Maximum allowed fee buffer percentage (50%)
    uint256 public constant MAX_FEE_BUFFER = 50;

    /// @notice Fee buffer percentage to apply on top of dynamic fees
    uint256 public feeBuffer;

    // ========== Events ==========

    /// @notice Emitted when tBTC is successfully bridged to StarkNet
    /// @param depositKey The unique identifier for the deposit
    /// @param starkNetRecipient The recipient address on StarkNet L2
    /// @param amount The amount of tBTC bridged
    /// @param messageNonce The nonce of the L1→L2 message
    event TBTCBridgedToStarkNet(
        bytes32 indexed depositKey,
        uint256 indexed starkNetRecipient,
        uint256 amount,
        uint256 messageNonce
    );

    /// @notice Emitted when the L1→L2 message fee is updated
    /// @param newFee The new fee amount in wei
    event L1ToL2MessageFeeUpdated(uint256 newFee);

    /// @notice Emitted when the fee buffer is updated
    /// @param newBuffer The new fee buffer percentage
    event FeeBufferUpdated(uint256 newBuffer);

    /// @notice Emitted when the depositor is initialized
    /// @param starkGateBridge The address of the StarkGate bridge
    /// @param starkNetTBTCToken The L2 tBTC token address on StarkNet
    event StarkNetBitcoinDepositorInitialized(
        address starkGateBridge,
        uint256 starkNetTBTCToken
    );

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
    /// @param _starkNetTBTCToken The L2 tBTC token address on StarkNet
    /// @param _l1ToL2MessageFee Initial L1→L2 message fee for StarkGate
    function initialize(
        address _tbtcBridge,
        address _tbtcVault,
        address _starkGateBridge,
        uint256 _starkNetTBTCToken,
        uint256 _l1ToL2MessageFee
    ) external initializer {
        require(_tbtcBridge != address(0), "Invalid tBTC Bridge");
        require(_tbtcVault != address(0), "Invalid tBTC Vault");
        require(
            _starkGateBridge != address(0),
            "StarkGate bridge address cannot be zero"
        );
        require(
            _starkNetTBTCToken != 0,
            "StarkNet tBTC token address cannot be zero"
        );
        require(
            _l1ToL2MessageFee > 0,
            "L1->L2 message fee must be greater than zero"
        );

        // Initialize the parent AbstractL1BTCDepositor (this sets tbtcToken)
        __AbstractL1BTCDepositor_initialize(_tbtcBridge, _tbtcVault);

        // Initialize OwnableUpgradeable
        __Ownable_init();

        starkGateBridge = IStarkGateBridge(_starkGateBridge);
        starkNetTBTCToken = _starkNetTBTCToken;
        l1ToL2MessageFee = _l1ToL2MessageFee;
        feeBuffer = 10; // Default 10% buffer

        emit StarkNetBitcoinDepositorInitialized(
            _starkGateBridge,
            _starkNetTBTCToken
        );
    }

    // ========== External Functions ==========

    /// @notice Returns the required fee to finalize a deposit
    /// @return The current L1→L2 message fee in wei
    function quoteFinalizeDeposit(
        uint256 /* depositKey */
    ) public view returns (uint256) {
        return l1ToL2MessageFee;
    }

    /// @notice Updates the L1→L2 message fee
    /// @param newFee The new fee amount in wei
    function updateL1ToL2MessageFee(uint256 newFee) external onlyOwner {
        require(newFee > 0, "Fee must be greater than 0");
        l1ToL2MessageFee = newFee;
        emit L1ToL2MessageFeeUpdated(newFee);
    }

    /// @notice Returns the dynamic fee quote from StarkGate with fee buffer
    /// @dev Falls back to static fee if StarkGate is unavailable or fails
    /// @return The current L1→L2 message fee with buffer applied
    function quoteFinalizeDepositDynamic() public view returns (uint256) {
        if (address(starkGateBridge) == address(0)) {
            return l1ToL2MessageFee;
        }

        // Use a separate internal function to handle the try-catch
        (bool success, uint256 baseFee) = _tryEstimateMessageFee();

        if (success) {
            // If fee buffer is 0, return base fee without buffer
            if (feeBuffer == 0) {
                return baseFee;
            }

            // Calculate buffer amount safely
            // Since feeBuffer is capped at 50, we can optimize the calculation
            // to avoid intermediate overflow
            uint256 bufferAmount;

            // For better precision and to avoid overflow, calculate as:
            // bufferAmount = (baseFee / 100) * feeBuffer
            // This is safe because baseFee / 100 reduces the value first
            // slither-disable-next-line divide-before-multiply
            bufferAmount = (baseFee / 100) * feeBuffer;

            // Check if final addition would overflow
            if (baseFee > type(uint256).max - bufferAmount) {
                return type(uint256).max;
            }

            return baseFee + bufferAmount;
        } else {
            return l1ToL2MessageFee;
        }
    }

    /// @dev Internal function to wrap try-catch and avoid Slither warnings
    // slither-disable-next-line uninitialized-local,variable-scope,unused-return
    function _tryEstimateMessageFee()
        private
        view
        returns (bool success, uint256 fee)
    {
        // slither-disable-next-line uninitialized-local
        try starkGateBridge.estimateMessageFee() returns (uint256 _fee) {
            return (true, _fee);
        } catch {
            return (false, 0);
        }
    }

    /// @notice Updates the fee buffer percentage
    /// @param newBuffer The new fee buffer percentage (0-50)
    function updateFeeBuffer(uint256 newBuffer) external onlyOwner {
        require(newBuffer <= MAX_FEE_BUFFER, "Fee buffer too high");
        feeBuffer = newBuffer;
        emit FeeBufferUpdated(newBuffer);
    }

    // ========== Internal Functions ==========

    /// @notice Transfers tBTC to StarkNet L2 using StarkGate bridge
    /// @dev This function overrides the abstract function in AbstractL1BTCDepositor
    /// @param amount The amount of tBTC to bridge (in 1e18 precision)
    /// @param destinationChainReceiver The recipient address on StarkNet (as bytes32)
    function _transferTbtc(
        uint256 amount,
        bytes32 destinationChainReceiver
    ) internal override {
        require(
            msg.value >= l1ToL2MessageFee,
            "Insufficient L1->L2 message fee"
        );
        require(address(tbtcToken) != address(0), "tBTC token not initialized");

        // Convert bytes32 to uint256 for StarkNet address format
        uint256 starkNetRecipient = uint256(destinationChainReceiver);
        require(starkNetRecipient != 0, "Invalid StarkNet address");

        // Approve StarkGate bridge to spend tBTC
        tbtcToken.safeIncreaseAllowance(address(starkGateBridge), amount);

        // Bridge tBTC to StarkNet using the more efficient deposit function
        // slither-disable-next-line unused-return
        starkGateBridge.deposit{value: msg.value}(
            address(tbtcToken),
            amount,
            starkNetRecipient
        );
    }

    // ========== Gap for Future Storage Variables ==========

    /// @dev Gap for future storage variables to maintain upgrade compatibility
    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable state-variable-assignment
    // slither-disable-next-line unused-state
    uint256[49] private __gap; // Reduced by 1 due to feeBuffer
}
