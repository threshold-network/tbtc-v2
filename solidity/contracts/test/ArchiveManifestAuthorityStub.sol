// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "@openzeppelin/contracts/interfaces/IERC1271.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract ArchiveManifestAuthorityStub is IERC1271 {
    address public signer;
    bool public rejectSignatures;

    constructor(address _signer) {
        signer = _signer;
    }

    function setRejectSignatures(bool reject) external {
        rejectSignatures = reject;
    }

    function isValidSignature(bytes32 digest, bytes memory signature)
        external
        view
        override
        returns (bytes4)
    {
        if (!rejectSignatures && ECDSA.recover(digest, signature) == signer) {
            return IERC1271.isValidSignature.selector;
        }
        return 0xffffffff;
    }
}
