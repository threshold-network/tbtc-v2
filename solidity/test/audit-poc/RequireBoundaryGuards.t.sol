// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// Regression tests for `require` comparison boundaries that survived the
// RQB mutation pass of 2026-10-11 (one operator swap per comparison:
// `<`/`<=`, `>`/`>=`, `==`/`!=`). slither 0.11.6 ROR could not mutate
// `require` conditions (it nests the statement inside itself), so these
// comparisons were never mutation-tested before. Each test pins the exact
// boundary the surviving mutant moves. Rows in the audit record
// (solidity/docs/audit/pr-1116-reservations.md, section 7).
//
// Source lines involved (solidity/contracts/bridge/Reservation.sol unless
// noted):
//   ReservationProofs.sol:464  acceptance anchor: `anchorAmount >= minAmount`
//   739        re-anchor cooldown: `block.timestamp >= reanchorCooldownUntil`
//   807        re-anchor floor: `anchorAmount > txMaxFee + minAmount`
//   827        per-wallet amount cap: `targetAmount <= cap`
//   1274-1299  updateReservationParameters: txMaxFee > 0, minAmount >
//              txMaxFee, actionTimeout > 2 h, maxReservationsPerWallet > 0
//   1304       vault switch needs `maxActiveReservations > 0`
//
// The deployment is test/fizz/Base.sol: min amount 10_000 sat, tx max fee
// 1_000 sat, action timeout 1 day.

import {Test} from "forge-std/Test.sol";
import {Handlers} from "../fizz/handlers/Handlers.sol";
import {BtcBuilder} from "../fizz/utils/BtcBuilder.sol";
import {BitcoinTx} from "../../contracts/bridge/BitcoinTx.sol";
import {Deposit} from "../../contracts/bridge/Deposit.sol";
import {Reservation} from "../../contracts/bridge/Reservation.sol";
import {Wallets} from "../../contracts/bridge/Wallets.sol";

