// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import {Test} from "forge-std/Test.sol";

import {BitcoinTx} from "../contracts/bridge/BitcoinTx.sol";
import {BridgeState} from "../contracts/bridge/BridgeState.sol";

/// @notice Exposes the internal script helpers so they can be driven directly.
///         `extractPubKeyHash` takes a storage pointer it never reads, so any
///         storage variable satisfies it.
contract BitcoinScriptHarness {
    BridgeState.Storage internal state;

    function makeP2PKHScript(bytes20 pubKeyHash) external pure returns (bytes26) {
        return BitcoinTx.makeP2PKHScript(pubKeyHash);
    }

    function makeP2WPKHScript(bytes20 pubKeyHash)
        external
        pure
        returns (bytes23)
    {
        return BitcoinTx.makeP2WPKHScript(pubKeyHash);
    }

    function extractPubKeyHash(bytes memory output)
        external
        view
        returns (bytes20)
    {
        return BitcoinTx.extractPubKeyHash(state, output);
    }
}

/// @notice Property tests for the Bitcoin output scripts the Bridge builds and
///         parses.
///
///         These are pure functions over bytes, which is where fuzzing earns
///         its keep and where the TypeScript suite is at its most awkward —
///         every case there is a hand-written hex literal, so it tests the
///         handful of values someone thought to write down.
///
///         The property that matters is round-tripping: a script the Bridge
///         builds for a key hash must be one the Bridge parses back to the same
///         key hash. `extractPubKeyHash` rebuilds the expected script and
///         compares, so builder and parser have to agree for every possible
///         input, not just the sampled ones.
contract BitcoinScriptTest is Test {
    BitcoinScriptHarness internal harness;

    function setUp() public {
        harness = new BitcoinScriptHarness();
    }

    /// @dev An output is an 8-byte value followed by the script.
    function _output(uint64 value, bytes memory script)
        private
        pure
        returns (bytes memory)
    {
        return bytes.concat(bytes8(value), script);
    }

    function testFuzz_p2pkhRoundTrips(bytes20 pubKeyHash, uint64 value) public {
        bytes memory output = _output(
            value,
            bytes.concat(harness.makeP2PKHScript(pubKeyHash))
        );

        assertEq(harness.extractPubKeyHash(output), pubKeyHash);
    }

    function testFuzz_p2wpkhRoundTrips(bytes20 pubKeyHash, uint64 value) public {
        bytes memory output = _output(
            value,
            bytes.concat(harness.makeP2WPKHScript(pubKeyHash))
        );

        assertEq(harness.extractPubKeyHash(output), pubKeyHash);
    }

    /// @dev The key hash occupies its own field; the value must not bleed into
    ///      it. Building the same key hash under two different values has to
    ///      produce the same script.
    function testFuzz_scriptIndependentOfOutputValue(
        bytes20 pubKeyHash,
        uint64 valueA,
        uint64 valueB
    ) public view {
        bytes26 script = harness.makeP2PKHScript(pubKeyHash);

        assertEq(
            harness.extractPubKeyHash(_output(valueA, bytes.concat(script))),
            harness.extractPubKeyHash(_output(valueB, bytes.concat(script)))
        );
    }

    /// @dev Distinct key hashes must not collide into one script. A masking or
    ///      shifting error in the builders would show up here and nowhere in a
    ///      fixed-vector test.
    function testFuzz_distinctKeyHashesGiveDistinctScripts(
        bytes20 a,
        bytes20 b
    ) public view {
        vm.assume(a != b);

        assertTrue(harness.makeP2PKHScript(a) != harness.makeP2PKHScript(b));
        assertTrue(harness.makeP2WPKHScript(a) != harness.makeP2WPKHScript(b));
    }

    /// @dev The constant framing bytes are the script's identity. P2PKH is
    ///      <0x1976a914> <20-byte PKH> <0x88ac>.
    function testFuzz_p2pkhFraming(bytes20 pubKeyHash) public view {
        bytes memory script = bytes.concat(harness.makeP2PKHScript(pubKeyHash));

        assertEq(script.length, 26);
        assertEq(bytes4(script[0]) >> 24, bytes4(hex"19") >> 24); // total length
        assertEq(uint8(script[1]), 0x76); // OP_DUP
        assertEq(uint8(script[2]), 0xa9); // OP_HASH160
        assertEq(uint8(script[3]), 0x14); // push 20 bytes
        assertEq(uint8(script[24]), 0x88); // OP_EQUALVERIFY
        assertEq(uint8(script[25]), 0xac); // OP_CHECKSIG
    }

    /// @dev P2WPKH is <0x160014> <20-byte PKH>.
    function testFuzz_p2wpkhFraming(bytes20 pubKeyHash) public view {
        bytes memory script = bytes.concat(harness.makeP2WPKHScript(pubKeyHash));

        assertEq(script.length, 23);
        assertEq(uint8(script[0]), 0x16); // total length
        assertEq(uint8(script[1]), 0x00); // OP_0
        assertEq(uint8(script[2]), 0x14); // push 20 bytes
    }

    /// @dev Only the two supported script lengths are accepted. Anything else
    ///      must be rejected rather than parsed into a plausible key hash.
    function testFuzz_rejectsUnsupportedScriptLength(
        bytes20 pubKeyHash,
        uint8 extra
    ) public {
        vm.assume(extra > 0 && extra < 32);

        bytes memory script = bytes.concat(
            harness.makeP2PKHScript(pubKeyHash),
            new bytes(extra)
        );

        vm.expectRevert();
        harness.extractPubKeyHash(_output(0, script));
    }
}
