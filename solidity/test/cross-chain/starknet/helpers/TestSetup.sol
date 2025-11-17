// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import {Test} from "forge-std/Test.sol";
import {StarkNetBitcoinDepositor} from "../../../../contracts/cross-chain/starknet/StarkNetBitcoinDepositor.sol";
import {MockTBTCBridge} from "../mocks/MockTBTCBridge.sol";
import {MockTBTCVault} from "../mocks/MockTBTCVault.sol";
import {MockTBTCToken} from "../mocks/MockTBTCToken.sol";
import {MockStarkGateBridge} from "../mocks/MockStarkGateBridge.sol";
import {IBridgeTypes} from "../../../../contracts/integrator/IBridge.sol";

contract TestSetup is Test {
    // Contracts
    StarkNetBitcoinDepositor public depositor;
    MockTBTCBridge public mockBridge;
    MockTBTCVault public mockVault;
    MockTBTCToken public mockToken;
    MockStarkGateBridge public mockStarkGateBridge;

    // Test accounts
    address public owner;
    address public nonOwner;
    address public user1;
    address public user2;

    // Test constants
    uint256 public constant INITIAL_FEE = 0.01 ether;
    uint256 public constant TEST_AMOUNT = 1 ether;
    bytes32 public constant TEST_L2_RECIPIENT =
        bytes32(uint256(0x0123456789abcdef));

    // Test data structures
    IBridgeTypes.BitcoinTxInfo public defaultFundingTx;
    IBridgeTypes.DepositRevealInfo public defaultReveal;

    function setUp() public virtual {
        // Set up accounts
        owner = address(this);
        nonOwner = makeAddr("nonOwner");
        user1 = makeAddr("user1");
        user2 = makeAddr("user2");

        // Deploy mock contracts
        mockToken = new MockTBTCToken();
        mockBridge = new MockTBTCBridge();
        mockVault = new MockTBTCVault(address(mockToken));
        mockStarkGateBridge = new MockStarkGateBridge();

        // Deploy main contract
        depositor = new StarkNetBitcoinDepositor(
            address(mockBridge),
            address(mockVault),
            address(mockStarkGateBridge),
            INITIAL_FEE
        );

        // Set up default test data
        setupDefaultTestData();
    }

    function setupDefaultTestData() internal {
        defaultFundingTx = IBridgeTypes.BitcoinTxInfo({
            version: bytes4(0x01000000),
            inputVector: hex"01",
            outputVector: hex"02",
            locktime: bytes4(0x00000000)
        });

        defaultReveal = IBridgeTypes.DepositRevealInfo({
            fundingOutputIndex: 0,
            blindingFactor: bytes8(0x1234567890abcdef),
            walletPubKeyHash: bytes20(keccak256(abi.encode("wallet"))),
            refundPubKeyHash: bytes20(keccak256(abi.encode("refund"))),
            refundLocktime: bytes4(0x00000000),
            vault: address(mockVault)
        });
    }

    // Helper functions for common test operations
    function initializeTestDeposit() public returns (bytes32 depositKey) {
        depositKey = calculateDepositKey(defaultFundingTx, defaultReveal);
        depositor.initializeDeposit(
            defaultFundingTx,
            defaultReveal,
            TEST_L2_RECIPIENT
        );
        return depositKey;
    }

    function initializeTestDepositWithCustomData(
        IBridgeTypes.BitcoinTxInfo memory fundingTx,
        IBridgeTypes.DepositRevealInfo memory reveal,
        bytes32 l2Recipient
    ) public returns (bytes32 depositKey) {
        depositKey = calculateDepositKey(fundingTx, reveal);
        depositor.initializeDeposit(fundingTx, reveal, l2Recipient);
        return depositKey;
    }

    function calculateDepositKey(
        IBridgeTypes.BitcoinTxInfo memory fundingTx,
        IBridgeTypes.DepositRevealInfo memory reveal
    ) public pure returns (bytes32) {
        bytes32 fundingTxHash = keccak256(
            abi.encodePacked(
                fundingTx.version,
                fundingTx.inputVector,
                fundingTx.outputVector,
                fundingTx.locktime
            )
        );
        return
            bytes32(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            fundingTxHash,
                            reveal.fundingOutputIndex
                        )
                    )
                )
            );
    }

    function simulateTBTCMinting(bytes32 depositKey, uint256 amount) public {
        // Mint tBTC to the depositor contract
        mockToken.mint(address(depositor), amount);

        // Mark as finalized in vault
        mockVault.setOptimisticMintingFinalized(uint256(depositKey));
    }

    function createTestUsers(uint256 count) public returns (address[] memory) {
        address[] memory users = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            users[i] = makeAddr(string(abi.encodePacked("user", i)));
        }
        return users;
    }

    function generateTestFundingTx(uint256 seed)
        public
        pure
        returns (IBridgeTypes.BitcoinTxInfo memory)
    {
        return
            IBridgeTypes.BitcoinTxInfo({
                version: bytes4(uint32(seed)),
                inputVector: abi.encodePacked(seed),
                outputVector: abi.encodePacked(seed + 1),
                locktime: bytes4(uint32(seed + 2))
            });
    }

    function generateTestReveal(address vault, uint256 seed)
        public
        pure
        returns (IBridgeTypes.DepositRevealInfo memory)
    {
        return
            IBridgeTypes.DepositRevealInfo({
                fundingOutputIndex: uint32(seed),
                blindingFactor: bytes8(uint64(seed)),
                walletPubKeyHash: bytes20(
                    keccak256(abi.encode("wallet", seed))
                ),
                refundPubKeyHash: bytes20(
                    keccak256(abi.encode("refund", seed))
                ),
                refundLocktime: bytes4(uint32(seed + 100)),
                vault: vault
            });
    }

    function generateTestRecipient(uint256 seed) public pure returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode("recipient", seed))));
    }

    // Gas measurement helpers
    struct GasMeasurement {
        uint256 gasStart;
        uint256 gasUsed;
        string operation;
    }

    function startGasMeasurement(string memory operation)
        public
        returns (GasMeasurement memory)
    {
        return
            GasMeasurement({
                gasStart: gasleft(),
                gasUsed: 0,
                operation: operation
            });
    }

    function endGasMeasurement(GasMeasurement memory measurement)
        public
        view
        returns (uint256 gasUsed)
    {
        gasUsed = measurement.gasStart - gasleft();
        return gasUsed;
    }

    // Event testing helpers
    function expectDepositInitializedEvent(
        bytes32 depositKey,
        bytes32 l2Recipient
    ) public {
        vm.expectEmit(true, true, true, true);
        emit DepositInitializedForStarkNet(depositKey, uint256(l2Recipient));
    }

    function expectTBTCBridgedEvent(
        bytes32 depositKey,
        bytes32 l2Recipient,
        uint256 amount,
        uint256 messageNonce
    ) public {
        vm.expectEmit(true, true, true, true);
        emit TBTCBridgedToStarkNet(
            depositKey,
            uint256(l2Recipient),
            amount,
            messageNonce
        );
    }

    function expectFeeUpdatedEvent(uint256 newFee) public {
        vm.expectEmit(true, true, true, true);
        emit L1ToL2MessageFeeUpdated(newFee);
    }

    // Events
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
    event StarkNetBitcoinDepositorInitialized(
        address starkGateBridge,
        address tbtcToken
    );
}
