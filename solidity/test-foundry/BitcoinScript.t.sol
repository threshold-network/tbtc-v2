// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import {Test} from "forge-std/Test.sol";
import {stdError} from "forge-std/StdError.sol";

import {BitcoinTx} from "../contracts/bridge/BitcoinTx.sol";
import {BridgeState} from "../contracts/bridge/BridgeState.sol";

/// @notice Exposes the internal script helpers so they can be driven directly.
///         `extractPubKeyHash` takes a storage pointer it never reads, so any
///         storage variable satisfies it.
contract BitcoinScriptHarness {
    BridgeState.Storage internal state;

    function makeP2PKHScript(bytes20 pubKeyHash)
        external
        pure
        returns (bytes26)
    {
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

    function testFuzz_p2wpkhRoundTrips(bytes20 pubKeyHash, uint64 value)
        public
    {
        bytes memory output = _output(
            value,
            bytes.concat(harness.makeP2WPKHScript(pubKeyHash))
        );

        assertEq(harness.extractPubKeyHash(output), pubKeyHash);
    }

    /// @dev The constant framing bytes are the script's identity. P2PKH is
    ///      <0x1976a914> <20-byte PKH> <0x88ac>.
    function testFuzz_p2pkhFraming(bytes20 pubKeyHash) public view {
        bytes memory script = bytes.concat(harness.makeP2PKHScript(pubKeyHash));

        assertEq(uint8(script[0]), 0x19); // total length
        assertEq(uint8(script[1]), 0x76); // OP_DUP
        assertEq(uint8(script[2]), 0xa9); // OP_HASH160
        assertEq(uint8(script[3]), 0x14); // push 20 bytes
        assertEq(uint8(script[24]), 0x88); // OP_EQUALVERIFY
        assertEq(uint8(script[25]), 0xac); // OP_CHECKSIG
    }

    /// @dev P2WPKH is <0x160014> <20-byte PKH>.
    function testFuzz_p2wpkhFraming(bytes20 pubKeyHash) public view {
        bytes memory script = bytes.concat(
            harness.makeP2WPKHScript(pubKeyHash)
        );

        assertEq(uint8(script[0]), 0x16); // total length
        assertEq(uint8(script[1]), 0x00); // OP_0
        assertEq(uint8(script[2]), 0x14); // push 20 bytes
    }

    /// @dev A script whose declared length prefix disagrees with the actual
    ///      output length is never parsed at all -- the underlying byte-
    ///      extraction helper's own self-consistency check rejects it before
    ///      the Bridge's `scriptLen == 26 || scriptLen == 23` gate is ever
    ///      reached. Anything else must be rejected rather than parsed into
    ///      a plausible key hash.
    function testFuzz_rejectsUnsupportedScriptLength(
        bytes20 pubKeyHash,
        uint8 extra
    ) public {
        vm.assume(extra > 0);

        bytes memory script = bytes.concat(
            harness.makeP2PKHScript(pubKeyHash),
            new bytes(extra)
        );

        vm.expectRevert("Output's public key hash must have 20 bytes");
        harness.extractPubKeyHash(_output(0, script));
    }

    /// @dev A P2SH output (24 bytes: OP_HASH160 <20-byte scriptHash> OP_EQUAL)
    ///      is the one script length that survives the underlying byte-extraction
    ///      helper with a clean 20-byte result while not matching either supported
    ///      script length, so the length-gate require is its only defense.
    function testFuzz_rejectsP2shOutput(bytes20 scriptHash) public {
        bytes memory script = bytes.concat(hex"17a914", scriptHash, hex"87");

        vm.expectRevert("Output must be P2PKH or P2WPKH");
        harness.extractPubKeyHash(_output(0, script));
    }

    /// @dev A P2WSH output (35 bytes: OP_0 <32-byte witness script hash>) is
    ///      the one other script length that survives the underlying byte-
    ///      extraction helper with a clean (32-byte) result while not
    ///      matching either supported script length; the 20-byte length
    ///      check, not the script-length gate, is its defense.
    function testFuzz_rejectsP2wshOutput(bytes32 witnessScriptHash) public {
        bytes memory script = bytes.concat(hex"220020", witnessScriptHash);

        vm.expectRevert("Output's public key hash must have 20 bytes");
        harness.extractPubKeyHash(_output(0, script));
    }

    /// @dev Corrupting any single FRAMING byte of an otherwise-valid P2PKH
    ///      script (the fixed opcode/length bytes at offsets 0,1,2,3,24,25 --
    ///      not the 20-byte hash payload) must be rejected. This is the one
    ///      thing the round-trip tests above cannot exercise: they only ever
    ///      feed scripts this same builder produced, so a regression that
    ///      weakens the underlying byte-extraction helper's own malformed-
    ///      script checks (tag match, push-length byte, suffix bytes) would
    ///      pass every test above undetected. Corrupting a payload byte
    ///      (offsets 4-23) instead is not tested here: that just yields a
    ///      different, equally valid hash, already covered by the round-trip
    ///      tests' full-range `pubKeyHash` fuzzing.
    function testFuzz_corruptedP2pkhFramingByteRejects(
        bytes20 pubKeyHash,
        uint8 xorMask,
        uint8 positionSeed
    ) public {
        vm.assume(xorMask != 0);
        uint8[6] memory framingOffsets = [uint8(0), 1, 2, 3, 24, 25];
        uint8 offset = framingOffsets[positionSeed % 6];

        bytes memory script = bytes.concat(harness.makeP2PKHScript(pubKeyHash));
        uint8 mutated = uint8(script[offset]) ^ xorMask;
        script[offset] = bytes1(mutated);

        // Offset 0 feeds BTCUtils' `_scriptLen + 1` checked-uint8 addition;
        // landing on exactly 0xff there overflows to a Panic instead of the
        // clean revert below -- pin that boundary explicitly rather than
        // assuming it away, since it is a real behavior for any caller
        // whose output happens to start with that byte. Every other framing
        // offset only ever feeds byte-equality checks (tag, push-length,
        // suffix), never arithmetic, so this boundary is unique to offset 0.
        if (offset == 0 && mutated == 0xff) {
            vm.expectRevert(stdError.arithmeticError);
        } else {
            vm.expectRevert("Output's public key hash must have 20 bytes");
        }
        harness.extractPubKeyHash(_output(0, script));
    }

    /// @dev Same property for P2WPKH: corrupting any of its three framing
    ///      bytes (offsets 0,1,2) must be rejected.
    function testFuzz_corruptedP2wpkhFramingByteRejects(
        bytes20 pubKeyHash,
        uint8 xorMask,
        uint8 positionSeed
    ) public {
        vm.assume(xorMask != 0);
        uint8[3] memory framingOffsets = [uint8(0), 1, 2];
        uint8 offset = framingOffsets[positionSeed % 3];

        bytes memory script = bytes.concat(
            harness.makeP2WPKHScript(pubKeyHash)
        );
        uint8 mutated = uint8(script[offset]) ^ xorMask;
        script[offset] = bytes1(mutated);

        // Same checked-uint8 `_scriptLen + 1` boundary as the P2PKH version
        // above, at offset 0; pinned rather than assumed away for the same
        // reason.
        if (offset == 0 && mutated == 0xff) {
            vm.expectRevert(stdError.arithmeticError);
        } else {
            vm.expectRevert("Output's public key hash must have 20 bytes");
        }
        harness.extractPubKeyHash(_output(0, script));
    }

    /// @dev Deterministic pin for the boundary the two fuzz tests above only
    ///      hit by chance -- roughly 1-in-1500 per P2PKH case and 1-in-760
    ///      per P2WPKH case (offset 0 is a 1-in-6 or 1-in-3 draw, times a
    ///      1-in-255 mask), independent of how many cases a given run
    ///      generates:
    ///      a script whose length-prefix byte is exactly 0xff makes BTCUtils'
    ///      `_scriptLen + 1` (checked uint8 arithmetic) overflow to a Panic
    ///      instead of the clean require revert. This runs unconditionally on
    ///      every invocation rather than depending on the fuzzer landing on
    ///      it. The mechanism is shared by P2PKH and P2WPKH -- the overflow
    ///      happens on the very first byte read, before any branch on script
    ///      type -- so one deterministic case covers both.
    function test_scriptLengthPrefix0xffPanics() public {
        bytes memory script = bytes.concat(
            harness.makeP2PKHScript(bytes20(uint160(1)))
        );
        script[0] = 0xff;

        vm.expectRevert(stdError.arithmeticError);
        harness.extractPubKeyHash(_output(0, script));
    }
}
