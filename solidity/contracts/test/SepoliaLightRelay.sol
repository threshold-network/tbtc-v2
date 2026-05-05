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

import "../relay/LightRelay.sol";

/// @title Sepolia Light Relay
/// @notice SepoliaLightRelay is a stub version of LightRelay intended to be
///         used on the Sepolia test network. It allows to set the relay's
///         difficulty based on arbitrary Bitcoin headers thus effectively
///         bypass the validation of difficulties of Bitcoin testnet blocks.
///         Since difficulty in Bitcoin testnet often falls to `1` it would not
///         be possible to validate blocks with the real LightRelay.
/// @dev Notice that SepoliaLightRelay is derived from LightRelay so that the two
///      contracts have the same API and correct bindings can be generated.
contract SepoliaLightRelay is LightRelay {
    using BTCUtils for bytes;
    using BTCUtils for uint256;

    /// @dev Bitcoin minimum-difficulty target (compact bits `0x1d00ffff`).
    /// Testnet4 emits blocks at this target when block spacing exceeds 20 min.
    uint256 private constant MIN_DIFFICULTY_TARGET =
        0xffff0000000000000000000000000000000000000000000000000000;

    /// @notice Sets the current and previous difficulty based on the difficulty
    ///         inferred from the provided Bitcoin headers.
    function setDifficultyFromHeaders(bytes memory bitcoinHeaders)
        external
        onlyOwner
    {
        uint256 firstHeaderDiff = bitcoinHeaders
            .extractTarget()
            .calculateDifficulty();

        currentEpochDifficulty = firstHeaderDiff;
        prevEpochDifficulty = firstHeaderDiff;
    }

    /// @inheritdoc LightRelay
    function isValidPreRetargetTarget(uint256 headerTarget, uint256 oldTarget)
        internal
        view
        override
        returns (bool)
    {
        return
            headerTarget == oldTarget || headerTarget == MIN_DIFFICULTY_TARGET;
    }

    /// @inheritdoc LightRelay
    function isValidPostRetargetTarget(
        uint256 headerTarget,
        uint256 minedTarget
    ) internal view override returns (bool) {
        return
            headerTarget == minedTarget ||
            headerTarget == MIN_DIFFICULTY_TARGET;
    }
}
