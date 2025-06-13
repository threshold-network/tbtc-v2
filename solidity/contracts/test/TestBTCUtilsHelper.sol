// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import {BTCUtils} from "@keep-network/bitcoin-spv-sol/contracts/BTCUtils.sol";

contract TestBTCUtilsHelper {
    using BTCUtils for bytes;

    function getScriptPayload(bytes memory script)
        public
        pure
        returns (bytes memory)
    {
        return script.extractHashAt(0, script.length);
    }
}