contract RequireBoundaryGuardsTest is Test, Handlers {
    modifier asActor() override {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    // BridgeState.Storage sits at Bridge slot 51; `maxActiveReservations`
    // is the uint32 at byte offset 28 of struct slot 33
    // (test/fixtures/BridgeState.storageLayout.snapshot.json).
    uint256 internal constant SLOT_CAPS = 51 + 33;
    uint256 internal constant MAX_ACTIVE_SHIFT = 28 * 8;

    address internal honest;

    function setUp() public {
        setup();
        honest = makeAddr("rqb.honest");
    }

    // ------------------------------------------------------------------
    // Re-anchor request boundaries
    // ------------------------------------------------------------------

    /// @notice Line 739: a permissionless re-anchor is allowed exactly at
    ///         `reanchorCooldownUntil` and refused one second earlier. The
    ///         source wallet reaches MovingFunds through a heartbeat failure:
    ///         it holds a proven anchor, so `moveFunds` routes it there.
    function test_reanchor_allowedExactlyAtCooldownEnd() public {
        (uint256 key, bytes20 src, bytes20 dst) = _openReservation(37_999);
        for (uint256 s; s < 4; s++) {
            (bool found, bytes20 w) = _bridge_pickWallet(s, bridge_LIVE);
            if (found && w == src) {
                _bridge_heartbeatFailedClamped(s);
                break;
            }
        }
        require(
            bridge.wallets(src).state == Wallets.WalletState.MovingFunds,
            "source wallet not in MovingFunds"
        );

        vm.prank(honest);
        reservationRouter.requestReservationReanchor(
            key,
            dst,
            new uint32[](0),
            0
        );
        uint64 nonce = reservationRouter.reservations(key).requestNonce;
        vm.warp(reservationRouter.reservationActions(key, nonce).timeoutAt);
        reservationRouter.notifyReservationActionTimeout(key);
        uint32 cooldownUntil = reservationRouter
            .reservations(key)
            .reanchorCooldownUntil;

        vm.warp(uint256(cooldownUntil) - 1);
        vm.prank(honest);
        vm.expectRevert(bytes("Reanchor cooldown in effect"));
        reservationRouter.requestReservationReanchor(
            key,
            dst,
            new uint32[](0),
            0
        );

        vm.warp(cooldownUntil);
        vm.prank(honest);
        reservationRouter.requestReservationReanchor(
            key,
            dst,
            new uint32[](0),
            0
        );
        assertEq(
            uint256(uint8(reservationRouter.reservations(key).state)),
            uint256(uint8(Reservation.ReservationState.ActionPending)),
            "re-anchor requested at the cooldown end"
        );
    }

    /// @notice Line 807: an anchor of exactly `minAmount + txMaxFee` cannot
    ///         be re-anchored (the floor is strict). With the R-09 floor no
    ///         acceptance lands there, but a re-anchor may spend up to
    ///         `txMaxFee`, so it is reached legitimately: accept
    ///         `min + 2 * txMaxFee + 1` with the full fee (anchor
    ///         `min + txMaxFee + 1`), re-anchor with a fee of 1, and the next
    ///         re-anchor is refused.
    function test_reanchor_refusedAtExactFloor() public {
        bytes20 dst = _registerWalletFromKey(1);
        bytes20 src = harnessWallets[0];
        uint64 floorAmount = RESERVATION_MIN_AMOUNT + RESERVATION_TX_MAX_FEE;
        uint256 key = _acceptDirect(
            src,
            floorAmount + RESERVATION_TX_MAX_FEE + 1,
            floorAmount + 1
        );

        vm.prank(governance);
        reservationRouter.requestReservationReanchor(
            key,
            dst,
            new uint32[](0),
            0
        );
        uint64 nonce = reservationRouter.reservations(key).requestNonce;
        BtcBuilder.TxIn[] memory ins = new BtcBuilder.TxIn[](1);
        ins[0] = BtcBuilder.TxIn({
            prevTxHash: reservationRouter.reservations(key).anchorTxHash,
            prevOutIndex: 0
        });
        BtcBuilder.TxOut[] memory outs = new BtcBuilder.TxOut[](1);
        outs[0] = BtcBuilder.TxOut({
            value: floorAmount,
            script: BtcBuilder.p2wpkh(dst)
        });
        BitcoinTx.Info memory t = BtcBuilder.buildTx(ins, outs);
        BitcoinTx.Proof memory proof = BtcBuilder.prove(t, 1);
        vm.prank(spvMaintainer);
        reservationRouter.submitReservationReanchorProof(t, proof, key, nonce);
        assertEq(
            uint256(reservationRouter.reservations(key).anchorAmount),
            uint256(floorAmount),
            "anchor at the floor"
        );

        vm.prank(governance);
        vm.expectRevert(
            bytes("Reanchor would fall below the minimum reservation amount")
        );
        reservationRouter.requestReservationReanchor(
            key,
            src,
            new uint32[](0),
            0
        );
    }

    /// @notice Line 827: a re-anchor whose target lands exactly on the
    ///         per-wallet amount cap is allowed.
    function test_reanchor_allowedExactlyAtPerWalletAmountCap() public {
        (uint256 key, , bytes20 dst) = _openReservation(37_999);
        uint64 anchor = reservationRouter.reservations(key).anchorAmount;
        (, uint64 single, uint32 maxActive, ) = reservationRouter
            .reservationCaps();
        vm.prank(governance);
        reservationRouter.updateReservationCaps(
            anchor,
            single,
            maxActive,
            MAX_THIRD_PARTY_REANCHOR_HOLDS_PER_WALLET,
            HANDOFF_RESERVE_WALLETS
        );

        vm.prank(governance);
        reservationRouter.requestReservationReanchor(
            key,
            dst,
            new uint32[](0),
            0
        );
        assertEq(
            uint256(reservationRouter.walletReservationsAmount(dst)),
            uint256(anchor),
            "target exactly at the cap"
        );
    }

    // ------------------------------------------------------------------
    // Acceptance proof boundary
    // ------------------------------------------------------------------

    /// @notice ReservationProofs.sol:464 (`anchorAmount >= minAmount`): with
    ///         the R-09 acceptance floor (`amount > min + 2 * txMaxFee`) the
    ///         smallest admissible deposit proven with the full fee gives an
    ///         anchor of `minAmount + txMaxFee + 1`, which is accepted. The
    ///         exact-minimum anchor this guard used to pin is no longer
    ///         reachable through the router, so the line is now a second
    ///         line of defense.
    function test_acceptanceProof_smallestAdmittedAnchorAccepted() public {
        uint256 key = _acceptDirect(
            harnessWallets[0],
            RESERVATION_MIN_AMOUNT + 2 * RESERVATION_TX_MAX_FEE + 1,
            RESERVATION_MIN_AMOUNT + RESERVATION_TX_MAX_FEE + 1
        );
        assertEq(
            uint256(reservationRouter.reservations(key).anchorAmount),
            uint256(RESERVATION_MIN_AMOUNT + RESERVATION_TX_MAX_FEE + 1),
            "anchor one satoshi above the re-anchor floor"
        );
    }

    /// @dev Reveals a reserved deposit of `amount` for `wallet`, requests
    ///      acceptance as the depositor and proves an anchor of
    ///      `anchorValue` (miner fee `amount - anchorValue`).
    function _acceptDirect(
        bytes20 wallet,
        uint64 amount,
        uint64 anchorValue
    ) internal returns (uint256 key) {
        BitcoinTx.Info memory fundingTx;
        BitcoinTx.Proof memory fundingProof;
        bytes32 fundingTxHash;
        uint32 outIdx;
        (key, fundingTxHash, outIdx, fundingTx, fundingProof) = _reveal(
            actors[0],
            wallet,
            amount
        );
        vm.prank(actors[0]);
        reservationRouter.requestReservationAcceptance(
            fundingTx,
            fundingProof,
            outIdx,
            wallet
        );

        BtcBuilder.TxIn[] memory ins = new BtcBuilder.TxIn[](1);
        ins[0] = BtcBuilder.TxIn({
            prevTxHash: fundingTxHash,
            prevOutIndex: outIdx
        });
        BtcBuilder.TxOut[] memory outs = new BtcBuilder.TxOut[](1);
        outs[0] = BtcBuilder.TxOut({
            value: anchorValue,
            script: BtcBuilder.p2wpkh(wallet)
        });
        BitcoinTx.Info memory t = BtcBuilder.buildTx(ins, outs);
        // Build the proof before the prank: BtcBuilder calls the sha256
        // precompile, which would consume a pending vm.prank.
        BitcoinTx.Proof memory proof = BtcBuilder.prove(t, 1);
        vm.prank(spvMaintainer);
        reservationRouter.submitReservationAcceptanceProof(t, proof, key, 1);
    }

    // ------------------------------------------------------------------
    // updateReservationParameters boundaries
    // ------------------------------------------------------------------

    /// @notice Line 1274: a zero transaction max fee is refused.
    function test_setter_refusesZeroTxMaxFee() public {
        uint256[10] memory w = _words();
        w[2] = 0;
        _expectSetterRevert(
            w,
            "Reservation transaction max fee must be greater than zero"
        );
    }

    /// @notice Line 1278: a minimum amount equal to the fee is refused.
    function test_setter_refusesMinAmountEqualToTxMaxFee() public {
        uint256[10] memory w = _words();
        w[1] = w[2];
        _expectSetterRevert(
            w,
            "Reservation minimum amount must be greater than the reservation TX max fee"
        );
    }

    /// @notice Line 1292: an action timeout of exactly the lower bound is
    ///         refused. The R-50 bound is `SAFETY_MARGIN + DEPOSIT_MIN_AGE + 1`
    ///         (4 h + 1 s), so exactly 4 h + 1 s is refused; 4 h + 2 s is
    ///         accepted (AcceptanceSigningWindowBoundary.t.sol).
    function test_setter_refusesActionTimeoutAtLowerBound() public {
        uint256[10] memory w = _words();
        w[8] = 4 hours + 1;
        _expectSetterRevert(
            w,
            "Reservation action timeout leaves no signing window"
        );
    }

    /// @notice Line 1297: zero reservations per wallet is refused.
    function test_setter_refusesZeroReservationsPerWallet() public {
        uint256[10] memory w = _words();
        w[7] = 0;
        _expectSetterRevert(
            w,
            "Max reservations per wallet must be greater than zero"
        );
    }

    /// @notice Line 1304: switching to a new vault while the active
    ///         reservations cap is 0 (the state before the first
    ///         `updateReservationCaps`, which refuses 0 afterwards) is
    ///         refused. The cap is zeroed with `vm.store` because no call
    ///         path returns to that state.
    function test_setter_refusesVaultSwitchWithZeroActiveCap() public {
        uint256 raw = uint256(vm.load(address(bridge), bytes32(SLOT_CAPS)));
        raw &= ~(uint256(type(uint32).max) << MAX_ACTIVE_SHIFT);
        vm.store(address(bridge), bytes32(SLOT_CAPS), bytes32(raw));
        (, , uint32 maxActive, ) = reservationRouter.reservationCaps();
        assertEq(uint256(maxActive), 0, "cap zeroed");

        uint256[10] memory w = _words();
        w[0] = uint256(uint160(makeAddr("rqb.newVault")));
        _expectSetterRevert(
            w,
            "Max active reservations must be greater than zero"
        );
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev Wallet 1 becomes the active wallet; the reservation is accepted
    ///      on setup's wallet 0 with a zero miner fee. `amountSeed` 0 gives
    ///      the smallest admissible deposit (minAmount + txMaxFee), 37_999
    ///      gives 49_000 sat.
    function _openReservation(
        uint256 amountSeed
    ) internal returns (uint256 key, bytes20 src, bytes20 dst) {
        dst = _registerWalletFromKey(1);
        src = harnessWallets[0];
        reservationRouter_revealAndAcceptReservedDeposit_flow(
            amountSeed,
            0,
            1,
            0
        );
        require(harnessReservationKeys.length == 1, "no reservation");
        key = harnessReservationKeys[0];
        Reservation.ReservationRequest memory r = reservationRouter
            .reservations(key);
        require(r.state == Reservation.ReservationState.Active, "not active");
        require(r.walletPubKeyHash == src, "wrong wallet");
    }

    /// @dev Calls the setter as governance with words `w` (word 6, the
    ///      running total, is not an argument) and expects `reason`.
    function _expectSetterRevert(
        uint256[10] memory w,
        string memory reason
    ) internal {
        vm.prank(governance);
        vm.expectRevert(bytes(reason));
        reservationRouter.updateReservationParameters(
            address(uint160(w[0])),
            uint64(w[1]),
            uint64(w[2]),
            uint32(w[3]),
            uint32(w[4]),
            uint64(w[5]),
            uint32(w[7]),
            uint32(w[8]),
            uint32(w[9])
        );
    }

    /// @dev The ten static return words of `reservationParameters()`.
    function _words() internal view returns (uint256[10] memory) {
        (bool ok, bytes memory ret) = address(reservationRouter).staticcall(
            abi.encodeWithSelector(
                reservationRouter.reservationParameters.selector
            )
        );
        require(ok, "reservationParameters failed");
        return abi.decode(ret, (uint256[10]));
    }

    /// @dev Reveals a reserved deposit of `amount` for `wallet`.
    function _reveal(
        address depositor,
        bytes20 wallet,
        uint64 amount
    )
        internal
        returns (
            uint256 key,
            bytes32 fundingTxHash,
            uint32 outIdx,
            BitcoinTx.Info memory fundingTx,
            BitcoinTx.Proof memory fundingProof
        )
    {
        Deposit.DepositRevealInfo memory reveal = Deposit.DepositRevealInfo({
            fundingOutputIndex: 1,
            blindingFactor: bytes8(keccak256("rqb.blinding")),
            walletPubKeyHash: wallet,
            refundPubKeyHash: bytes20(keccak256("rqb.refund")),
            refundLocktime: _le32(uint32(block.timestamp + 4 days)),
            vault: address(reservationVault)
        });
        (fundingTx, outIdx) = BtcBuilder.depositFundingTx(
            reveal,
            depositor,
            bytes32(0),
            false,
            true,
            amount,
            keccak256("RequireBoundaryGuards")
        );
        fundingTxHash = BtcBuilder.txHash(fundingTx);
        key = uint256(keccak256(abi.encodePacked(fundingTxHash, outIdx)));
        // Build the proof before any prank (BtcBuilder uses the sha256
        // precompile, which would consume a pending vm.prank).
        fundingProof = BtcBuilder.prove(fundingTx, 1);
        vm.prank(depositor);
        bridge.revealDeposit(fundingTx, reveal);
    }

    function _le32(uint32 v) internal pure returns (bytes4) {
        return
            bytes4(
                (v << 24) |
                    ((v & 0xff00) << 8) |
                    ((v >> 8) & 0xff00) |
                    (v >> 24)
            );
    }
}
