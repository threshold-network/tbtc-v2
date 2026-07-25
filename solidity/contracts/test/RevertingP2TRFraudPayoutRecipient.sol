// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

/// @notice Test-only challenge forwarder whose receive hook always rejects
///         ETH. Resolved challenges must still credit it, and it must be able
///         to withdraw that credit to a different receiver.
contract RevertingP2TRFraudPayoutRecipient {
    receive() external payable {
        revert("ETH rejected");
    }

    function forward(address target, bytes calldata data) external payable {
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory result) = target.call{value: msg.value}(
            data
        );
        if (!success) {
            // solhint-disable-next-line no-inline-assembly
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }

    function withdraw(address router, address payable receiver) external {
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory result) = router.call(
            abi.encodeWithSignature(
                "withdrawP2TRFraudPayout(address)",
                receiver
            )
        );
        if (!success) {
            // solhint-disable-next-line no-inline-assembly
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }
}
