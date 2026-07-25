// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "@openzeppelin/contracts/interfaces/IERC1271.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract EcdsaFraudCutoverAuthorityStub is IERC1271 {
    using ECDSA for bytes32;

    bytes4 internal constant MAGIC_VALUE = 0x1626ba7e;
    address public immutable owner;

    constructor(address _owner) {
        owner = _owner;
    }

    function isValidSignature(bytes32 hash, bytes memory signature)
        external
        view
        override
        returns (bytes4)
    {
        return hash.recover(signature) == owner ? MAGIC_VALUE : bytes4(0);
    }

    function execute(address target, bytes calldata data)
        external
        returns (bytes memory)
    {
        require(msg.sender == owner, "Not owner");
        // solhint-disable-next-line avoid-low-level-calls
        (bool succeeded, bytes memory result) = target.call(data);
        if (!succeeded) {
            // solhint-disable-next-line no-inline-assembly
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
        return result;
    }
}

contract EcdsaFraudCutoverForceEtherStub {
    constructor() payable {}

    function forceSend(address payable recipient) external {
        selfdestruct(recipient);
    }
}
