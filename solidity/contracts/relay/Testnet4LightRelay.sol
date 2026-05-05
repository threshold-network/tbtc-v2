// SPDX-License-Identifier: GPL-3.0-only

// ██████████████     ▐████▌     ██████████████
// ██████████████     ▐████▌     ██████████████
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
// ██████████████     ▐████▌     ██████████████
// ██████████████     ▐████▌     ██████████████
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌

pragma solidity 0.8.17;

import {BTCUtils} from "@keep-network/bitcoin-spv-sol/contracts/BTCUtils.sol";

import "./LightRelay.sol";

/// @title Testnet4 Light Relay
/// @notice Testnet4LightRelay extends LightRelay with support for Bitcoin
///         testnet4's minimum-difficulty blocks. Testnet4 allows any block
///         whose timestamp exceeds the previous block's timestamp by more than
///         20 minutes to be mined at the minimum difficulty (DIFF1, compact
///         bits `0x1d00ffff`). These blocks may appear anywhere within an
///         epoch, including the pre- and post-retarget proof windows.
/// @dev The base LightRelay rejects any block whose target does not match the
///      expected epoch target. This subcontract overrides `_isTolerableTarget`
///      to additionally accept DIFF1 blocks, preserving mainnet security while
///      enabling testnet4 validation.
///
///      Constraint: a DIFF1 block cannot appear as the very first block of a
///      new epoch (the first post-retarget header in `retarget()`). That
///      position must carry the retargeted epoch target so the relay can
///      record it. DIFF1 is valid from the second post-retarget header onward.
contract Testnet4LightRelay is LightRelay {
    /// @dev Equal to `BTCUtils.DIFF1_TARGET` (compact bits `0x1d00ffff`).
    uint256 private constant DIFF1 = BTCUtils.DIFF1_TARGET;

    /// @inheritdoc LightRelay
    function _isTolerableTarget(
        uint256 target
    ) internal view virtual override returns (bool) {
        return target == DIFF1;
    }
}
