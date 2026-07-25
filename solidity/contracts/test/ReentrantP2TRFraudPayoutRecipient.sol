// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

contract ReentrantP2TRFraudPayoutRecipient {
    address public immutable router;
    bool public reentryAttempted;
    bool public reentrySucceeded;

    constructor(address _router) {
        router = _router;
    }

    receive() external payable {
        reentryAttempted = true;
        // solhint-disable-next-line avoid-low-level-calls
        (reentrySucceeded, ) = router.call(
            abi.encodeWithSignature(
                "withdrawP2TRFraudPayout(address)",
                address(this)
            )
        );
    }

    function forward(bytes calldata data) external payable {
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory result) = router.call{value: msg.value}(
            data
        );
        if (!success) {
            // solhint-disable-next-line no-inline-assembly
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }

    function withdraw() external {
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory result) = router.call(
            abi.encodeWithSignature(
                "withdrawP2TRFraudPayout(address)",
                address(this)
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
