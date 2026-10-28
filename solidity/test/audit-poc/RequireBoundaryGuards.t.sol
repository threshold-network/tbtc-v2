// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// Regression tests for `require` comparison boundaries that survived the
// RQB mutation pass of 2026-10-11 (one operator swap per comparison:
// `<`/`<=`, `>`/`>=`, `==`/`!=`). slither 0.11.6 ROR could not mutate
// `require` conditions (it nests the statement inside itself), so these
// comparisons were never mutation-tested before. Each test pins the exact
// boundary the surviving mutant moves. Rows in
// fizz_data/mutation/TRIAGE.md (fifth pass).
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
    ///         `reanchorCooldownUntil` and refused one second earlier.
    function test_reanchor_allowedExactlyAtCooldownEnd() public {
        (uint256 key, bytes20 src, bytes20 dst) = _openReservation(37_999);
        BitcoinTx.UTXO memory none = BitcoinTx.UTXO(bytes32(0), 0, 0);
        bridge.notifyWalletCloseable(src, none); // anchor-blind: MovingFunds

        vm.prank(honest);
        reservationRouter.requestReservationReanchor(key, dst);
        uint64 nonce = reservationRouter.reservations(key).requestNonce;
        vm.warp(reservationRouter.reservationActions(key, nonce).timeoutAt);
        reservationRouter.notifyReservationActionTimeout(key);
        uint32 cooldownUntil = reservationRouter
            .reservations(key)
            .reanchorCooldownUntil;

        vm.warp(uint256(cooldownUntil) - 1);
        vm.prank(honest);
        vm.expectRevert(bytes("Reanchor cooldown in effect"));
        reservationRouter.requestReservationReanchor(key, dst);

        vm.warp(cooldownUntil);
        vm.prank(honest);
        reservationRouter.requestReservationReanchor(key, dst);
        assertEq(
            uint256(uint8(reservationRouter.reservations(key).state)),
            uint256(uint8(Reservation.ReservationState.ActionPending)),
            "re-anchor requested at the cooldown end"
        );
    }

    /// @notice Line 807: an anchor of exactly `minAmount + txMaxFee` cannot
    ///         be re-anchored (the floor is strict). The position is built
    ///         with direct calls: the fuzz flow handler would fire SP-85 on
    ///         this very anchor.
    function test_reanchor_refusedAtExactFloor() public {
        bytes20 dst = _registerWalletFromKey(1);
        uint64 floorAmount = RESERVATION_MIN_AMOUNT + RESERVATION_TX_MAX_FEE;
        uint256 key = _acceptDirect(harnessWallets[0], floorAmount, floorAmount);
        assertEq(
            uint256(reservationRouter.reservations(key).anchorAmount),
            uint256(floorAmount),
            "anchor at the floor"
        );

        vm.prank(governance);
        vm.expectRevert(
            bytes("Reanchor would fall below the minimum reservation amount")
        );
        reservationRouter.requestReservationReanchor(key, dst);
    }

    /// @notice Line 827: a re-anchor whose target lands exactly on the
    ///         per-wallet amount cap is allowed.
    function test_reanchor_allowedExactlyAtPerWalletAmountCap() public {
        (uint256 key, , bytes20 dst) = _openReservation(37_999);
        uint64 anchor = reservationRouter.reservations(key).anchorAmount;
        (, uint64 single, uint32 maxActive) = reservationRouter
            .reservationCaps();
        vm.prank(governance);
        reservationRouter.updateReservationCaps(anchor, single, maxActive);

        vm.prank(governance);
        reservationRouter.requestReservationReanchor(key, dst);
        assertEq(
            uint256(reservationRouter.walletReservationsAmount(dst)),
            uint256(anchor),
            "target exactly at the cap"
        );
    }

    // ------------------------------------------------------------------
    // Acceptance proof boundary
    // ------------------------------------------------------------------

    /// @notice ReservationProofs.sol:464: the smallest admissible deposit
    ///         (minAmount + txMaxFee) proven with the full fee gives an
    ///         anchor of exactly `minAmount`, which is accepted.
    function test_acceptanceProof_anchorExactlyAtMinimumAccepted() public {
        uint256 key = _acceptDirect(
            harnessWallets[0],
            RESERVATION_MIN_AMOUNT + RESERVATION_TX_MAX_FEE,
            RESERVATION_MIN_AMOUNT
        );
        assertEq(
            uint256(reservationRouter.reservations(key).anchorAmount),
            uint256(RESERVATION_MIN_AMOUNT),
            "anchor exactly at the minimum"
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
        bytes32 fundingTxHash;
        uint32 outIdx;
        (key, fundingTxHash, outIdx) = _reveal(actors[0], wallet, amount);
        vm.prank(actors[0]);
        reservationRouter.requestReservationAcceptance(key, wallet);

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

    /// @notice Line 1292: an action timeout of exactly the 2 h safety
    ///         margin is refused.
    function test_setter_refusesActionTimeoutEqualToSafetyMargin() public {
        uint256[10] memory w = _words();
        w[8] = 2 hours;
        _expectSetterRevert(
            w,
            "Reservation action timeout must exceed the safety margin"
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
        (, , uint32 maxActive) = reservationRouter.reservationCaps();
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
    function _openReservation(uint256 amountSeed)
        internal
        returns (
            uint256 key,
            bytes20 src,
            bytes20 dst
        )
    {
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
    function _expectSetterRevert(uint256[10] memory w, string memory reason)
        internal
    {
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
            uint32 outIdx
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
        BitcoinTx.Info memory fundingTx;
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
