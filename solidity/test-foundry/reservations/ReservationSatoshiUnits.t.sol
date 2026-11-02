// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import {Test} from "forge-std/Test.sol";

import {TBTC} from "../../contracts/token/TBTC.sol";
import {TBTCVault} from "../../contracts/vault/TBTCVault.sol";
import {ReservationVault} from "../../contracts/vault/ReservationVault.sol";

import {ReservationStackHarness} from "./ReservationStackHarness.sol";

/// @notice The Solidity half of spec row INV-704: one satoshi is 10^10 TBTC
///         base units.
/// @dev INV-704 asks for ONE assertion that ties the satoshi to the TBTC
///      base unit across the vault, the SDK and keep-core. This test is the
///      vault's side of that assertion, and it reads its numbers from the
///      SHARED cross-repo vector file
///      (`solidity/test/data/reservations/satoshi-units.json`) rather than
///      hard-coding them, so the file is the single source of truth for
///      all three repositories:
///
///        - tbtc-v2 Solidity: this test (Foundry),
///        - tbtc-v2 TypeScript: the SDK suite reads the same file,
///        - keep-core: `pkg/tbtcpg/reservation_satoshi_units_test.go` reads
///          the same file (a copy under
///          `pkg/tbtcpg/internal/test/testdata/`).
///
///      A factor that differs by a power of ten on any one side shows up
///      here as a mismatch against the vector, and the other two suites
///      fail the same way.
///
///      The file path is relative to the Foundry project root, which is
///      `solidity/`. Reading it needs a read grant for that path in
///      `foundry.toml`'s `fs_permissions`; the grant is scoped to the one
///      file so the suite keeps no blanket filesystem access.
///
///      The file also carries `roundingCases`, which pin the TRUNCATION
///      behaviour of the conversion: the vault's `amountToSatoshis`
///      (TBTCVault) floors the base-unit amount to whole satoshis and
///      leaves the remainder behind, so a base-unit amount that is not a
///      multiple of 10^10 converts to fewer satoshis than the naive
///      division would suggest. The SDK's `amountToSatoshi`
///      (`typescript/src/lib/utils/bitcoin.ts`) truncates the same way.
contract ReservationSatoshiUnitsTest is Test {
    /// @dev The shared cross-repo vector file, relative to the Foundry
    ///      project root (`solidity/`).
    string internal constant VECTOR_FILE =
        "test/data/reservations/satoshi-units.json";

    /// @dev The vector's own name, asserted so a file swapped for an
    ///      unrelated one cannot pass silently.
    string internal constant VECTOR_NAME = "satoshi-to-tbtc-base-units";

    /// @dev The vector's human-readable statement of the factor. The
    ///      keep-core suite asserts the same string against its copy of
    ///      the file, so the two sides are tied to each other by it.
    string internal constant VECTOR_CONSTANT =
        "1 satoshi = 10000000000 TBTC base units (1e10)";

    /// @dev One satoshi in TBTC base units. The vault's own constant is
    ///      asserted against this value separately, so this literal is
    ///      only the expectation, never the source of truth.
    uint256 internal constant EXPECTED_MULTIPLIER = 1e10;

    /// @dev The vault's default initiation fee, in basis points of the
    ///      gross anchored amount.
    uint16 internal constant EXPECTED_INITIATION_FEE_BPS = 40;

    /// @dev The vault's basis-points divisor.
    uint256 internal constant BASIS_POINTS = 10000;

    ReservationStackHarness internal stack;
    ReservationVault internal vault;
    TBTCVault internal tbtcVault;
    TBTC internal tbtc;

    function setUp() public {
        stack = new ReservationStackHarness();
        vault = stack.reservationVault();
        tbtcVault = stack.tbtcVault();
        tbtc = stack.tbtcToken();
    }

    // ---------------------------------------------------------------------
    // The vector file itself
    // ---------------------------------------------------------------------

    /// @notice The vector file is readable and states the factor the whole
    ///         system agrees on.
    /// @dev NEGATIVE CONTROL: change the `constant` string in the vector
    ///      file, or replace it with a file of another vector, and this
    ///      test fails.
    function test_vectorFileStatesTheAgreedFactor() public {
        string memory json = _readVector();

        assertEq(
            vm.parseJsonString(json, ".vector"),
            VECTOR_NAME,
            "the vector file must be the satoshi-to-base-unit vector"
        );
        assertEq(
            vm.parseJsonString(json, ".constant"),
            VECTOR_CONSTANT,
            "the vector file must state the agreed factor"
        );
        assertGt(
            vm.parseJsonUint(json, ".version"),
            0,
            "the vector file must carry a version"
        );
    }

    /// @notice The defining pair is present: one satoshi is 10000000000
    ///         base units. Without it the vector would not pin the factor.
    /// @dev NEGATIVE CONTROL: delete the pair with one satoshi from the
    ///      vector file and this test fails.
    function test_vectorFileContainsTheDefiningPair() public {
        (uint256[] memory satoshis, uint256[] memory baseUnits) = _readPairs();

        bool found = false;
        for (uint256 i = 0; i < satoshis.length; i++) {
            if (satoshis[i] == 1 && baseUnits[i] == EXPECTED_MULTIPLIER) {
                found = true;
                break;
            }
        }
        assertTrue(found, "the vector must contain the one-satoshi pair");
    }

    // ---------------------------------------------------------------------
    // The vault's own constant
    // ---------------------------------------------------------------------

    /// @notice The vault's `SATOSHI_MULTIPLIER` is exactly 10^10.
    /// @dev NEGATIVE CONTROL: change `ReservationVault.SATOSHI_MULTIPLIER`
    ///      from `10 ** 10` to `10 ** 9` and this test fails.
    function test_vaultSatoshiMultiplierIsTenToTheTen() public {
        assertEq(
            vault.SATOSHI_MULTIPLIER(),
            EXPECTED_MULTIPLIER,
            "one satoshi must be 1e10 TBTC base units"
        );
        assertEq(
            vault.SATOSHI_MULTIPLIER(),
            10 ** 10,
            "the vault's multiplier must be 10 ** 10"
        );
    }

    /// @notice For every pair in the shared vector, the vault's own
    ///         multiplier produces exactly the listed base units.
    /// @dev This is the assertion INV-704 asks for: the vault's constant,
    ///      read from the deployed contract, and the shared vector, read
    ///      from the file all three repositories share.
    ///
    ///      NEGATIVE CONTROL: change `ReservationVault.SATOSHI_MULTIPLIER`
    ///      from `10 ** 10` to `10 ** 9` and this test fails.
    function test_vaultMultiplierMatchesEverySharedVectorPair() public {
        (uint256[] memory satoshis, uint256[] memory baseUnits) = _readPairs();

        assertGt(
            satoshis.length,
            0,
            "the shared vector must list at least one pair"
        );

        for (uint256 i = 0; i < satoshis.length; i++) {
            assertEq(
                satoshis[i] * vault.SATOSHI_MULTIPLIER(),
                baseUnits[i],
                "the vault's multiplier must produce the vector's base units"
            );
        }
    }

    // ---------------------------------------------------------------------
    // The vault's fee arithmetic on a vector pair
    // ---------------------------------------------------------------------

    /// @notice The vault's initiation fee on a vector pair is
    ///         `floor(gross * bps / 10000)` and the depositor receives
    ///         `gross - fee`.
    /// @dev The fee is computed in TBTC base units, so it is the vector's
    ///      base-unit amount that the fee is taken from, not the satoshi
    ///      amount. The rounding is a FLOOR, so a gross amount that is
    ///      not a multiple of the divisor keeps the fraction in the vault.
    ///
    ///      NEGATIVE CONTROL: change the vault's `initiationFeeBps` default
    ///      from 40 to 41, or change `ReservationVault.SATOSHI_MULTIPLIER`
    ///      to `10 ** 9`, and this test fails.
    function test_vaultFeeArithmeticOnASharedVectorPair() public {
        assertEq(
            vault.initiationFeeBps(),
            EXPECTED_INITIATION_FEE_BPS,
            "the vault's default initiation fee must be 40 bps"
        );

        (uint256[] memory satoshis, uint256[] memory baseUnits) = _readPairs();

        // The pair the fee arithmetic is checked on: the smallest listed
        // one, so the fee is a small but non-zero number of base units.
        uint256 satoshisIn = satoshis[0];
        uint256 gross = baseUnits[0];

        uint256 fee = (gross * vault.initiationFeeBps()) / BASIS_POINTS;
        uint256 net = gross - fee;

        // The fee is the floor of the gross amount times the rate.
        assertEq(
            fee,
            (gross * EXPECTED_INITIATION_FEE_BPS) / BASIS_POINTS,
            "the fee must be the floor of gross times bps over 10000"
        );
        assertEq(
            fee,
            40_000_000,
            "one satoshi at 40 bps must cost 40000000 base units"
        );
        assertEq(
            net,
            gross - 40_000_000,
            "the depositor must receive gross minus fee"
        );

        // The production credit path, run against the real stack: the
        // depositor's balance must move by exactly `net` and the vault
        // must retain exactly `fee`.
        address depositor = address(0xDE50);
        uint256 vaultBalanceBefore = tbtc.balanceOf(address(vault));

        stack.creditVault(depositor, uint64(satoshisIn));

        assertEq(
            tbtc.balanceOf(depositor),
            net,
            "the depositor must receive gross minus fee"
        );
        assertEq(
            tbtc.balanceOf(address(vault)) - vaultBalanceBefore,
            fee,
            "the vault must retain the initiation fee"
        );

        // The gross amount was minted, so the total supply grew by the
        // gross base units, not by the net amount.
        assertEq(tbtc.totalSupply(), gross, "the gross amount must be minted");
    }

    // ---------------------------------------------------------------------
    // The vault's mint path uses the same constant
    // ---------------------------------------------------------------------

    /// @notice The TBTC vault's own constant is the same factor, and its
    ///         `amountToSatoshis` inverts it for every vector pair.
    /// @dev The vault's mint path is the other half of the vault's
    ///      constant: the reservation vault mints through
    ///      `TBTCVault.mint(satoshis * SATOSHI_MULTIPLIER)`, so the two
    ///      constants must agree on the same factor the vector pins. The
    ///      gross mint itself is exercised by
    ///      `test_vaultFeeArithmeticOnASharedVectorPair`, which runs the
    ///      production credit path.
    ///
    ///      NEGATIVE CONTROL: change `ReservationVault.SATOSHI_MULTIPLIER`
    ///      to `10 ** 9` and this test fails.
    function test_tbtcVaultConstantAndConversionUseTheSameFactor() public {
        (uint256[] memory satoshis, uint256[] memory baseUnits) = _readPairs();

        assertEq(
            tbtcVault.SATOSHI_MULTIPLIER(),
            EXPECTED_MULTIPLIER,
            "the TBTC vault's multiplier must be 1e10"
        );
        assertEq(
            tbtcVault.SATOSHI_MULTIPLIER(),
            vault.SATOSHI_MULTIPLIER(),
            "the TBTC vault and the reservation vault must share the factor"
        );

        for (uint256 i = 0; i < satoshis.length; i++) {
            // `amountToSatoshis` is the vault's own inversion of the
            // factor, so it must return the pair's satoshi amount.
            (
                uint256 convertibleAmount,
                uint256 remainder,
                uint256 convertedSatoshis
            ) = tbtcVault.amountToSatoshis(baseUnits[i]);

            assertEq(
                convertedSatoshis,
                satoshis[i],
                "the vault must convert base units back to satoshis"
            );
            assertEq(
                convertibleAmount,
                baseUnits[i],
                "an exact vector amount must convert without a remainder"
            );
            assertEq(
                remainder,
                0,
                "an exact vector amount leaves no remainder"
            );
        }
    }

    // ---------------------------------------------------------------------
    // The rounding behaviour
    // ---------------------------------------------------------------------

    /// @notice The conversion truncates: a base-unit amount that is not a
    ///         multiple of 10^10 converts to fewer satoshis and leaves the
    ///         remainder behind.
    /// @dev This is the same truncation the SDK's `amountToSatoshi`
    ///      performs (`value.mod(multiplier)` is dropped before the
    ///      division), so the vector's rounding cases pin the behaviour
    ///      both sides rely on.
    ///
    ///      NEGATIVE CONTROL: change `ReservationVault.SATOSHI_MULTIPLIER`
    ///      to `10 ** 9` and this test fails.
    function test_conversionTruncatesTheRemainderLikeTheSdk() public {
        (
            uint256[] memory baseUnits,
            uint256[] memory satoshis,
            uint256[] memory remainders
        ) = _readRoundingCases();

        assertGt(
            baseUnits.length,
            0,
            "the shared vector must list at least one rounding case"
        );

        for (uint256 i = 0; i < baseUnits.length; i++) {
            (
                uint256 convertibleAmount,
                uint256 remainder,
                uint256 convertedSatoshis
            ) = tbtcVault.amountToSatoshis(baseUnits[i]);

            assertEq(
                convertedSatoshis,
                satoshis[i],
                "the conversion must floor to the vector's satoshis"
            );
            assertEq(
                remainder,
                remainders[i],
                "the conversion must leave the vector's remainder"
            );
            assertEq(
                convertibleAmount,
                baseUnits[i] - remainders[i],
                "the convertible amount must exclude the remainder"
            );
        }
    }

    // ---------------------------------------------------------------------
    // The vector reader's failure mode
    // ---------------------------------------------------------------------

    /// @notice A malformed element is not the end of the array: the reader
    ///         counts it and the missing required field then fails the
    ///         parse.
    /// @dev The reader used to probe for the `satoshis` FIELD of each
    ///      element and treat a failed field parse as the end of the
    ///      array. An element missing that field was therefore counted as
    ///      absent, so the vector was silently truncated and every
    ///      remaining element went unchecked.
    ///
    ///      NEGATIVE CONTROL: revert this reader to the field-level probe
    ///      (`vm.parseJsonUint` on `arrayKey[i].satoshis`) and this test
    ///      fails: the length would be 1 instead of 2.
    function test_arrayLengthDoesNotTreatAMalformedElementAsTheEnd() public {
        // The second element is missing its required `satoshis` field.
        // The document is still valid JSON.
        string memory json = string.concat(
            '{"pairs":[',
            '{"satoshis":1,"tbtcBaseUnits":"10000000000"},',
            '{"tbtcBaseUnits":"15000000000000"}',
            "]}"
        );

        assertEq(
            _arrayLength(json, ".pairs"),
            2,
            "a malformed element must still be counted"
        );

        // The malformed element is not silently skipped either: reading its
        // missing required field fails.
        bool parsed = true;
        try vm.parseJsonUint(json, _elementKey(".pairs", 1, "satoshis")) {
            parsed = true;
        } catch {
            parsed = false;
        }
        assertFalse(
            parsed,
            "a malformed element must fail the field parse, not be skipped"
        );
    }

    /// @notice The shared vector's arrays are complete: every element
    ///         carries every required field, and the reader sees them all.
    /// @dev NEGATIVE CONTROL: delete the `satoshis` field from the LAST
    ///      element of `roundingCases` in the vector file and this test
    ///      fails, because the reader counts the malformed element and the
    ///      field parse then fails. Under the old field-level probe the
    ///      same deletion truncated the array silently and this test
    ///      passed.
    function test_vectorArraysAreCompleteAndFullyRead() public {
        (uint256[] memory satoshis, uint256[] memory baseUnits) = _readPairs();
        assertEq(satoshis.length, 5, "the vector must list five pairs");
        assertEq(baseUnits.length, 5, "the vector must list five pairs");

        (
            uint256[] memory roundingBaseUnits,
            uint256[] memory roundingSatoshis,
            uint256[] memory remainders
        ) = _readRoundingCases();
        assertEq(
            roundingBaseUnits.length,
            4,
            "the vector must list four rounding cases"
        );
        assertEq(
            roundingSatoshis.length,
            4,
            "the vector must list four rounding cases"
        );
        assertEq(
            remainders.length,
            4,
            "the vector must list four rounding cases"
        );
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /// @dev Reads the shared vector file. The path is relative to the
    ///      Foundry project root, which is `solidity/`.
    function _readVector() internal view returns (string memory) {
        return vm.readFile(VECTOR_FILE);
    }

    /// @dev The shared vector's pairs, as parallel arrays.
    function _readPairs()
        internal
        view
        returns (uint256[] memory satoshis, uint256[] memory baseUnits)
    {
        string memory json = _readVector();
        uint256 length = _arrayLength(json, ".pairs");

        satoshis = new uint256[](length);
        baseUnits = new uint256[](length);

        for (uint256 i = 0; i < length; i++) {
            satoshis[i] = vm.parseJsonUint(
                json,
                _elementKey(".pairs", i, "satoshis")
            );
            baseUnits[i] = vm.parseUint(
                vm.parseJsonString(
                    json,
                    _elementKey(".pairs", i, "tbtcBaseUnits")
                )
            );
        }
    }

    /// @dev The shared vector's rounding cases, as parallel arrays.
    function _readRoundingCases()
        internal
        view
        returns (
            uint256[] memory baseUnits,
            uint256[] memory satoshis,
            uint256[] memory remainders
        )
    {
        string memory json = _readVector();
        uint256 length = _arrayLength(json, ".roundingCases");

        baseUnits = new uint256[](length);
        satoshis = new uint256[](length);
        remainders = new uint256[](length);

        for (uint256 i = 0; i < length; i++) {
            baseUnits[i] = vm.parseUint(
                vm.parseJsonString(
                    json,
                    _elementKey(".roundingCases", i, "tbtcBaseUnits")
                )
            );
            satoshis[i] = vm.parseJsonUint(
                json,
                _elementKey(".roundingCases", i, "satoshis")
            );
            remainders[i] = vm.parseJsonUint(
                json,
                _elementKey(".roundingCases", i, "remainder")
            );
        }
    }

    /// @dev The length of a JSON array. `vm.parseJsonArrayLength` is not
    ///      available in the pinned forge-std revision, so the length is
    ///      read by probing for the EXISTENCE of each element. The
    ///      existence probe is `vm.keyExistsJson` on the element itself,
    ///      not on one of its fields: a field-level probe would treat a
    ///      malformed element (one missing a required field) as the end
    ///      of the array and silently truncate it, so the remaining
    ///      elements would go unchecked. With an element-level probe, a
    ///      malformed element is still counted, and the missing or
    ///      invalid required field then fails the field parse that the
    ///      caller performs on it.
    function _arrayLength(
        string memory json,
        string memory arrayKey
    ) internal view returns (uint256 length) {
        // The vector's arrays are short; a hard cap keeps a malformed
        // file from turning this into an unbounded loop.
        uint256 maxEntries = 64;

        for (uint256 i = 0; i < maxEntries; i++) {
            if (!vm.keyExistsJson(json, _elementPath(arrayKey, i))) {
                return length;
            }
            length = i + 1;
        }

        revert("the shared vector array is longer than the read cap");
    }

    /// @dev The JSON path of an element inside an array, with no field
    ///      selected: `arrayKey[index]`. This is the path the existence
    ///      probe uses, so it selects the element as a whole.
    function _elementPath(
        string memory arrayKey,
        uint256 index
    ) internal pure returns (string memory) {
        return string.concat(arrayKey, "[", vm.toString(uint256(index)), "]");
    }

    /// @dev The JSON path of an element's field inside an array.
    function _elementKey(
        string memory arrayKey,
        uint256 index,
        string memory field
    ) internal pure returns (string memory) {
        return string.concat(_elementPath(arrayKey, index), ".", field);
    }
}
