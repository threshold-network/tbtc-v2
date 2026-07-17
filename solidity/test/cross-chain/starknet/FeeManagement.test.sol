// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import {Test} from "forge-std/Test.sol";
import {StarkNetBitcoinDepositor} from "../../../contracts/cross-chain/starknet/StarkNetBitcoinDepositor.sol";
import {MockTBTCBridge} from "./mocks/MockTBTCBridge.sol";
import {MockTBTCVault} from "./mocks/MockTBTCVault.sol";
import {MockTBTCToken} from "./mocks/MockTBTCToken.sol";
import {MockStarkGateBridge} from "./mocks/MockStarkGateBridge.sol";

contract FeeManagementTest is Test {
    StarkNetBitcoinDepositor public depositor;
    MockTBTCBridge public mockBridge;
    MockTBTCVault public mockVault;
    MockTBTCToken public mockToken;
    MockStarkGateBridge public mockStarkGateBridge;

    address public owner;
    address public nonOwner;

    uint256 public constant INITIAL_FEE = 0.01 ether;

    event L1ToL2MessageFeeUpdated(uint256 newFee);

    function setUp() public {
        owner = address(this);
        nonOwner = address(0x1234);

        // Deploy mocks
        mockToken = new MockTBTCToken();
        mockBridge = new MockTBTCBridge();
        mockVault = new MockTBTCVault(address(mockToken));
        mockStarkGateBridge = new MockStarkGateBridge();

        // Deploy depositor
        depositor = new StarkNetBitcoinDepositor(
            address(mockBridge),
            address(mockVault),
            address(mockStarkGateBridge),
            INITIAL_FEE
        );
    }

    function testUpdateL1ToL2MessageFeeSuccess() public {
        uint256 newFee = 0.02 ether;

        // Expect event emission
        vm.expectEmit(true, true, true, true);
        emit L1ToL2MessageFeeUpdated(newFee);

        // Update fee
        depositor.updateL1ToL2MessageFee(newFee);

        // Verify fee was updated
        assertEq(depositor.l1ToL2MessageFee(), newFee);
    }

    function testUpdateL1ToL2MessageFeeAccessControl() public {
        uint256 newFee = 0.02 ether;

        // Try to update as non-owner
        vm.prank(nonOwner);
        vm.expectRevert("Ownable: caller is not the owner");
        depositor.updateL1ToL2MessageFee(newFee);

        // Verify fee was not changed
        assertEq(depositor.l1ToL2MessageFee(), INITIAL_FEE);
    }

    function testUpdateL1ToL2MessageFeeZeroValue() public {
        // Try to set zero fee
        vm.expectRevert("Fee must be greater than 0");
        depositor.updateL1ToL2MessageFee(0);

        // Verify fee was not changed
        assertEq(depositor.l1ToL2MessageFee(), INITIAL_FEE);
    }

    function testQuoteFinalizeDeposit() public {
        // Test initial fee
        assertEq(depositor.quoteFinalizeDeposit(), INITIAL_FEE);

        // Update fee and test again
        uint256 newFee = 0.03 ether;
        depositor.updateL1ToL2MessageFee(newFee);
        assertEq(depositor.quoteFinalizeDeposit(), newFee);
    }

    function testMultipleFeeUpdates() public {
        uint256[] memory fees = new uint256[](3);
        fees[0] = 0.02 ether;
        fees[1] = 0.015 ether;
        fees[2] = 0.025 ether;

        for (uint256 i = 0; i < fees.length; i++) {
            // Expect event
            vm.expectEmit(true, true, true, true);
            emit L1ToL2MessageFeeUpdated(fees[i]);

            // Update fee
            depositor.updateL1ToL2MessageFee(fees[i]);

            // Verify
            assertEq(depositor.l1ToL2MessageFee(), fees[i]);
        }
    }
}
