// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "@keep-network/random-beacon/contracts/Reimbursable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "../cross-chain/wormhole/Wormhole.sol";
import "../integrator/AbstractBTCRedeemer.sol";

contract MockL1BTCRedeemerWormhole is
    AbstractBTCRedeemer,
    Reimbursable,
    ReentrancyGuardUpgradeable
{
    // State variables from L1BTCRedeemerWormhole
    IWormholeTokenBridge public wormholeTokenBridge;
    uint256 public requestRedemptionGasOffset;
    mapping(address => bool) public reimbursementAuthorizations;

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

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    modifier onlyReimbursableAdmin() override {
        require(msg.sender == owner(), "Caller is not the owner");
        _;
    }

    // Custom initializer for the mock
    function initialize(
        address _thresholdBridge,
        address _wormholeTokenBridge,
        address _tbtcToken,
        address _bank
    ) external initializer {
        __AbstractBTCRedeemer_initialize(_thresholdBridge, _tbtcToken, _bank);
        __ReentrancyGuard_init();
        __Ownable_init();

        require(
            _wormholeTokenBridge != address(0),
            "Wormhole Token Bridge address cannot be zero"
        );

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

    // Mock implementation of requestRedemption
    function requestRedemption(
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO calldata mainUtxo,
        bytes calldata encodedVm
    ) external nonReentrant {
        uint256 gasStart = gasleft();

        // In tests, wormholeTokenBridge.completeTransferWithPayload is mocked
        // to return the redemption output script directly
        bytes memory redemptionOutputScriptToUse = wormholeTokenBridge
            .completeTransferWithPayload(encodedVm);

        // Use the mock-specific redemption amount
        uint256 amountToUse = mockRedemptionAmountTBTC;
        if (amountToUse == 0) {
            amountToUse = 2 * (10**18);
        }

        // Convert to satoshis
        uint64 amountInSatoshis = uint64(amountToUse / SATOSHI_MULTIPLIER);

        // Call the internal _requestRedemption
        (uint256 redemptionKey, ) = _requestRedemption(
            walletPubKeyHash,
            mainUtxo,
            redemptionOutputScriptToUse,
            amountInSatoshis
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
