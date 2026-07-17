// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "@keep-network/random-beacon/contracts/Reimbursable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "../cross-chain/wormhole/Wormhole.sol";
import "../integrator/AbstractBTCRedeemer.sol";
import "../integrator/IBridge.sol";

contract MockL1BTCRedeemerWormhole is
    AbstractBTCRedeemer,
    Reimbursable,
    ReentrancyGuardUpgradeable
{
    // Custom errors
    error SourceAddressNotAuthorized();

    // State variables from L1BTCRedeemerWormhole
    IWormholeTokenBridge public wormholeTokenBridge;
    uint256 public requestRedemptionGasOffset;
    mapping(address => bool) public reimbursementAuthorizations;
    mapping(bytes32 => bool) public allowedSenders;

    // Mock-specific state
    uint256 public mockRedemptionAmountTBTC;

    // Events from L1BTCRedeemerWormhole
    event RedemptionRequested(
        uint256 indexed redemptionKey,
        bytes20 indexed walletPubKeyHash,
        BitcoinTx.UTXO mainUtxo,
        bytes indexed redemptionOutputScript,
        uint256 amount
    );

    event GasOffsetParametersUpdated(uint256 requestRedemptionGasOffset);

    event ReimbursementAuthorizationUpdated(
        address indexed _address,
        bool authorization
    );

    event AllowedSenderUpdated(bytes32 indexed sender, bool allowed);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    modifier onlyReimbursableAdmin() override {
        if (msg.sender != owner()) revert("Caller is not the owner");
        _;
    }

    // Custom initializer for the mock
    function initialize(
        address _thresholdBridge,
        address _wormholeTokenBridge,
        address _tbtcToken,
        address _bank,
        address _tbtcVault
    ) external initializer {
        __AbstractBTCRedeemer_initialize(
            _thresholdBridge,
            _tbtcToken,
            _bank,
            _tbtcVault
        );
        __ReentrancyGuard_init();
        __Ownable_init();

        if (_wormholeTokenBridge == address(0)) {
            revert ZeroAddress();
        }

        wormholeTokenBridge = IWormholeTokenBridge(_wormholeTokenBridge);
        requestRedemptionGasOffset = 60_000;
        mockRedemptionAmountTBTC = 2 * (10**18); // Default to 2 tBTC
    }

    function setMockRedemptionAmountTBTC(uint256 _amount) external {
        mockRedemptionAmountTBTC = _amount;
    }

    function updateGasOffsetParameters(uint256 _requestRedemptionGasOffset)
        external
        onlyOwner
    {
        requestRedemptionGasOffset = _requestRedemptionGasOffset;
        emit GasOffsetParametersUpdated(_requestRedemptionGasOffset);
    }

    function updateReimbursementAuthorization(
        address _address,
        bool authorization
    ) external onlyOwner {
        emit ReimbursementAuthorizationUpdated(_address, authorization);
        reimbursementAuthorizations[_address] = authorization;
    }

    function updateAllowedSender(bytes32 _sender, bool _allowed)
        external
        onlyOwner
    {
        allowedSenders[_sender] = _allowed;
        emit AllowedSenderUpdated(_sender, _allowed);
    }

    // Mock implementation of requestRedemption
    function requestRedemption(
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO calldata mainUtxo,
        bytes calldata encodedVm
    ) external nonReentrant {
        uint256 gasStart = gasleft();

        // In the real implementation, completeTransferWithPayload returns encoded data
        // that needs to be parsed. For the mock, we'll simulate this behavior.
        bytes memory encoded = wormholeTokenBridge.completeTransferWithPayload(
            encodedVm
        );

        // Parse the transfer data to validate the source
        IWormholeTokenBridge.TransferWithPayload
            memory transfer = wormholeTokenBridge.parseTransferWithPayload(
                encoded
            );

        // Validate that the message came from an authorized sender
        bytes32 sender = transfer.fromAddress;
        if (!allowedSenders[sender]) revert SourceAddressNotAuthorized();

        bytes memory redemptionOutputScriptToUse = transfer.payload;

        // Use the mock-specific redemption amount
        uint256 amountToUse = mockRedemptionAmountTBTC;
        if (amountToUse == 0) {
            amountToUse = 2 * (10**18);
        }

        // Call the internal _requestRedemption
        (uint256 redemptionKey, ) = _requestRedemption(
            walletPubKeyHash,
            mainUtxo,
            redemptionOutputScriptToUse,
            amountToUse
        );

        // Emit event
        emit RedemptionRequested(
            redemptionKey,
            walletPubKeyHash,
            mainUtxo,
            redemptionOutputScriptToUse,
            amountToUse
        );

        // Reimbursement logic
        if (
            address(reimbursementPool) != address(0) &&
            reimbursementAuthorizations[msg.sender]
        ) {
            reimbursementPool.refund(
                (gasStart - gasleft()) + requestRedemptionGasOffset,
                msg.sender
            );
        }
    }

    function _calculateTbtcAmount(
        uint64 redemptionAmountSat,
        uint64 redemptionTreasuryFeeSat
    ) internal view virtual override returns (uint256) {
        if (redemptionAmountSat <= redemptionTreasuryFeeSat) {
            return 0;
        }
        // Simplified calculation for the mock
        return
            (redemptionAmountSat - redemptionTreasuryFeeSat) *
            SATOSHI_MULTIPLIER;
    }
}
