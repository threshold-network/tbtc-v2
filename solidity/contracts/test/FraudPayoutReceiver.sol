// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

/* solhint-disable avoid-low-level-calls, no-inline-assembly */

interface IFraudPayoutBridge {
    function claimFraudChallengePayout(address payable recipient) external;
}

/// @dev Exercises receivers that reject ETH or exceed the best-effort budget.
contract FraudPayoutReceiver {
    uint256 public mode;
    uint256 public received;
    uint256[8] public slots;
    bool public reentrySucceeded;

    function setMode(uint256 _mode) external {
        mode = _mode;
    }

    function execute(address target, bytes calldata data) external payable {
        (bool success, bytes memory result) = target.call{value: msg.value}(
            data
        );
        if (!success) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }

    receive() external payable {
        require(mode != 1, "Receiver rejects ETH");
        if (mode == 2) {
            // More than 100k even before Glamsterdam; the same fallback can
            // complete when a subsequent claim forwards enough gas.
            for (uint256 i = 0; i < slots.length; i++) {
                slots[i] = i + 1;
            }
        } else if (mode == 3) {
            (reentrySucceeded, ) = msg.sender.call(
                abi.encodeWithSelector(
                    IFraudPayoutBridge.claimFraudChallengePayout.selector,
                    payable(address(this))
                )
            );
        }
        received += msg.value;
    }
}
