// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// Regression tests for R-01 (audit finding F01): reservation capacity was
// admitted for deposits nobody had to fund. `revealDeposit` checks no Bitcoin
// proof, so an attacker with only gas could reveal fabricated reserved
// deposits and call `requestReservationAcceptance` on each, filling a Live
// wallet's slots, its amount cap and the global cap, and keep them full by
// repeating after every timeout. The pre-fix proof of concept (7 tests showing
// the exhaustion) is not published: it drives the router interface this fix
// replaced and cannot compile against it.
//
// Fix: `ReservationRouter.requestReservationAcceptance` takes the funding
// transaction, its SPV proof and the output index, validates the proof with
// the Bridge's usual rules and derives the reservation key from the proven
// transaction hash. A fabricated deposit has no transaction in a block with
// real work, so its request reverts before any capacity is reserved.
//
// Harness limit: the fizz relay (`SystemTestRelay`, difficulty 0) accepts any
// `BtcBuilder` proof, so to model "no real work" these tests raise the relay
// difficulty, or present a valid proof of a different transaction.

import {Test} from "forge-std/Test.sol";
import {Handlers} from "../fizz/handlers/Handlers.sol";
import {BtcBuilder} from "../fizz/utils/BtcBuilder.sol";
import {BitcoinTx} from "../../contracts/bridge/BitcoinTx.sol";
import {Deposit} from "../../contracts/bridge/Deposit.sol";

contract F01FakeDepositCapacity is Test, Handlers {
    modifier asActor() override {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    uint64 internal constant DEPOSIT_SAT = 50_000;

    bytes20 internal w0;
    address internal f01Attacker;
    address internal f01Honest;
    uint256 internal f01Nonce;

    struct Funding {
        uint256 key;
        BitcoinTx.Info info;
        uint32 outputIndex;
    }

    function setUp() public {
        setup();
        w0 = BtcBuilder.pubKeyHash(walletPubX[0], walletPubY[0]);
        f01Attacker = makeAddr("f01.attacker");
        f01Honest = makeAddr("f01.honest");
    }

    /// @notice A fabricated deposit whose funding transaction is not in a
    ///         block with enough work (relay difficulty above the headers')
    ///         cannot be requested, and no capacity moves.
    function test_R01_unprovenFundingTxCannotReserveCapacity() public {
        Funding memory fake = _reveal(f01Attacker, DEPOSIT_SAT);
        BitcoinTx.Proof memory proof = BtcBuilder.prove(fake.info, 1);
        _snapshotCapacity();

        relay.setCurrentEpochDifficulty(1);
        relay.setPrevEpochDifficulty(1);
        vm.prank(f01Attacker);
        vm.expectRevert();
        reservationRouter.requestReservationAcceptance(
            fake.info,
            proof,
            fake.outputIndex,
            w0
        );
        _assertCapacityUnchanged();
    }

    /// @notice A valid proof of another transaction cannot stand in for the
    ///         fabricated deposit's funding transaction: the merkle proof does
    ///         not match the fabricated transaction.
    function test_R01_borrowedProofOfAnotherTxReverts() public {
        Funding memory honest = _reveal(f01Honest, DEPOSIT_SAT);
        Funding memory fake = _reveal(f01Attacker, DEPOSIT_SAT);
        BitcoinTx.Proof memory honestProof = BtcBuilder.prove(honest.info, 1);
        _snapshotCapacity();

        vm.prank(f01Attacker);
        vm.expectRevert(
            bytes(
                "Tx merkle proof is not valid for provided header and tx hash"
            )
        );
        reservationRouter.requestReservationAcceptance(
            fake.info,
            honestProof,
            fake.outputIndex,
            w0
        );
        _assertCapacityUnchanged();
    }

    /// @notice The key is derived from the proven transaction: a valid proof
    ///         of the honest deposit, sent by the attacker, reaches the
    ///         honest deposit and fails the depositor check. The attacker
    ///         cannot attach someone else's proof to their own key.
    function test_R01_proofBindsTheReservationKey() public {
        Funding memory honest = _reveal(f01Honest, DEPOSIT_SAT);
        BitcoinTx.Proof memory proof = BtcBuilder.prove(honest.info, 1);

        vm.prank(f01Attacker);
        vm.expectRevert(bytes("Caller is not the deposit's depositor"));
        reservationRouter.requestReservationAcceptance(
            honest.info,
            proof,
            honest.outputIndex,
            w0
        );
    }

    /// @notice An honest deposit with a valid funding proof is still
    ///         accepted and takes exactly one slot.
    function test_R01_provenDepositIsAccepted() public {
        Funding memory honest = _reveal(f01Honest, DEPOSIT_SAT);
        BitcoinTx.Proof memory proof = BtcBuilder.prove(honest.info, 1);
        uint32 countBefore = reservationRouter.walletReservationsCount(w0);

        vm.prank(f01Honest);
        reservationRouter.requestReservationAcceptance(
            honest.info,
            proof,
            honest.outputIndex,
            w0
        );
        assertEq(
            uint256(reservationRouter.reservations(honest.key).requestNonce),
            1,
            "acceptance requested"
        );
        assertEq(
            uint256(reservationRouter.walletReservationsCount(w0)),
            uint256(countBefore) + 1,
            "one slot taken"
        );
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    uint32 internal capCount;
    uint64 internal capAmount;
    uint64 internal capTotal;
    uint32 internal capActive;

    function _snapshotCapacity() internal {
        capCount = reservationRouter.walletReservationsCount(w0);
        capAmount = reservationRouter.walletReservationsAmount(w0);
        capTotal = _total();
        (capActive, ) = reservationRouter.activeReservationsCount();
    }

    function _assertCapacityUnchanged() internal {
        assertEq(
            uint256(reservationRouter.walletReservationsCount(w0)),
            uint256(capCount),
            "wallet count"
        );
        assertEq(
            uint256(reservationRouter.walletReservationsAmount(w0)),
            uint256(capAmount),
            "wallet amount"
        );
        assertEq(uint256(_total()), uint256(capTotal), "global total");
        (uint32 active, ) = reservationRouter.activeReservationsCount();
        assertEq(uint256(active), uint256(capActive), "active count");
    }

    function _total() internal view returns (uint64 t) {
        (, , , , , , t, , , ) = reservationRouter.reservationParameters();
    }

    function _reveal(
        address depositor,
        uint64 amount
    ) internal returns (Funding memory f) {
        bytes32 entropy = keccak256(abi.encode("f01.deposit", ++f01Nonce));
        uint256 locktime = block.timestamp + RESERVATION_TERM_SECONDS + 1 days;
        Deposit.DepositRevealInfo memory reveal = Deposit.DepositRevealInfo({
            fundingOutputIndex: 0,
            blindingFactor: bytes8(keccak256(abi.encode(entropy, "blinding"))),
            walletPubKeyHash: w0,
            refundPubKeyHash: bytes20(
                keccak256(abi.encode(entropy, depositor, "refund"))
            ),
            refundLocktime: _le32(uint32(locktime)),
            vault: address(reservationVault)
        });
        (f.info, f.outputIndex) = BtcBuilder.depositFundingTx(
            reveal,
            depositor,
            bytes32(0),
            false,
            uint256(entropy) % 2 == 0,
            amount,
            entropy
        );
        f.key = uint256(
            keccak256(
                abi.encodePacked(BtcBuilder.txHash(f.info), f.outputIndex)
            )
        );
        vm.prank(depositor);
        bridge.revealDeposit(f.info, reveal);
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
