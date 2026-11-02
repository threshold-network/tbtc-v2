// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import {Test} from "forge-std/Test.sol";

import {Reservation} from "../contracts/bridge/Reservation.sol";
import {ReservationRouter} from "../contracts/bridge/ReservationRouter.sol";

import {ReservationStackHarness} from "./reservations/ReservationStackHarness.sol";

/// @notice Spec row INV-210: the `uint32` timestamp horizon of the four
///         reservation timestamps -- `timeoutAt`, `expiresAt`,
///         `dissolutionEligibleAt` and `reanchorCooldownUntil`.
///
/// @dev The four timestamps are stored in `uint32` fields:
///
///      - `Reservation.ReservationRequest.expiresAt`,
///        `.dissolutionEligibleAt` and `.reanchorCooldownUntil`,
///      - `Reservation.ReservationAction.timeoutAt`.
///
///      The contracts write them with an EXPLICIT narrowing cast of
///      `block.timestamp` (`uint32(block.timestamp)` in
///      `Reservation.requestReservationAcceptance`,
///      `Reservation.requestReservationReanchor`,
///      `Reservation.notifyReservationActionTimeout`,
///      `ReservationProofs.settleAcceptance` and
///      `ReservationProofs.consumeAcceptedDeposit`). The cast TRUNCATES
///      (it is a modular narrowing), it does not saturate: one second
///      past `type(uint32).max` the cast yields zero.
///
///      Checked arithmetic does not protect an explicit narrowing cast.
///      The additions that follow the cast ARE checked, so the term and
///      cooldown arithmetic reverts (rather than wrapping) once the sum
///      would exceed the uint32 ceiling. The two protections are
///      independent and this suite pins both:
///
///      - the narrowing cast itself truncates (`uint32(block.timestamp)`),
///      - the checked additions that consume it revert at the ceiling.
///
///      The contract's own doc comments state the ceiling explicitly:
///      `Reservation.ReservationRequest.acceptedAt` carries the comment
///      "XXX: Unsigned 32-bit int unix seconds, will break February 7th
///      2106.", and `.expiresAt` / `.dissolutionEligibleAt` /
///      `Reservation.ReservationAction.timeoutAt` carry the companion
///      notes that the checked addition reverts "once the sum would
///      exceed the uint32 ceiling - starting up to MAX_RESERVATION_TERM
///      (730 days) before the raw February 7th 2106 date, not at it.".
///
///      The same horizon is documented in the fuzz harness: see
///      `test/fizz/Base.sol`, whose `FIZZ_CLOCK_CEILING = 4_000_000_000`
///      constant is introduced with the comment "uint32 timestamps in
///      Bridge, Wallets, Fraud, Redemption and RebateStaking wrap in
///      2106. Every handler that jumps the clock by a
///      governance-controlled amount checks `clockHasRoom` first." (see
///      `test/fizz/utils/Math.sol`, `clockHasRoom`). The fuzz handlers
///      therefore never drive the clock past the horizon, which is why
///      this suite drives it there on purpose.
///
///      IMPORTANT SCOPE NOTE: the 2106 ceiling is a STATED DEPLOYMENT
///      ASSUMPTION of the current contract, not an unlimited-time safety
///      guarantee. This suite pins the documented behaviour (truncation)
///      as the current semantics. It does not propose, and must not be
///      read as proposing, a fix for the horizon.
contract ReservationTimestampHorizonTest is Test {
    /// @dev The uint32 ceiling, i.e. 2106-02-07T06:28:15Z.
    uint256 internal constant UINT32_MAX = 4294967295;

    /// @dev The governance parameters the harness is configured with. They
    ///      are the values the production deployment uses, so the
    ///      reachable boundaries below are the real ones.
    uint256 internal constant TERM = 90 days;
    uint256 internal constant DISSOLUTION_DELAY = 7 days;
    uint256 internal constant ACTION_TIMEOUT = 6 hours;
    uint256 internal constant REFUND_SAFETY_MARGIN = 24 hours;

    uint64 internal constant DEPOSIT_AMOUNT = 500_000;
    uint64 internal constant ANCHOR_AMOUNT = 495_000;

    /// @dev An ordinary, well below the horizon, timestamp.
    uint256 internal constant NORMAL_TIMESTAMP = 1_700_000_000;

    ReservationStackHarness internal stack;
    bytes20 internal walletA;
    bytes20 internal walletB;

    function setUp() public {
        stack = new ReservationStackHarness();
        // The harness's `deployer` is this test contract, so the
        // deploy-time parameter setup is reachable.
        stack.setupReservationCaps(3_000_000, 2_000_000, 4, 1, 1);
        stack.setupReservationParameters(
            address(stack.reservationVault()),
            100_000, // min amount
            10_000, // tx max fee
            uint32(TERM),
            uint32(DISSOLUTION_DELAY),
            6_000_000, // max total amount
            2, // max reservations per wallet
            uint32(ACTION_TIMEOUT),
            7 days // renewal window
        );

        walletA = bytes20(uint160(0xA11CE));
        walletB = bytes20(uint160(0xB0B));
        stack.registerLiveWallet(walletA);
        stack.registerLiveWallet(walletB);

        vm.warp(NORMAL_TIMESTAMP);
    }

    // ---------------------------------------------------------------------
    // The horizon itself
    // ---------------------------------------------------------------------

    /// @dev The documented horizon: the uint32 ceiling is the February 7th
    ///      2106 timestamp the contract's doc comments name.
    function test_theDocumentedHorizonIsTheUint32Ceiling() public {
        (
            uint256 year,
            uint256 month,
            uint256 day,
            uint256 hour,
            uint256 minute,
            uint256 second
        ) = _civilDate(UINT32_MAX);

        assertEq(year, 2106, "the uint32 ceiling is not in 2106");
        assertEq(month, 2, "the uint32 ceiling is not in February");
        assertEq(day, 7, "the uint32 ceiling is not on the 7th");
        assertEq(hour, 6, "the uint32 ceiling is not at 06:00");
        assertEq(minute, 28, "the uint32 ceiling is not at 06:28");
        assertEq(second, 15, "the uint32 ceiling is not at 06:28:15");

        // At the ceiling the narrowing cast is still the identity.
        vm.warp(UINT32_MAX);
        assertEq(
            uint256(this.observedUint32Now()),
            UINT32_MAX,
            "the cast must be the identity at the ceiling"
        );
    }

    /// @dev The narrowing cast TRUNCATES. It is not a saturating cast: one
    ///      second past the ceiling the observed value is zero, not the
    ///      ceiling. The expectation is derived from the observed
    ///      on-chain value, not hard-coded.
    ///
    ///      The first half reads the cast through the test contract, the
    ///      second half through a CONTRACT's own explicit cast:
    ///      `ReservationProofs.consumeAcceptedDeposit` records
    ///      `deposit.sweptAt = uint32(block.timestamp)` when an acceptance
    ///      settles, so the swept deposit's own record shows what the
    ///      contract's narrowing cast produced.
    function test_theExplicitUint32CastTruncatesRatherThanSaturating() public {
        // The same cast, as the CONTRACT performs it: the acceptance is
        // requested below the horizon (a request past it is refused by the
        // refund-window rule) and settled above it.
        uint256 key = _reveal(500_000, bytes8(uint64(0x11)));
        stack.requestReservationAcceptance(key, walletA);

        vm.warp(UINT32_MAX + 1);
        stack.proveAcceptance(
            key,
            1,
            keccak256(abi.encodePacked("anchor", key)),
            ANCHOR_AMOUNT
        );

        assertEq(
            uint256(stack.deposits(key).sweptAt),
            0,
            "the contract's own narrowing cast must truncate past the ceiling"
        );
        assertEq(
            uint256(stack.reservationRecord(key).acceptedAt),
            0,
            "the contract's own narrowing cast must truncate past the ceiling"
        );

        vm.warp(UINT32_MAX);
        uint32 atCeiling = this.observedUint32Now();
        assertEq(
            uint256(atCeiling),
            UINT32_MAX,
            "the cast must be the identity at the ceiling"
        );

        vm.warp(UINT32_MAX + 1);
        uint32 pastCeiling = this.observedUint32Now();
        assertEq(
            uint256(pastCeiling),
            uint256(block.timestamp % 2 ** 32),
            "the cast must be a modular truncation of the timestamp"
        );
        assertEq(
            uint256(pastCeiling),
            0,
            "one second past the ceiling wraps to zero"
        );
        assertLt(
            uint256(pastCeiling),
            uint256(atCeiling),
            "the cast must truncate, not saturate at the ceiling"
        );
    }

    // ---------------------------------------------------------------------
    // expiresAt and dissolutionEligibleAt
    // ---------------------------------------------------------------------

    /// @dev An acceptance settled past the horizon records TRUNCATED
    ///      timestamps: `acceptedAt`, `expiresAt` and
    ///      `dissolutionEligibleAt` are all computed from
    ///      `uint32(block.timestamp)`, which is zero one second past the
    ///      ceiling.
    ///
    ///      The request itself CANNOT be made past the horizon: the
    ///      acceptance request computes `timeoutAt` from the same cast,
    ///      and the refund-window rule
    ///      (`timeoutAt + DEPOSIT_REFUND_SAFETY_MARGIN <= refundDeadline`,
    ///      with a `uint32` refund deadline) plus the signing-window rule
    ///      both reject the request there. The generation is therefore
    ///      requested below the horizon and settled above it, which is
    ///      the only reachable shape of this case. The settlement is the
    ///      on-time path: the generation was never reported timed out, and
    ///      the on-time settlement path carries no timestamp bound.
    function test_acceptanceSettledPastTheHorizonRecordsTruncatedTimestamps()
        public
    {
        uint256 key = _reveal(500_000, bytes8(uint64(0x01)));
        stack.requestReservationAcceptance(key, walletA);

        vm.warp(UINT32_MAX + 1);
        uint256 observed = uint256(this.observedUint32Now());
        assertEq(observed, 0, "the cast truncates to zero past the ceiling");

        stack.proveAcceptance(
            key,
            1,
            keccak256(abi.encodePacked("anchor", key)),
            ANCHOR_AMOUNT
        );

        Reservation.ReservationRequest memory record = stack.reservationRecord(
            key
        );
        assertEq(
            uint256(record.acceptedAt),
            observed,
            "acceptedAt must hold the truncated cast"
        );
        assertEq(
            uint256(record.expiresAt),
            observed + TERM,
            "expiresAt must be computed from the truncated cast"
        );
        assertEq(
            uint256(record.dissolutionEligibleAt),
            observed + TERM + DISSOLUTION_DELAY,
            "dissolutionEligibleAt must be computed from the truncated cast"
        );
        // The consequence of the truncation: the custody term starts at
        // the epoch, so the position is already expired and already
        // dissolvable when it is created.
        assertLt(
            uint256(record.expiresAt),
            block.timestamp,
            "the truncated term expires in the past"
        );
        assertLt(
            uint256(record.dissolutionEligibleAt),
            block.timestamp,
            "the truncated dissolution eligibility is in the past"
        );
    }

    /// @dev The reachable boundary of the term arithmetic: an acceptance
    ///      settled at the last timestamp whose term and dissolution delay
    ///      still fit in a `uint32` records a `dissolutionEligibleAt` of
    ///      exactly `type(uint32).max`.
    function test_expiresAtAndDissolutionEligibleAtReachTheCeiling() public {
        // The acceptance request is made at a timestamp that still leaves
        // the whole authorization window below the horizon, so the
        // settlement below is genuinely on time (the generation has not
        // timed out).
        vm.warp(UINT32_MAX - TERM - DISSOLUTION_DELAY - 1);

        uint256 key = _reveal(500_000, bytes8(uint64(0x02)));
        stack.requestReservationAcceptance(key, walletA);

        // The last timestamp whose `expiresAt + dissolutionDelay` still
        // fits in a uint32.
        vm.warp(UINT32_MAX - TERM - DISSOLUTION_DELAY);
        stack.proveAcceptance(
            key,
            1,
            keccak256(abi.encodePacked("anchor", key)),
            ANCHOR_AMOUNT
        );

        Reservation.ReservationRequest memory record = stack.reservationRecord(
            key
        );
        assertEq(
            uint256(record.expiresAt),
            UINT32_MAX - DISSOLUTION_DELAY,
            "expiresAt must sit one dissolution delay below the ceiling"
        );
        assertEq(
            uint256(record.dissolutionEligibleAt),
            UINT32_MAX,
            "dissolutionEligibleAt must reach the uint32 ceiling exactly"
        );
        assertEq(
            uint256(record.acceptedAt),
            UINT32_MAX - TERM - DISSOLUTION_DELAY,
            "acceptedAt must hold the settlement timestamp itself"
        );
    }

    /// @dev One second later the checked addition reverts instead of
    ///      wrapping: the settlement is refused and no position is created.
    ///      This is the protection the narrowing cast does NOT have.
    function test_dissolutionEligibleAtOverflowRevertsOneSecondPastTheCeiling()
        public
    {
        vm.warp(UINT32_MAX - TERM - DISSOLUTION_DELAY - 1);

        uint256 key = _reveal(500_000, bytes8(uint64(0x03)));
        stack.requestReservationAcceptance(key, walletA);

        vm.warp(UINT32_MAX - TERM - DISSOLUTION_DELAY + 1);
        vm.expectRevert(abi.encodeWithSignature("Panic(uint256)", 0x11));
        stack.proveAcceptance(
            key,
            1,
            keccak256(abi.encodePacked("anchor", key)),
            ANCHOR_AMOUNT
        );

        assertEq(
            uint8(stack.reservationRecord(key).state),
            uint8(Reservation.ReservationState.Unknown),
            "the refused settlement must not have created a position"
        );
    }

    /// @dev The same protection one level up: at the ceiling itself the
    ///      term addition alone overflows, so the acceptance cannot even
    ///      be settled at `type(uint32).max`.
    function test_acceptanceCannotBeSettledAtTheCeilingItself() public {
        vm.warp(UINT32_MAX - TERM - DISSOLUTION_DELAY - 1);

        uint256 key = _reveal(500_000, bytes8(uint64(0x04)));
        stack.requestReservationAcceptance(key, walletA);

        vm.warp(UINT32_MAX);
        vm.expectRevert(abi.encodeWithSignature("Panic(uint256)", 0x11));
        stack.proveAcceptance(
            key,
            1,
            keccak256(abi.encodePacked("anchor", key)),
            ANCHOR_AMOUNT
        );
    }

    // ---------------------------------------------------------------------
    // timeoutAt
    // ---------------------------------------------------------------------

    /// @dev The acceptance request's `timeoutAt` is bounded one step below
    ///      the ceiling by the refund-window rule, so the largest reachable
    ///      acceptance `timeoutAt` is `uint32.max - 24h`, not the ceiling
    ///      itself.
    function test_acceptanceTimeoutAtTheLargestReachableValue() public {
        uint256 requestAt = UINT32_MAX - REFUND_SAFETY_MARGIN - ACTION_TIMEOUT;
        vm.warp(requestAt);

        uint256 key = _reveal(500_000, bytes8(uint64(0x05)));
        stack.requestReservationAcceptance(key, walletA);

        Reservation.ReservationAction memory action = stack
            .reservationActionRecord(key, 1);
        assertEq(
            uint256(action.timeoutAt),
            UINT32_MAX - REFUND_SAFETY_MARGIN,
            "the largest reachable acceptance timeoutAt must sit one refund margin below the ceiling"
        );
        assertEq(
            uint256(action.requestedAt),
            requestAt,
            "requestedAt must hold the request timestamp itself"
        );
    }

    /// @dev One second past that reachable value the request is refused:
    ///      the authorization window would overlap the deposit refund
    ///      window, because the refund deadline is itself a `uint32`.
    function test_acceptanceRequestIsRefusedOneSecondPastTheReachableTimeout()
        public
    {
        uint256 requestAt = UINT32_MAX - REFUND_SAFETY_MARGIN - ACTION_TIMEOUT;

        vm.warp(requestAt + 1);
        uint256 key = _reveal(500_000, bytes8(uint64(0x06)));
        vm.expectRevert(
            "Authorization window would overlap the deposit refund window"
        );
        stack.requestReservationAcceptance(key, walletA);
    }

    /// @dev At the arithmetic ceiling itself the checked `uint32` addition
    ///      reverts with a panic instead of wrapping.
    function test_acceptanceRequestPanicsOneSecondPastTheArithmeticCeiling()
        public
    {
        vm.warp(UINT32_MAX - ACTION_TIMEOUT + 1);

        uint256 key = _reveal(500_000, bytes8(uint64(0x07)));
        vm.expectRevert(abi.encodeWithSignature("Panic(uint256)", 0x11));
        stack.requestReservationAcceptance(key, walletA);
    }

    /// @dev The re-anchor request carries no refund-window rule, so its
    ///      `timeoutAt` reaches the uint32 ceiling exactly.
    function test_reanchorTimeoutReachesTheCeiling() public {
        uint256 key = _acceptedPosition();

        vm.warp(UINT32_MAX - ACTION_TIMEOUT);
        stack.requestReservationReanchor(key, walletB, true);

        Reservation.ReservationAction memory action = stack
            .reservationActionRecord(key, 2);
        assertEq(
            uint256(action.timeoutAt),
            UINT32_MAX,
            "the re-anchor timeoutAt must reach the uint32 ceiling exactly"
        );
        assertEq(
            uint256(action.requestedAt),
            UINT32_MAX - ACTION_TIMEOUT,
            "requestedAt must hold the request timestamp itself"
        );
    }

    /// @dev One second past the ceiling the checked addition panics.
    function test_reanchorRequestPanicsOneSecondPastTheCeiling() public {
        uint256 key = _acceptedPosition();

        vm.warp(UINT32_MAX - ACTION_TIMEOUT + 1);
        vm.expectRevert(abi.encodeWithSignature("Panic(uint256)", 0x11));
        stack.requestReservationReanchor(key, walletB, true);
    }

    /// @dev Past the horizon the re-anchor request's `timeoutAt` would be
    ///      computed from the TRUNCATED cast (`0 + ACTION_TIMEOUT`), but
    ///      the request's signing-window rule then refuses the request.
    ///      The truncation therefore happens and is observable in the
    ///      computed value, but it is NOT observable in a stored record:
    ///      the request never reaches the write. This case pins that
    ///      honest limit rather than pretending the value is reachable.
    function test_reanchorTimeoutTruncatesPastTheHorizonButTheRequestIsRefused()
        public
    {
        uint256 key = _acceptedPosition();

        vm.warp(UINT32_MAX + 1);
        vm.expectRevert("Reanchor authorization has no signing window");
        stack.requestReservationReanchor(key, walletB, true);
    }

    // ---------------------------------------------------------------------
    // reanchorCooldownUntil
    // ---------------------------------------------------------------------

    /// @dev The re-anchor cooldown is written when a re-anchor generation
    ///      times out: `uint32(block.timestamp) + (timeoutAt - requestedAt)`.
    ///      At the last timestamp whose cooldown still fits in a `uint32`
    ///      the cooldown reaches the ceiling exactly.
    function test_reanchorCooldownReachesTheCeiling() public {
        uint256 key = _acceptedPosition();
        stack.requestReservationReanchor(key, walletB, true);

        Reservation.ReservationAction memory action = stack
            .reservationActionRecord(key, 2);
        uint256 cooldownSpan =
            uint256(action.timeoutAt) - uint256(action.requestedAt);
        assertEq(
            cooldownSpan,
            ACTION_TIMEOUT,
            "the cooldown span is the action timeout"
        );

        vm.warp(UINT32_MAX - cooldownSpan);
        stack.callRouterStrict(
            abi.encodeWithSelector(
                ReservationRouter.notifyReservationActionTimeout.selector,
                key
            )
        );

        Reservation.ReservationRequest memory record = stack.reservationRecord(
            key
        );
        assertEq(
            uint256(record.reanchorCooldownUntil),
            UINT32_MAX,
            "the re-anchor cooldown must reach the uint32 ceiling exactly"
        );
    }

    /// @dev Past the horizon the cooldown is computed from the TRUNCATED
    ///      cast, so it lands in the past: the cooldown that is supposed to
    ///      hold the position back for the timeout span instead expires
    ///      immediately.
    function test_reanchorCooldownTruncatesPastTheHorizon() public {
        uint256 key = _acceptedPosition();
        stack.requestReservationReanchor(key, walletB, true);

        Reservation.ReservationAction memory action = stack
            .reservationActionRecord(key, 2);
        uint256 cooldownSpan =
            uint256(action.timeoutAt) - uint256(action.requestedAt);

        vm.warp(UINT32_MAX + 1);
        uint256 observed = uint256(this.observedUint32Now());
        assertEq(observed, 0, "the cast truncates to zero past the ceiling");

        stack.callRouterStrict(
            abi.encodeWithSelector(
                ReservationRouter.notifyReservationActionTimeout.selector,
                key
            )
        );

        Reservation.ReservationRequest memory record = stack.reservationRecord(
            key
        );
        assertEq(
            uint256(record.reanchorCooldownUntil),
            observed + cooldownSpan,
            "the cooldown must be computed from the truncated cast"
        );
        assertLt(
            uint256(record.reanchorCooldownUntil),
            block.timestamp,
            "the truncated cooldown is already in the past"
        );
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /// @dev The observed value of the narrowing cast, read on chain at the
    ///      current block. The test asserts against this observed value,
    ///      never against a hard-coded expectation.
    function observedUint32Now() external view returns (uint32) {
        /* solhint-disable-next-line not-rely-on-time */
        return uint32(block.timestamp);
    }

    /// @dev Reveals a reserved deposit for this test contract. The refund
    ///      deadline is the uint32 ceiling, the largest value the deposit
    ///      record can carry, so the acceptance request is bounded by the
    ///      request's own refund-window rule rather than by the fixture.
    function _reveal(
        uint64 amount,
        bytes8 blindingFactor
    ) internal returns (uint256 depositKey) {
        return
            stack.revealReservedDeposit(
                address(this),
                walletA,
                blindingFactor,
                bytes20(uint160(0xBEEF)),
                uint32(UINT32_MAX),
                amount,
                uint32(UINT32_MAX)
            );
    }

    /// @dev An accepted position, opened at the ordinary timestamp. The
    ///      acceptance is settled through the production
    ///      `ReservationProofs.settleAcceptance` path, with the SPV proof
    ///      check replaced by the harness (the harness's own documented
    ///      simplification).
    function _acceptedPosition() internal returns (uint256 depositKey) {
        depositKey = _reveal(DEPOSIT_AMOUNT, bytes8(uint64(0x10)));
        stack.requestReservationAcceptance(depositKey, walletA);
        stack.proveAcceptance(
            depositKey,
            1,
            keccak256(abi.encodePacked("anchor", depositKey)),
            ANCHOR_AMOUNT
        );
    }

    /// @dev The civil date of a UNIX timestamp, so the test can assert the
    ///      documented 2106 horizon against a computed date instead of a
    ///      restated constant.
    function _civilDate(
        uint256 timestamp
    )
        internal
        pure
        returns (
            uint256 year,
            uint256 month,
            uint256 day,
            uint256 hour,
            uint256 minute,
            uint256 second
        )
    {
        uint256 dayCount = timestamp / 86400;
        uint256 secondsOfDay = timestamp % 86400;
        hour = secondsOfDay / 3600;
        minute = (secondsOfDay % 3600) / 60;
        second = secondsOfDay % 60;

        // Days-from-civil, in reverse (civil-from-days).
        int256 z = int256(dayCount) + 719468;
        int256 era = (z >= 0 ? z : z - 146096) / 146097;
        uint256 dayOfEra = uint256(z - era * 146097);
        uint256 yearOfEra =
            (dayOfEra -
                dayOfEra / 1460 +
                dayOfEra / 36524 -
                dayOfEra / 146096) / 365;
        int256 yearBase = int256(yearOfEra) + era * 400;
        uint256 dayOfYear =
            dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100);
        uint256 monthPrime = (5 * dayOfYear + 2) / 153;
        day = dayOfYear - (153 * monthPrime + 2) / 5 + 1;
        int256 monthNumber =
            int256(monthPrime) + (monthPrime < 10 ? int256(3) : int256(-9));
        month = uint256(monthNumber);
        year = uint256(yearBase + (monthNumber <= 2 ? int256(1) : int256(0)));
    }
}
