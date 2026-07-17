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

/// @title Core Logic Unit Tests for StarkNetBitcoinDepositor
/// @notice Comprehensive unit tests for all core contract functions with edge cases
/// @dev Following Memory Bank TDD methodology - RED phase implementation
contract CoreLogicTests is Test, TestSetup, GasReporter {
    StarkNetBitcoinDepositor public depositor;
    MockStarkGateBridge public mockStarkGateBridge;
    MockTBTCToken public mockTBTCToken;
    MockTBTCBridge public mockTBTCBridge;
    MockTBTCVault public mockTBTCVault;

    // Test addresses and values
    address public owner = address(0x1);
    address public user = address(0x2);
    address public unauthorized = address(0x3);
    uint256 public starkNetRecipient =
        uint256(
            0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276
        );

    // Test constants
    uint256 public constant INITIAL_MESSAGE_FEE = 0.01 ether;
    uint256 public constant DEPOSIT_AMOUNT = 1 ether;
    uint256 public constant DEFAULT_DEPOSIT_KEY = 12345;
    bytes32 public constant DEPOSIT_KEY_BYTES32 = bytes32(DEFAULT_DEPOSIT_KEY);

    // Gas limits for performance validation
    uint256 public constant GAS_LIMIT_CONSTRUCTOR = 2_000_000;
    uint256 public constant GAS_LIMIT_FINALIZE_DEPOSIT = 500_000;
    uint256 public constant GAS_LIMIT_UPDATE_FEE = 100_000;
    uint256 public constant GAS_LIMIT_QUOTE_FINALIZE = 30_000;
    uint256 public constant GAS_LIMIT_TRANSFER_TBTC = 150_000;

    function setUp() public {
        // Deploy mock contracts
        mockStarkGateBridge = new MockStarkGateBridge();
        mockTBTCToken = new MockTBTCToken();
        mockTBTCBridge = new MockTBTCBridge();
        mockTBTCVault = new MockTBTCVault();

        // Setup mock dependencies
        mockTBTCVault.setTbtcToken(address(mockTBTCToken));
        _setupMockDeposit(DEFAULT_DEPOSIT_KEY, DEPOSIT_AMOUNT, user);

        // Deploy depositor contract
        vm.prank(owner);
        depositor = new StarkNetBitcoinDepositor(
            address(mockTBTCBridge),
            address(mockTBTCVault),
            address(mockStarkGateBridge),
            INITIAL_MESSAGE_FEE
        );

        // Initialize gas reporter
        initGasReporter();
        setGasLimit("constructor", GAS_LIMIT_CONSTRUCTOR);
        setGasLimit("finalizeDeposit", GAS_LIMIT_FINALIZE_DEPOSIT);
        setGasLimit("updateFee", GAS_LIMIT_UPDATE_FEE);
        setGasLimit("quoteFinalizeDeposit", GAS_LIMIT_QUOTE_FINALIZE);
        setGasLimit("transferTbtc", GAS_LIMIT_TRANSFER_TBTC);
    }

    // ========== Constructor Tests ==========

    function test_Constructor_Success() public {
        uint256 gasStart = gasleft();

        vm.prank(owner);
        StarkNetBitcoinDepositor newDepositor = new StarkNetBitcoinDepositor(
            address(mockTBTCBridge),
            address(mockTBTCVault),
            address(mockStarkGateBridge),
            INITIAL_MESSAGE_FEE
        );

        uint256 gasUsed = gasStart - gasleft();
        recordGasUsage("constructor", gasUsed);

        // Validate state initialization
        assertEq(
            address(newDepositor.starkGateBridge()),
            address(mockStarkGateBridge)
        );
        assertEq(address(newDepositor.tbtcToken()), address(mockTBTCToken));
        assertEq(newDepositor.l1ToL2MessageFee(), INITIAL_MESSAGE_FEE);
        assertEq(newDepositor.owner(), owner);
    }

    function test_Constructor_RevertInvalidTBTCBridge() public {
        vm.expectRevert("Invalid tBTC Bridge");
        vm.prank(owner);
        new StarkNetBitcoinDepositor(
            address(0), // Invalid bridge
            address(mockTBTCVault),
            address(mockStarkGateBridge),
            INITIAL_MESSAGE_FEE
        );
    }

    function test_Constructor_RevertInvalidTBTCVault() public {
        vm.expectRevert("Invalid tBTC Vault");
        vm.prank(owner);
        new StarkNetBitcoinDepositor(
            address(mockTBTCBridge),
            address(0), // Invalid vault
            address(mockStarkGateBridge),
            INITIAL_MESSAGE_FEE
        );
    }

    function test_Constructor_RevertInvalidStarkGateBridge() public {
        vm.expectRevert("Invalid StarkGate bridge");
        vm.prank(owner);
        new StarkNetBitcoinDepositor(
            address(mockTBTCBridge),
            address(mockTBTCVault),
            address(0), // Invalid bridge
            INITIAL_MESSAGE_FEE
        );
    }

    function test_Constructor_RevertInvalidMessageFee() public {
        vm.expectRevert("Invalid L1->L2 message fee");
        vm.prank(owner);
        new StarkNetBitcoinDepositor(
            address(mockTBTCBridge),
            address(mockTBTCVault),
            address(mockStarkGateBridge),
            0 // Invalid fee
        );
    }

    function test_Constructor_EmitsInitializationEvent() public {
        vm.expectEmit(true, true, false, true);
        emit StarkNetBitcoinDepositor.StarkNetBitcoinDepositorInitialized(
            address(mockStarkGateBridge),
            address(mockTBTCToken)
        );

        vm.prank(owner);
        new StarkNetBitcoinDepositor(
            address(mockTBTCBridge),
            address(mockTBTCVault),
            address(mockStarkGateBridge),
            INITIAL_MESSAGE_FEE
        );
    }

    // ========== initializeDeposit Tests ==========

    function test_InitializeDeposit_Success() public {
        IBridgeTypes.BitcoinTxInfo memory fundingTx = _createValidFundingTx();
        IBridgeTypes.DepositRevealInfo memory reveal = _createValidReveal();
        bytes32 l2DepositOwner = bytes32(starkNetRecipient);

        // Setup mock to return specific deposit key
        mockTBTCBridge.setNextDepositKey(DEFAULT_DEPOSIT_KEY);

        vm.expectEmit(true, true, false, true);
        emit StarkNetBitcoinDepositor.DepositInitializedForStarkNet(
            DEPOSIT_KEY_BYTES32,
            starkNetRecipient
        );

        depositor.initializeDeposit(fundingTx, reveal, l2DepositOwner);

        // Verify state changes
        assertTrue(mockTBTCBridge.wasInitializeDepositCalled());
    }

    function test_InitializeDeposit_RevertZeroL2DepositOwner() public {
        IBridgeTypes.BitcoinTxInfo memory fundingTx = _createValidFundingTx();
        IBridgeTypes.DepositRevealInfo memory reveal = _createValidReveal();

        vm.expectRevert("Invalid L2 deposit owner");
        depositor.initializeDeposit(fundingTx, reveal, bytes32(0));
    }

    function test_InitializeDeposit_CorrectEventParameters() public {
        IBridgeTypes.BitcoinTxInfo memory fundingTx = _createValidFundingTx();
        IBridgeTypes.DepositRevealInfo memory reveal = _createValidReveal();
        bytes32 l2DepositOwner = bytes32(starkNetRecipient);

        mockTBTCBridge.setNextDepositKey(DEFAULT_DEPOSIT_KEY);

        // Test that event contains correct indexed parameters
        vm.expectEmit(true, true, false, true);
        emit StarkNetBitcoinDepositor.DepositInitializedForStarkNet(
            DEPOSIT_KEY_BYTES32,
            starkNetRecipient
        );

        depositor.initializeDeposit(fundingTx, reveal, l2DepositOwner);
    }

    // ========== finalizeDeposit Tests ==========

    function test_FinalizeDeposit_Success() public {
        // Setup: Prepare valid deposit state
        _setupValidDepositForFinalization();

        vm.deal(address(this), INITIAL_MESSAGE_FEE);
        mockStarkGateBridge.setDepositWithMessageReturn(12345);

        uint256 gasStart = gasleft();
        depositor.finalizeDeposit{value: INITIAL_MESSAGE_FEE}(
            DEPOSIT_KEY_BYTES32
        );
        uint256 gasUsed = gasStart - gasleft();

        recordGasUsage("finalizeDeposit", gasUsed);

        // Verify bridge interaction
        assertTrue(mockStarkGateBridge.wasDepositWithMessageCalled());
        assertEq(mockStarkGateBridge.getDepositCount(), 1);
    }

    function test_FinalizeDeposit_RevertInsufficientFee() public {
        _setupValidDepositForFinalization();

        uint256 insufficientFee = INITIAL_MESSAGE_FEE - 1;
        vm.deal(address(this), insufficientFee);

        vm.expectRevert("Insufficient L1->L2 message fee");
        depositor.finalizeDeposit{value: insufficientFee}(DEPOSIT_KEY_BYTES32);
    }

    function test_FinalizeDeposit_EmitsTBTCBridgedEvent() public {
        _setupValidDepositForFinalization();

        vm.deal(address(this), INITIAL_MESSAGE_FEE);
        uint256 expectedMessageNonce = 12345;
        mockStarkGateBridge.setDepositWithMessageReturn(expectedMessageNonce);

        vm.expectEmit(true, true, false, true);
        emit StarkNetBitcoinDepositor.TBTCBridgedToStarkNet(
            DEPOSIT_KEY_BYTES32,
            starkNetRecipient,
            DEPOSIT_AMOUNT,
            expectedMessageNonce
        );

        depositor.finalizeDeposit{value: INITIAL_MESSAGE_FEE}(
            DEPOSIT_KEY_BYTES32
        );
    }

    function test_FinalizeDeposit_InvalidStarkNetAddress() public {
        // Setup deposit with zero StarkNet address
        mockTBTCVault.setDepositInfo(
            DEFAULT_DEPOSIT_KEY,
            DEPOSIT_AMOUNT,
            DEPOSIT_AMOUNT,
            bytes32(0) // Invalid StarkNet address
        );

        vm.deal(address(this), INITIAL_MESSAGE_FEE);

        vm.expectRevert("Invalid StarkNet address");
        depositor.finalizeDeposit{value: INITIAL_MESSAGE_FEE}(
            DEPOSIT_KEY_BYTES32
        );
    }

    function test_FinalizeDeposit_CorrectTokenApproval() public {
        _setupValidDepositForFinalization();

        vm.deal(address(this), INITIAL_MESSAGE_FEE);
        mockStarkGateBridge.setDepositWithMessageReturn(12345);

        uint256 initialAllowance = mockTBTCToken.allowance(
            address(depositor),
            address(mockStarkGateBridge)
        );

        depositor.finalizeDeposit{value: INITIAL_MESSAGE_FEE}(
            DEPOSIT_KEY_BYTES32
        );

        uint256 finalAllowance = mockTBTCToken.allowance(
            address(depositor),
            address(mockStarkGateBridge)
        );

        // Verify allowance was increased by the deposit amount
        assertEq(finalAllowance, initialAllowance + DEPOSIT_AMOUNT);
    }

    function test_FinalizeDeposit_CorrectBridgeParameters() public {
        _setupValidDepositForFinalization();

        vm.deal(address(this), INITIAL_MESSAGE_FEE);
        mockStarkGateBridge.setDepositWithMessageReturn(12345);

        depositor.finalizeDeposit{value: INITIAL_MESSAGE_FEE}(
            DEPOSIT_KEY_BYTES32
        );

        // Verify bridge was called with correct parameters
        MockStarkGateBridge.DepositCall memory lastCall = mockStarkGateBridge
            .getLastDepositCall();
        assertEq(lastCall.token, address(mockTBTCToken));
        assertEq(lastCall.amount, DEPOSIT_AMOUNT);
        assertEq(lastCall.l2Recipient, starkNetRecipient);
        assertEq(lastCall.message.length, 0); // Empty message array
        assertEq(lastCall.msgValue, INITIAL_MESSAGE_FEE);
    }

    // ========== quoteFinalizeDeposit Tests ==========

    function test_QuoteFinalizeDeposit_ReturnsCurrentFee() public {
        uint256 gasStart = gasleft();
        uint256 quotedFee = depositor.quoteFinalizeDeposit();
        uint256 gasUsed = gasStart - gasleft();

        recordGasUsage("quoteFinalizeDeposit", gasUsed);
        assertEq(quotedFee, INITIAL_MESSAGE_FEE);
    }

    function test_QuoteFinalizeDeposit_ReflectsUpdatedFee() public {
        uint256 newFee = 0.02 ether;

        vm.prank(owner);
        depositor.updateL1ToL2MessageFee(newFee);

        uint256 quotedFee = depositor.quoteFinalizeDeposit();
        assertEq(quotedFee, newFee);
    }

    function test_QuoteFinalizeDeposit_ConsistentWithStoredFee() public {
        uint256 quotedFee = depositor.quoteFinalizeDeposit();
        uint256 storedFee = depositor.l1ToL2MessageFee();
        assertEq(quotedFee, storedFee);
    }

    // ========== updateL1ToL2MessageFee Tests ==========

    function test_UpdateL1ToL2MessageFee_Success() public {
        uint256 newFee = 0.02 ether;

        vm.expectEmit(false, false, false, true);
        emit StarkNetBitcoinDepositor.L1ToL2MessageFeeUpdated(newFee);

        uint256 gasStart = gasleft();
        vm.prank(owner);
        depositor.updateL1ToL2MessageFee(newFee);
        uint256 gasUsed = gasStart - gasleft();

        recordGasUsage("updateFee", gasUsed);
        assertEq(depositor.l1ToL2MessageFee(), newFee);
    }

    function test_UpdateL1ToL2MessageFee_RevertNotOwner() public {
        vm.prank(unauthorized);
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

    function test_UpdateL1ToL2MessageFee_MaxUint256() public {
        uint256 maxFee = type(uint256).max;

        vm.prank(owner);
        depositor.updateL1ToL2MessageFee(maxFee);
        assertEq(depositor.l1ToL2MessageFee(), maxFee);
    }

    // ========== _transferTbtc Internal Logic Tests ==========
    // Note: _transferTbtc is internal, tested through finalizeDeposit

    function test_TransferTbtc_ValidatesStarkNetAddress() public {
        // Setup deposit with various address formats
        uint256[] memory testAddresses = new uint256[](3);
        testAddresses[0] = 1; // Minimal valid address
        testAddresses[1] = type(uint256).max; // Maximum address
        testAddresses[2] = 0x123456789abcdef; // Typical address

        for (uint256 i = 0; i < testAddresses.length; i++) {
            uint256 testDepositKey = DEFAULT_DEPOSIT_KEY + i;
            mockTBTCVault.setDepositInfo(
                testDepositKey,
                DEPOSIT_AMOUNT,
                DEPOSIT_AMOUNT,
                bytes32(testAddresses[i])
            );

            vm.deal(address(this), INITIAL_MESSAGE_FEE);
            mockStarkGateBridge.setDepositWithMessageReturn(12345);

            // Should not revert for valid addresses
            depositor.finalizeDeposit{value: INITIAL_MESSAGE_FEE}(
                bytes32(testDepositKey)
            );
        }
    }

    function test_TransferTbtc_HandlesZeroAmount() public {
        // Setup deposit with zero amount
        mockTBTCVault.setDepositInfo(
            DEFAULT_DEPOSIT_KEY,
            0, // Zero amount
            0,
            bytes32(starkNetRecipient)
        );

        vm.deal(address(this), INITIAL_MESSAGE_FEE);
        mockStarkGateBridge.setDepositWithMessageReturn(12345);

        depositor.finalizeDeposit{value: INITIAL_MESSAGE_FEE}(
            DEPOSIT_KEY_BYTES32
        );

        // Verify bridge was called even with zero amount
        assertTrue(mockStarkGateBridge.wasDepositWithMessageCalled());
    }

    function test_TransferTbtc_CorrectMessageFormat() public {
        _setupValidDepositForFinalization();

        vm.deal(address(this), INITIAL_MESSAGE_FEE);
        mockStarkGateBridge.setDepositWithMessageReturn(12345);

        depositor.finalizeDeposit{value: INITIAL_MESSAGE_FEE}(
            DEPOSIT_KEY_BYTES32
        );

        // Verify empty message array is passed to bridge
        MockStarkGateBridge.DepositCall memory lastCall = mockStarkGateBridge
            .getLastDepositCall();
        assertEq(lastCall.message.length, 0);
    }

    // ========== Gas Optimization Validation Tests ==========

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
        assertTrue(
            _isWithinGasLimit("quoteFinalizeDeposit"),
            "QuoteFinalizeDeposit exceeds gas limit"
        );
    }

    function test_GasUsage_TransferTbtcOptimization() public {
        _setupValidDepositForFinalization();

        vm.deal(address(this), INITIAL_MESSAGE_FEE);
        mockStarkGateBridge.setDepositWithMessageReturn(12345);

        // Measure gas specifically for the internal transfer logic
        uint256 gasStart = gasleft();
        depositor.finalizeDeposit{value: INITIAL_MESSAGE_FEE}(
            DEPOSIT_KEY_BYTES32
        );
        uint256 gasUsed = gasStart - gasleft();

        recordGasUsage("transferTbtc", gasUsed);
        assertTrue(
            gasUsed < GAS_LIMIT_TRANSFER_TBTC,
            "TransferTbtc exceeds gas limit"
        );
    }

    // ========== Edge Case Tests ==========

    function test_EdgeCase_LargeAmountDeposit() public {
        uint256 largeAmount = type(uint256).max / 2; // Avoid overflow

        mockTBTCVault.setDepositInfo(
            DEFAULT_DEPOSIT_KEY,
            largeAmount,
            largeAmount,
            bytes32(starkNetRecipient)
        );

        vm.deal(address(this), INITIAL_MESSAGE_FEE);
        mockStarkGateBridge.setDepositWithMessageReturn(12345);

        depositor.finalizeDeposit{value: INITIAL_MESSAGE_FEE}(
            DEPOSIT_KEY_BYTES32
        );

        MockStarkGateBridge.DepositCall memory lastCall = mockStarkGateBridge
            .getLastDepositCall();
        assertEq(lastCall.amount, largeAmount);
    }

    function test_EdgeCase_MaxMessageFee() public {
        _setupValidDepositForFinalization();

        uint256 maxFee = type(uint256).max;
        vm.prank(owner);
        depositor.updateL1ToL2MessageFee(maxFee);

        vm.deal(address(this), maxFee);
        mockStarkGateBridge.setDepositWithMessageReturn(12345);

        depositor.finalizeDeposit{value: maxFee}(DEPOSIT_KEY_BYTES32);

        assertTrue(mockStarkGateBridge.wasDepositWithMessageCalled());
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

    function _setupValidDepositForFinalization() internal {
        mockTBTCVault.setDepositInfo(
            DEFAULT_DEPOSIT_KEY,
            DEPOSIT_AMOUNT,
            DEPOSIT_AMOUNT,
            bytes32(starkNetRecipient)
        );
    }

    function _createValidFundingTx()
        internal
        pure
        returns (IBridgeTypes.BitcoinTxInfo memory)
    {
        return
            IBridgeTypes.BitcoinTxInfo({
                version: bytes4(0x01000000),
                inputVector: abi.encodePacked(bytes32(0x123)),
                outputVector: abi.encodePacked(bytes32(0x456)),
                locktime: bytes4(0x00000000)
            });
    }

    function _createValidReveal()
        internal
        pure
        returns (IBridgeTypes.DepositRevealInfo memory)
    {
        return
            IBridgeTypes.DepositRevealInfo({
                fundingOutputIndex: 0,
                blindingFactor: bytes8(0x1234567890abcdef),
                walletPubKeyHash: bytes20(
                    0x1234567890123456789012345678901234567890
                ),
                refundPubKeyHash: bytes20(
                    0x0987654321098765432109876543210987654321
                ),
                refundLocktime: bytes4(0x12345678),
                vault: address(0x1234567890123456789012345678901234567890)
            });
    }

    function _isWithinGasLimit(string memory operation)
        internal
        view
        returns (bool)
    {
        return isWithinGasLimit(operation);
    }
}
