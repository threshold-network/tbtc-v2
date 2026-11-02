// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// Regression tests for R-13 (fuzz lead SP-106, "wallet entered MovingFunds
// without a main UTXO or proven anchors") and R-14 (SP-107, closeable route).
//
// R-13: `Wallets.moveFunds` routed a zero-BTC wallet to MovingFunds whenever
// `walletReservationInfo[w].count > 0`. That count includes capacity reserved
// for pending acceptance and re-anchor targets, which no Bitcoin proof backs,
// so anyone could load a zero-BTC wallet with a fabricated deposit (route A),
// a third-party re-anchor (route B) or a governance re-anchor (route C) and
// push it into MovingFunds, where nobody can commit a move and the operators
// are slashed if no one reports BelowDust in time. The gate now uses
// `walletAnchoredInfo[w].count` (proven anchors only): each route ends in
// Closing, which is not slashable, and Closing still waits for the pending
// action before the wallet can close. Before the fix the route tests fail
// ("wallet state": MovingFunds instead of Closing).
//
// R-14: `notifyWalletCloseable` read only the main UTXO, so a young wallet
// holding large proven anchors passed "too few satoshis". It now adds the
// proven anchor amount (`test_R14_*`).
//
// Parameters (test/fizz/Base.sol): moving funds timeout 3 days, action
// timeout 1 day, closing period 2 days, wallet max age 14 days, closure
// minimum 50_000 sat.

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
    ///         wallet goes straight to Closing and no operator is slashed.
    function test_SP106_control_zeroBalanceWalletWithoutCountGoesStraightToClosing()
        public
    {
        // Counts are relative to the harness baseline: `setup()` already
        // leaves more than one Live wallet (the hand-off reserve spare).
        uint32 liveBefore = bridge.liveWalletsCount();
        _registerWalletFromKey(1); // w1 becomes active, w0 is superseded
        assertEq(uint256(reservationRouter.walletReservationsCount(w0)), 0);
        assertEq(uint256(bridge.liveWalletsCount()), uint256(liveBefore) + 1);

        vm.prank(bystander);
        bridge.notifyWalletCloseable(w0, _none());

        Wallets.Wallet memory w = bridge.wallets(w0);
        _assertStateOf(w, Wallets.WalletState.Closing);
        assertEq(uint256(w.closingStartedAt), block.timestamp);
        assertEq(
            uint256(w.movingFundsRequestedAt),
            0,
            "never entered MovingFunds"
        );
        assertEq(uint256(bridge.liveWalletsCount()), uint256(liveBefore));
        assertEq(walletRegistry.seizeCalls(), 0, "Closing is not slashable");
    }

    // ------------------------------------------------------------------
    // Route A: depositor acceptance request with a fabricated deposit
    // ------------------------------------------------------------------

    /// @notice A fabricated reserved deposit and its acceptance request load
    ///         the zero-BTC wallet with pending capacity only. Pushing the
    ///         wallet now sends it to Closing, as if it held nothing.
    function test_SP106_routeA_fakeDepositAcceptanceRequestLeadsToClosing()
        public
    {
        _registerWalletFromKey(1); // w0 superseded, w1 active
        (uint256 key, , ) = _sp106Reveal(attacker, w0, DEPOSIT_SAT);
        _sp106RequestAcceptance(attacker, key, w0);
        assertEq(uint256(reservationRouter.walletReservationsCount(w0)), 1);
        assertEq(
            reservationRouter.reservations(key).walletPubKeyHash,
            bytes20(0),
            "no anchor anywhere"
        );

        vm.prank(bystander);
        bridge.notifyWalletCloseable(w0, _none());

        Wallets.Wallet memory w = bridge.wallets(w0);
        _assertStateOf(w, Wallets.WalletState.Closing);
        assertEq(uint256(w.movingFundsRequestedAt), 0, "skipped MovingFunds");
        assertEq(walletRegistry.seizeCalls(), 0, "no slash");
    }

    /// @notice The pushed wallet cannot be slashed through the moving-funds
    ///         timeout, and it closes once the fake authorization is reported
    ///         as timed out.
    function test_SP106_routeA_noSlashAndClosingFinishesAfterAcceptanceTimeout()
        public
    {
        (uint256 key, ) = _sp106PushViaFakeDeposit();
        Wallets.Wallet memory w = bridge.wallets(w0);

        vm.warp(uint256(w.closingStartedAt) + MOVING_FUNDS_TIMEOUT + 1);
        uint32[] memory ids = new uint32[](0);
        vm.prank(attacker);
        vm.expectRevert();
        bridge.notifyMovingFundsTimeout(w0, ids);
        assertEq(walletRegistry.seizeCalls(), 0, "no slash");

        // The pending authorization still blocks the final step.
        vm.expectRevert(bytes(ERR_STILL_CUSTODIES));
        bridge.notifyWalletClosingPeriodElapsed(w0);

        vm.prank(bystander);
        reservationRouter.notifyReservationAcceptanceTimedOut(key);
        bridge.notifyWalletClosingPeriodElapsed(w0);
        _assertState(w0, Wallets.WalletState.Closed);
    }

    /// @notice Pre-positioning variant: the fake authorization is filed while
    ///         w0 is active; after rotation the push still ends in Closing.
    function test_SP106_routeA_prepositionOnActiveWalletThenRotation() public {
        (uint256 key, , ) = _sp106Reveal(attacker, w0, DEPOSIT_SAT);
        _sp106RequestAcceptance(attacker, key, w0);

        vm.expectRevert(bytes(ERR_ACTIVE));
        bridge.notifyWalletCloseable(w0, _none());

        _registerWalletFromKey(1);
        bridge.notifyWalletCloseable(w0, _none());
        _assertState(w0, Wallets.WalletState.Closing);
    }

    // ------------------------------------------------------------------
    // Route B: third-party reanchor from a MovingFunds source
    // ------------------------------------------------------------------

    /// @notice REACHABLE without any role, but it needs a legitimately proven
    ///         reservation anchored at a wallet that is already MovingFunds
    ///         (normal retirement of a wallet holding reservations). Anyone may
    ///         then pick any Live target, here a zero-BTC non-active wallet,
    ///         whose count rises to 1 at request time. One notifyWalletCloseable
    ///         later the target is Closing, not an empty MovingFunds wallet.
    function test_SP106_routeB_thirdPartyReanchorLoadsTargetThenTargetGoesToClosing()
        public
    {
        // Honest reservation, really anchored at w0 (active at the time).
        uint256 key = _sp106HonestAccept(actors[0], w0, DEPOSIT_SAT, 0);
        _registerWalletFromKey(1);
        _registerWalletFromKey(2); // w2 active; w0 and w1 superseded

        // Legitimate retirement of w0 by age: it holds a proven anchor, so
        // the gate sends it to MovingFunds to trigger re-anchoring.
        skipTime(WALLET_MAX_AGE);
        vm.prank(bystander);
        bridge.notifyWalletCloseable(w0, _none());
        _assertState(w0, Wallets.WalletState.MovingFunds);

        // Unprivileged re-anchor request loads the zero-BTC target w1.
        vm.prank(attacker);
        reservationRouter.requestReservationReanchor(
            key,
            w1,
            new uint32[](0),
            0
        );
        assertEq(uint256(reservationRouter.walletReservationsCount(w1)), 1);

        vm.prank(bystander);
        bridge.notifyWalletCloseable(w1, _none());
        Wallets.Wallet memory w = bridge.wallets(w1);
        _assertStateOf(w, Wallets.WalletState.Closing);
        assertEq(uint256(w.movingFundsRequestedAt), 0, "skipped MovingFunds");
        assertEq(walletRegistry.seizeCalls(), 0, "no slash");
    }

    // ------------------------------------------------------------------
    // Route C: Live-source reanchor (the route the fuzzer used)
    // ------------------------------------------------------------------

    /// @notice PRIVILEGED only. Reproduces the fuzzer sequence with named
    ///         roles: governance rotates an anchor away from a Live wallet to
    ///         a zero-BTC target, and the target is then pushed by anyone.
    function test_SP106_routeC_governanceReanchorTargetGoesToClosing() public {
        uint256 key = _sp106HonestAccept(actors[0], w0, DEPOSIT_SAT, 0);
        _registerWalletFromKey(1);
        _registerWalletFromKey(2);
        _assertState(w0, Wallets.WalletState.Live, "source wallet is Live");

        vm.prank(governance);
        reservationRouter.requestReservationReanchor(
            key,
            w1,
            new uint32[](0),
            0
        );
        assertEq(uint256(reservationRouter.walletReservationsCount(w1)), 1);

        vm.prank(bystander);
        bridge.notifyWalletCloseable(w1, _none());
        _assertState(w1, Wallets.WalletState.Closing);
    }

    // ------------------------------------------------------------------
    // R-14: the closeable check counts proven anchors
    // ------------------------------------------------------------------

    /// @notice A young non-active wallet with no main UTXO but a proven
    ///         50_000 sat anchor (the closure minimum) is not "too few
    ///         satoshis": the push is refused while the wallet is young.
    function test_R14_youngWalletWithProvenAnchorIsNotCloseable() public {
        _sp106HonestAccept(actors[0], w0, DEPOSIT_SAT, 0);
        _registerWalletFromKey(1);
        assertEq(bridge.wallets(w0).mainUtxoHash, bytes32(0));

        vm.prank(bystander);
        vm.expectRevert(
            bytes("Wallet needs to be old enough or have too few satoshis")
        );
        bridge.notifyWalletCloseable(w0, _none());
        _assertState(w0, Wallets.WalletState.Live);
    }

    /// @notice Once the wallet is old enough the push is allowed and, with
    ///         a proven anchor, it enters MovingFunds (re-anchoring trigger).
    function test_R14_oldWalletWithProvenAnchorMovesFunds() public {
        _sp106HonestAccept(actors[0], w0, DEPOSIT_SAT, 0);
        _registerWalletFromKey(1);
        skipTime(WALLET_MAX_AGE);

        vm.prank(bystander);
        bridge.notifyWalletCloseable(w0, _none());
        _assertState(w0, Wallets.WalletState.MovingFunds);
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
        reservationRouter.requestReservationReanchor(
            key,
            w1,
            new uint32[](0),
            0
        );

        assertEq(uint256(reservationRouter.walletReservationsCount(w1)), 0);
        // With count 0 the push sends w1 to Closing.
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

        (
            BitcoinTx.Info memory fi,
            BitcoinTx.Proof memory fp,
            uint32 fo
        ) = _fundingArgs(key);
        vm.prank(attacker);
        vm.expectRevert(bytes(ERR_NOT_DEPOSITOR));
        reservationRouter.requestReservationAcceptance(fi, fp, fo, w0);
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
        _assertState(w0, Wallets.WalletState.Closing);
    }

    /// @dev Reveals a reserved deposit of `depositor` for `wallet`. The
    ///      funding transaction is fabricated: nothing is proven on Bitcoin.
    function _sp106Reveal(
        address depositor,
        bytes20 wallet,
        uint64 amount
    )
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
        _recordFunding(key, fundingTx, outputIndex);
    }

    function _sp106RequestAcceptance(
        address depositor,
        uint256 key,
        bytes20 wallet
    ) internal {
        _requestAcceptanceAs(depositor, key, wallet);
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
        return
            BtcBuilder.pubKeyHash(walletPubX[keyIndex], walletPubY[keyIndex]);
    }

    function _sp106Le32(uint32 v) internal pure returns (bytes4) {
        return
            bytes4(
                (v << 24) |
                    ((v & 0xff00) << 8) |
                    ((v >> 8) & 0xff00) |
                    (v >> 24)
            );
    }

    function _assertState(
        bytes20 wallet,
        Wallets.WalletState expected
    ) internal {
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

    function _assertStateOf(
        Wallets.Wallet memory w,
        Wallets.WalletState expected
    ) internal {
        assertEq(
            uint256(uint8(w.state)),
            uint256(uint8(expected)),
            "wallet state"
        );
    }

    function _none() internal pure returns (BitcoinTx.UTXO memory) {
        return BitcoinTx.UTXO(bytes32(0), 0, 0);
    }
}
