// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../cross-chain/starknet/StarkNetBitcoinDepositor.sol";

/// @title Reentrancy Attacker
/// @notice Mock contract to test reentrancy protection
contract ReentrancyAttacker {
    StarkNetBitcoinDepositor public immutable target;
    uint256 public attackCount;
    bool public attacking;

    constructor(address _target) {
        target = StarkNetBitcoinDepositor(payable(_target));
    }

    function attack() external payable {
        attacking = true;
        attackCount = 0;

        // Try to call finalizeDeposit
        uint256 fakeDepositKey = uint256(keccak256(abi.encodePacked("attack")));
        target.finalizeDeposit{value: msg.value}(fakeDepositKey);
    }

    // Fallback function that tries to re-enter
    receive() external payable {
        if (attacking && attackCount < 2) {
            attackCount++;
            // Try to re-enter finalizeDeposit
            uint256 fakeDepositKey = uint256(
                keccak256(abi.encodePacked("reenter", attackCount))
            );
            target.finalizeDeposit{value: 0}(fakeDepositKey);
        }
    }

    // Allow withdrawal of any stuck funds
    function withdraw() external {
        payable(msg.sender).transfer(address(this).balance);
    }
}
