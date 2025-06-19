// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "forge-std/Test.sol";
import "../../../contracts/cross-chain/starknet/StarkNetBitcoinDepositor.sol";
import "./mocks/MockStarkGateBridge.sol";
import "./mocks/MockTBTCToken.sol";
import "./mocks/MockTBTCBridge.sol";
import "./mocks/MockTBTCVault.sol";
import "./helpers/TestSetup.sol";
import "./helpers/GasReporter.sol";

contract StarkNetBitcoinDepositorTest is Test, TestSetup, GasReporter {
    StarkNetBitcoinDepositor public depositor;
    MockStarkGateBridge public mockStarkGateBridge;
    MockTBTCToken public mockTBTCToken;
    MockTBTCBridge public mockTBTCBridge;
    MockTBTCVault public mockTBTCVault;

    // Test addresses
    address public owner = address(0x1);
    address public user = address(0x2);
    uint256 public starkNetRecipient = uint256(0x3);

    // Test values
    uint256 public constant INITIAL_MESSAGE_FEE = 0.01 ether;
    uint256 public constant DEPOSIT_AMOUNT = 1 ether;
    uint256 public constant DEFAULT_DEPOSIT_KEY = 12345;

    // Gas limits for operations
    uint256 public constant GAS_LIMIT_CONSTRUCTOR = 2_000_000;
    uint256 public constant GAS_LIMIT_FINALIZE_DEPOSIT = 500_000;
    uint256 public constant GAS_LIMIT_UPDATE_FEE = 100_000;

    function setUp() public {
        // Deploy mocks
        mockStarkGateBridge = new MockStarkGateBridge();
        mockTBTCToken = new MockTBTCToken();
        mockTBTCBridge = new MockTBTCBridge();
        mockTBTCVault = new MockTBTCVault();

        // Setup mock data
        _setupMockDeposit(DEFAULT_DEPOSIT_KEY, DEPOSIT_AMOUNT, user);

        // Deploy depositor contract
        vm.prank(owner);
        depositor = new StarkNetBitcoinDepositor(
            address(mockTBTCBridge),
            address(mockTBTCVault),
            address(0), // wormhole (not used)
            address(0), // wormhole gateway (not used)
            address(0), // wormhole token bridge (not used)
            0, // l2 wormhole gateway (not used)
            address(mockStarkGateBridge),
            INITIAL_MESSAGE_FEE
        );

        // Initialize gas reporter
        initGasReporter();
        setGasLimit("constructor", GAS_LIMIT_CONSTRUCTOR);
        setGasLimit("finalizeDeposit", GAS_LIMIT_FINALIZE_DEPOSIT);
        setGasLimit("updateFee", GAS_LIMIT_UPDATE_FEE);
    }

    // ========== Constructor Tests ==========

    function test_Constructor_Success() public {
        uint256 gasStart = gasleft();

        vm.prank(owner);
        StarkNetBitcoinDepositor newDepositor = new StarkNetBitcoinDepositor(
            address(mockTBTCBridge),
            address(mockTBTCVault),
            address(0),
            address(0),
            address(0),
            0,
            address(mockStarkGateBridge),
            INITIAL_MESSAGE_FEE
        );

        uint256 gasUsed = gasStart - gasleft();
        recordGasUsage("constructor", gasUsed);

        assertEq(
            address(newDepositor.starkGateBridge()),
            address(mockStarkGateBridge)
        );
        assertEq(newDepositor.l1ToL2MessageFee(), INITIAL_MESSAGE_FEE);
        assertEq(newDepositor.owner(), owner);
    }

    function test_Constructor_RevertInvalidBridge() public {
        vm.expectRevert("Invalid StarkGate bridge");
        vm.prank(owner);
        new StarkNetBitcoinDepositor(
            address(mockTBTCBridge),
            address(mockTBTCVault),
            address(0),
            address(0),
            address(0),
            0,
            address(0), // Invalid bridge
            INITIAL_MESSAGE_FEE
        );
    }

    function test_Constructor_RevertInvalidFee() public {
        vm.expectRevert("Invalid L1->L2 message fee");
        vm.prank(owner);
        new StarkNetBitcoinDepositor(
            address(mockTBTCBridge),
            address(mockTBTCVault),
            address(0),
            address(0),
            address(0),
            0,
            address(mockStarkGateBridge),
            0 // Invalid fee
        );
    }

    // ========== Quote Function Tests ==========

    function test_QuoteFinalizeDeposit_ReturnsCorrectFee() public {
        bytes32 depositKey = keccak256("test");
        uint256 fee = depositor.quoteFinalizeDeposit(depositKey);
        assertEq(fee, INITIAL_MESSAGE_FEE);
    }

    function test_QuoteFinalizeDeposit_ConsistentWithStoredFee() public {
        bytes32 depositKey = _generateDepositKey(DEFAULT_DEPOSIT_KEY);
        uint256 quotedFee = depositor.quoteFinalizeDeposit(depositKey);
        uint256 storedFee = depositor.l1ToL2MessageFee();
        assertEq(quotedFee, storedFee);
    }

    // ========== Fee Management Tests ==========

    function test_UpdateL1ToL2MessageFee_Success() public {
        uint256 newFee = 0.02 ether;

        _expectEvent_L1ToL2MessageFeeUpdated(newFee);

        uint256 gasStart = gasleft();
        vm.prank(owner);
        depositor.updateL1ToL2MessageFee(newFee);
        uint256 gasUsed = gasStart - gasleft();

        recordGasUsage("updateFee", gasUsed);
        assertEq(depositor.l1ToL2MessageFee(), newFee);
    }

    function test_UpdateL1ToL2MessageFee_RevertNotOwner() public {
        vm.prank(user);
        vm.expectRevert("Ownable: caller is not the owner");
        depositor.updateL1ToL2MessageFee(0.02 ether);
    }

    function test_UpdateL1ToL2MessageFee_RevertZeroFee() public {
        vm.prank(owner);
        vm.expectRevert("Fee must be greater than 0");
        depositor.updateL1ToL2MessageFee(0);
    }

    function test_UpdateL1ToL2MessageFee_MultipleUpdates() public {
        uint256[] memory fees = new uint256[](3);
        fees[0] = 0.02 ether;
        fees[1] = 0.05 ether;
        fees[2] = 0.01 ether;

        for (uint256 i = 0; i < fees.length; i++) {
            vm.prank(owner);
            depositor.updateL1ToL2MessageFee(fees[i]);
            assertEq(depositor.l1ToL2MessageFee(), fees[i]);
        }
    }

    // ========== Event System Tests ==========

    function test_FinalizeDeposit_EmitsDepositInitialized() public {
        uint256 depositKey = DEFAULT_DEPOSIT_KEY;
        bytes32 expectedDepositKey = _generateDepositKey(depositKey);

        // Setup: Add sufficient balance to contract for fee
        vm.deal(address(depositor), INITIAL_MESSAGE_FEE);

        // Setup: Mock successful StarkGate interaction
        mockStarkGateBridge.setDepositWithMessageReturn(1);

        _expectEvent_DepositInitializedForStarkNet(
            expectedDepositKey,
            starkNetRecipient
        );

        uint256 gasStart = gasleft();
        depositor.finalizeDeposit{value: INITIAL_MESSAGE_FEE}(
            depositKey,
            starkNetRecipient
        );
        uint256 gasUsed = gasStart - gasleft();

        recordGasUsage("finalizeDeposit", gasUsed);
    }

    function test_FinalizeDeposit_WithCorrectParameters() public {
        uint256 depositKey = DEFAULT_DEPOSIT_KEY;
        bytes32 expectedDepositKey = _generateDepositKey(depositKey);

        vm.deal(address(depositor), INITIAL_MESSAGE_FEE);
        mockStarkGateBridge.setDepositWithMessageReturn(1);

        // Verify event contains correct indexed parameters
        vm.expectEmit(true, true, false, true);
        emit StarkNetBitcoinDepositor.DepositInitializedForStarkNet(
            expectedDepositKey,
            starkNetRecipient
        );

        depositor.finalizeDeposit{value: INITIAL_MESSAGE_FEE}(
            depositKey,
            starkNetRecipient
        );
    }

    // ========== Integration Flow Tests ==========

    function test_FullDepositFlow_Success() public {
        uint256 depositKey = DEFAULT_DEPOSIT_KEY;
        bytes32 expectedDepositKey = _generateDepositKey(depositKey);

        // Setup: Fund contract and configure mocks
        vm.deal(address(depositor), INITIAL_MESSAGE_FEE);
        mockStarkGateBridge.setDepositWithMessageReturn(1);

        // Verify initial state
        assertEq(mockStarkGateBridge.getDepositCount(), 0);

        // Execute deposit finalization
        depositor.finalizeDeposit{value: INITIAL_MESSAGE_FEE}(
            depositKey,
            starkNetRecipient
        );

        // Verify final state
        assertEq(mockStarkGateBridge.getDepositCount(), 1);
        assertTrue(
            mockTBTCVault.isOptimisticMintingFinalized(expectedDepositKey)
        );
    }

    function test_MultipleDeposits_IndependentProcessing() public {
        uint256[] memory depositKeys = new uint256[](3);
        depositKeys[0] = 1001;
        depositKeys[1] = 1002;
        depositKeys[2] = 1003;

        // Setup multiple deposits
        for (uint256 i = 0; i < depositKeys.length; i++) {
            _setupMockDeposit(depositKeys[i], DEPOSIT_AMOUNT, user);
        }

        vm.deal(address(depositor), INITIAL_MESSAGE_FEE * 3);
        mockStarkGateBridge.setDepositWithMessageReturn(1);

        // Process each deposit
        for (uint256 i = 0; i < depositKeys.length; i++) {
            depositor.finalizeDeposit{value: INITIAL_MESSAGE_FEE}(
                depositKeys[i],
                starkNetRecipient + i
            );
        }

        assertEq(mockStarkGateBridge.getDepositCount(), 3);
    }

    // ========== Error Condition Tests ==========

    function test_FinalizeDeposit_RevertInsufficientFee() public {
        uint256 depositKey = DEFAULT_DEPOSIT_KEY;
        uint256 insufficientFee = INITIAL_MESSAGE_FEE - 1;

        vm.expectRevert();
        depositor.finalizeDeposit{value: insufficientFee}(
            depositKey,
            starkNetRecipient
        );
    }

    function test_FinalizeDeposit_RevertZeroRecipient() public {
        uint256 depositKey = DEFAULT_DEPOSIT_KEY;

        vm.deal(address(depositor), INITIAL_MESSAGE_FEE);
        vm.expectRevert("Invalid StarkNet recipient");
        depositor.finalizeDeposit{value: INITIAL_MESSAGE_FEE}(
            depositKey,
            0 // Invalid recipient
        );
    }

    // ========== Gas Optimization Tests ==========

    function test_GasUsage_WithinLimits() public {
        generateGasReport();

        // Verify all operations are within gas limits
        assertTrue(
            _isWithinGasLimit("constructor"),
            "Constructor exceeds gas limit"
        );
        assertTrue(
            _isWithinGasLimit("finalizeDeposit"),
            "FinalizeDeposit exceeds gas limit"
        );
        assertTrue(
            _isWithinGasLimit("updateFee"),
            "UpdateFee exceeds gas limit"
        );
    }

    // ========== Helper Functions ==========

    function _setupMockDeposit(
        uint256 depositKey,
        uint256 amount,
        address depositor_
    ) internal {
        setupMockDeposit(
            mockTBTCBridge,
            mockTBTCVault,
            depositKey,
            amount,
            depositor_
        );
    }

    function _generateDepositKey(uint256 depositKey)
        internal
        pure
        returns (bytes32)
    {
        return bytes32(depositKey);
    }

    function _expectEvent_L1ToL2MessageFeeUpdated(uint256 newFee) internal {
        expectEvent_L1ToL2MessageFeeUpdated(address(depositor), newFee);
    }

    function _expectEvent_DepositInitializedForStarkNet(
        bytes32 depositKey,
        uint256 recipient
    ) internal {
        expectEvent_DepositInitializedForStarkNet(
            address(depositor),
            depositKey,
            recipient
        );
    }

    function _isWithinGasLimit(string memory operation)
        internal
        view
        returns (bool)
    {
        return isWithinGasLimit(operation);
    }
}
