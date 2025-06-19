// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import {Test} from "forge-std/Test.sol";
import {StarkNetBitcoinDepositor} from "../../../contracts/cross-chain/starknet/StarkNetBitcoinDepositor.sol";
import {MockTBTCBridge} from "./mocks/MockTBTCBridge.sol";
import {MockTBTCVault} from "./mocks/MockTBTCVault.sol";
import {MockTBTCToken} from "./mocks/MockTBTCToken.sol";
import {MockStarkGateBridge} from "./mocks/MockStarkGateBridge.sol";
import {IBridgeTypes} from "../../../contracts/cross-chain/integrator/IBridge.sol";

contract EventSystemTest is Test {
    StarkNetBitcoinDepositor public depositor;
    MockTBTCBridge public mockBridge;
    MockTBTCVault public mockVault;
    MockTBTCToken public mockToken;
    MockStarkGateBridge public mockStarkGateBridge;

    uint256 public constant INITIAL_FEE = 0.01 ether;
    uint256 public constant TEST_AMOUNT = 1 ether;

    // Events to test
    event StarkNetBitcoinDepositorInitialized(
        address starkGateBridge,
        address tbtcToken
    );

    event DepositInitializedForStarkNet(
        bytes32 indexed depositKey,
        uint256 indexed starkNetRecipient
    );

    event TBTCBridgedToStarkNet(
        bytes32 indexed depositKey,
        uint256 indexed starkNetRecipient,
        uint256 amount,
        uint256 messageNonce
    );

    event L1ToL2MessageFeeUpdated(uint256 newFee);

    function setUp() public {
        // Deploy mocks
        mockToken = new MockTBTCToken();
        mockBridge = new MockTBTCBridge();
        mockVault = new MockTBTCVault(address(mockToken));
        mockStarkGateBridge = new MockStarkGateBridge();
    }

    function testConstructorInitializationEvent() public {
        // Expect event emission
        vm.expectEmit(true, true, true, true);
        emit StarkNetBitcoinDepositorInitialized(
            address(mockStarkGateBridge),
            address(mockToken)
        );

        // Deploy depositor
        depositor = new StarkNetBitcoinDepositor(
            address(mockBridge),
            address(mockVault),
            address(mockStarkGateBridge),
            INITIAL_FEE
        );
    }

    function testDepositInitializedForStarkNetEvent() public {
        // Deploy depositor
        depositor = new StarkNetBitcoinDepositor(
            address(mockBridge),
            address(mockVault),
            address(mockStarkGateBridge),
            INITIAL_FEE
        );

        // Create test data
        IBridgeTypes.BitcoinTxInfo memory fundingTx = IBridgeTypes
            .BitcoinTxInfo({
                version: "0x01000000",
                inputVector: "",
                outputVector: "",
                locktime: ""
            });

        IBridgeTypes.DepositRevealInfo memory reveal = IBridgeTypes
            .DepositRevealInfo({
                fundingOutputIndex: 0,
                blindingFactor: bytes8(0),
                walletPubKeyHash: bytes20(address(this)),
                refundPubKeyHash: bytes20(address(this)),
                refundLocktime: bytes4(0),
                vault: address(mockVault)
            });

        bytes32 l2DepositOwner = bytes32(uint256(0x0123456789abcdef));

        // Calculate expected deposit key (this would need to match the actual calculation)
        bytes32 expectedDepositKey = keccak256(abi.encode(fundingTx, reveal));

        // Expect event
        vm.expectEmit(true, true, true, true);
        emit DepositInitializedForStarkNet(
            expectedDepositKey,
            uint256(l2DepositOwner)
        );

        // Initialize deposit
        depositor.initializeDeposit(fundingTx, reveal, l2DepositOwner);
    }

    function testTBTCBridgedToStarkNetEvent() public {
        // Deploy depositor
        depositor = new StarkNetBitcoinDepositor(
            address(mockBridge),
            address(mockVault),
            address(mockStarkGateBridge),
            INITIAL_FEE
        );

        // Setup mock to return a message nonce
        uint256 expectedNonce = 12345;
        mockStarkGateBridge.setDepositWithMessageReturn(expectedNonce);

        // First initialize a deposit
        IBridgeTypes.BitcoinTxInfo memory fundingTx = IBridgeTypes
            .BitcoinTxInfo({
                version: "0x01000000",
                inputVector: "",
                outputVector: "",
                locktime: ""
            });

        IBridgeTypes.DepositRevealInfo memory reveal = IBridgeTypes
            .DepositRevealInfo({
                fundingOutputIndex: 0,
                blindingFactor: bytes8(0),
                walletPubKeyHash: bytes20(address(this)),
                refundPubKeyHash: bytes20(address(this)),
                refundLocktime: bytes4(0),
                vault: address(mockVault)
            });

        bytes32 l2DepositOwner = bytes32(uint256(0x0123456789abcdef));

        // Initialize deposit
        depositor.initializeDeposit(fundingTx, reveal, l2DepositOwner);

        // Calculate deposit key
        bytes32 depositKey = keccak256(abi.encode(fundingTx, reveal));

        // Mock the bridge to simulate minting tBTC
        mockToken.mint(address(depositor), TEST_AMOUNT);

        // Expect bridging event
        vm.expectEmit(true, true, true, true);
        emit TBTCBridgedToStarkNet(
            depositKey,
            uint256(l2DepositOwner),
            TEST_AMOUNT,
            expectedNonce
        );

        // Finalize deposit
        depositor.finalizeDeposit{value: INITIAL_FEE}(depositKey);
    }

    function testL1ToL2MessageFeeUpdatedEvent() public {
        // Deploy depositor
        depositor = new StarkNetBitcoinDepositor(
            address(mockBridge),
            address(mockVault),
            address(mockStarkGateBridge),
            INITIAL_FEE
        );

        uint256 newFee = 0.03 ether;

        // Expect event
        vm.expectEmit(true, true, true, true);
        emit L1ToL2MessageFeeUpdated(newFee);

        // Update fee
        depositor.updateL1ToL2MessageFee(newFee);
    }

    function testAllEventsInCompleteFlow() public {
        // Test constructor event
        vm.expectEmit(true, true, true, true);
        emit StarkNetBitcoinDepositorInitialized(
            address(mockStarkGateBridge),
            address(mockToken)
        );

        // Deploy depositor
        depositor = new StarkNetBitcoinDepositor(
            address(mockBridge),
            address(mockVault),
            address(mockStarkGateBridge),
            INITIAL_FEE
        );

        // Test fee update event
        uint256 newFee = 0.02 ether;
        vm.expectEmit(true, true, true, true);
        emit L1ToL2MessageFeeUpdated(newFee);
        depositor.updateL1ToL2MessageFee(newFee);

        // Test deposit initialization event
        IBridgeTypes.BitcoinTxInfo memory fundingTx = IBridgeTypes
            .BitcoinTxInfo({
                version: "0x01000000",
                inputVector: "",
                outputVector: "",
                locktime: ""
            });

        IBridgeTypes.DepositRevealInfo memory reveal = IBridgeTypes
            .DepositRevealInfo({
                fundingOutputIndex: 0,
                blindingFactor: bytes8(0),
                walletPubKeyHash: bytes20(address(this)),
                refundPubKeyHash: bytes20(address(this)),
                refundLocktime: bytes4(0),
                vault: address(mockVault)
            });

        bytes32 l2DepositOwner = bytes32(uint256(0x0123456789abcdef));
        bytes32 depositKey = keccak256(abi.encode(fundingTx, reveal));

        vm.expectEmit(true, true, true, true);
        emit DepositInitializedForStarkNet(depositKey, uint256(l2DepositOwner));
        depositor.initializeDeposit(fundingTx, reveal, l2DepositOwner);

        // Test bridging event
        mockToken.mint(address(depositor), TEST_AMOUNT);
        uint256 expectedNonce = 54321;
        mockStarkGateBridge.setDepositWithMessageReturn(expectedNonce);

        vm.expectEmit(true, true, true, true);
        emit TBTCBridgedToStarkNet(
            depositKey,
            uint256(l2DepositOwner),
            TEST_AMOUNT,
            expectedNonce
        );
        depositor.finalizeDeposit{value: newFee}(depositKey);
    }
}
