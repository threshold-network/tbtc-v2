// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

/* solhint-disable avoid-low-level-calls, no-inline-assembly */

/// @notice Test helper that drives the audit regression for the
///         `code.length == 0` EOA check on L2 rebate entry points. While a
///         contract is still executing its constructor its own code length is
///         zero, which would have allowed an intermediate contract to pass
///         the pre-fix guard. This helper issues the target call from its
///         constructor so the test can verify that the tightened
///         `tx.origin == msg.sender` guard rejects it.
contract ConstructorRebateCaller {
    constructor(address target, bytes memory data) {
        // slither-disable-next-line low-level-calls
        (bool success, bytes memory ret) = target.call(data);
        if (!success) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}
