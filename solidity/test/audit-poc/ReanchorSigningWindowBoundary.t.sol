// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// Regression test for the mutation that turns the `&&` at Reservation.sol:790
// in `requestReservationReanchor` into `||` (slither-mutate LOR, targeted
// pass of 2026-10-07). Before this file no Foundry or Hardhat test reached the
// "Reanchor authorization has no signing window" revert, so the mutant
// survived. It is the re-anchor twin of the acceptance boundary in
// AcceptanceSigningWindowBoundary.t.sol (register row R-50).
//
// Source lines involved (solidity/contracts/bridge):
//   Reservation.sol:778-797   timeoutAt = now + reservationActionTimeout;
//                             requires timeoutAt > REQUEST_TIMEOUT_SAFETY_MARGIN
//                             && now + 1 < timeoutAt - REQUEST_TIMEOUT_SAFETY_MARGIN
//   Reservation.sol:1291-1295 updateReservationParameters accepts any
//                             reservationActionTimeout strictly above
//                             REQUEST_TIMEOUT_SAFETY_MARGIN (2 hours)
//
// With an action timeout of 7201 seconds the second clause reads
// `now + 1 < now + 1`, which is false, so the original reverts. The first
// clause is true for any real clock, so with `||` the mutant accepts and
// creates an action no wallet can sign. With 7202 seconds both accept.
//
// Second mutation (same pass, MIA): `if (!privileged)` at Reservation.sol:737
// replaced by `if (true)`, so governance is also held by the re-anchor
// cooldown. `test_reanchor_governanceBypassesCooldown` pins it: after a
// timed-out re-anchor the cooldown runs, and governance can still request
// the next re-anchor at once.
//
// The reservation is created by the fizz handlers on the real Bridge and
// ReservationRouter (test/fizz/Base.sol). Governance sends the re-anchor
// requests, the privileged branch, because the source wallet is Live.

import {Test} from "forge-std/Test.sol";
import {Handlers} from "../fizz/handlers/Handlers.sol";
import {Reservation} from "../../contracts/bridge/Reservation.sol";

contract ReanchorSigningWindowBoundaryTest is Test, Handlers {
    modifier asActor() override {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    string internal constant ERR_NO_SIGNING_WINDOW =
        "Reanchor authorization has no signing window";

    // REQUEST_TIMEOUT_SAFETY_MARGIN in WalletProposalValidatorConstants.
    uint32 internal constant SAFETY_MARGIN = 2 hours;

    function setUp() public {
        setup();
    }

    /// @notice Action timeout of 7201 seconds: the signing deadline is
    ///         `now + 1`, so no integer timestamp fits and the request
    ///         reverts. The `||` mutant accepts here.
    function test_reanchor_revertsWhenActionTimeoutLeavesNoSigningWindow()
        public
    {
        (uint256 key, bytes20 target) = _activeReservationAndSecondWallet();
        _setActionTimeout(SAFETY_MARGIN + 1);

        vm.prank(governance);
        vm.expectRevert(bytes(ERR_NO_SIGNING_WINDOW));
        reservationRouter.requestReservationReanchor(key, target);

        assertEq(
            uint256(reservationRouter.reservations(key).requestNonce),
            1,
            "no re-anchor generation created"
        );
    }

    /// @notice One second above the boundary (7202 seconds) the same request
    ///         creates a pending re-anchor action.
    function test_reanchor_succeedsOneSecondAboveTheBoundary() public {
        (uint256 key, bytes20 target) = _activeReservationAndSecondWallet();
        _setActionTimeout(SAFETY_MARGIN + 2);

        vm.prank(governance);
        reservationRouter.requestReservationReanchor(key, target);

        uint64 requestNonce = reservationRouter.reservations(key).requestNonce;
        assertEq(uint256(requestNonce), 2, "second action generation");
        Reservation.ReservationAction memory action = reservationRouter
            .reservationActions(key, requestNonce);
        assertEq(
            uint256(uint8(action.state)),
            uint256(uint8(Reservation.ActionState.Pending)),
            "action pending"
        );
        assertEq(
            action.targetWalletPubKeyHash,
            target,
            "action targets the second wallet"
        );
        assertEq(
            uint256(action.timeoutAt),
            block.timestamp + uint256(SAFETY_MARGIN) + 2,
            "timeout is now + action timeout"
        );
    }

    /// @notice A re-anchor that times out starts a cooldown of one action
    ///         timeout (Reservation.sol:906-908). Governance is exempt from it
    ///         (Reservation.sol:737-742) and can request again at once.
    function test_reanchor_governanceBypassesCooldown() public {
        (uint256 key, bytes20 target) = _activeReservationAndSecondWallet();
        _setActionTimeout(SAFETY_MARGIN + 2);

        vm.prank(governance);
        reservationRouter.requestReservationReanchor(key, target);
        vm.warp(block.timestamp + uint256(SAFETY_MARGIN) + 3);
        reservationRouter.notifyReservationActionTimeout(key);

        Reservation.ReservationRequest memory r = reservationRouter
            .reservations(key);
        assertEq(
            uint256(uint8(r.state)),
            uint256(uint8(Reservation.ReservationState.Active)),
            "Active again after the timeout"
        );
        assertGt(
            uint256(r.reanchorCooldownUntil),
            block.timestamp,
            "cooldown is running"
        );

        vm.prank(governance);
        reservationRouter.requestReservationReanchor(key, target);
        assertEq(
            uint256(reservationRouter.reservations(key).requestNonce),
            3,
            "governance re-anchored inside the cooldown"
        );
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev One Active reservation with an anchor of 12_001 sat (above
    ///      minAmount + txMaxFee, Reservation.sol:798-809) and a second Live
    ///      wallet as the re-anchor target.
    function _activeReservationAndSecondWallet()
        internal
        returns (uint256 key, bytes20 target)
    {
        // (amountSeed, walletSeed, entropySeed, feeSeed)
        reservationRouter_revealAndAcceptReservedDeposit_flow(1001, 0, 0, 0);
        assertEq(harnessReservationKeys.length, 1, "reservation created");
        key = harnessReservationKeys[0];
        assertEq(
            uint256(uint8(reservationRouter.reservations(key).state)),
            uint256(uint8(Reservation.ReservationState.Active)),
            "reservation is Active"
        );
        assertEq(
            uint256(reservationRouter.reservations(key).requestNonce),
            1,
            "one acceptance generation"
        );

        // The first wallet is younger than walletCreationPeriod
        // (Wallets.sol:171-180), so drop the period and the min balance.
        _allowNewWallet();
        bridge_requestAndCreateWallet_clamped(bytes32(0));
        assertGe(harnessWallets.length, 2, "second wallet created");

        bytes20 source = reservationRouter.reservations(key).walletPubKeyHash;
        for (uint256 i = 0; i < harnessWallets.length; i++) {
            if (harnessWallets[i] != source) {
                target = harnessWallets[i];
                break;
            }
        }
        assertTrue(target != bytes20(0), "target wallet found");
    }

    /// @dev Resubmits the current reservation parameters through governance
    ///      with only the action timeout replaced. Word 6 of
    ///      `reservationParameters()` is the running total and is not an
    ///      argument of the setter.
    function _setActionTimeout(uint32 actionTimeout) internal {
        uint256[10] memory w = _reservationParameterWords();
        vm.prank(governance);
        reservationRouter.updateReservationParameters(
            address(uint160(w[0])),
            uint64(w[1]),
            uint64(w[2]),
            uint32(w[3]),
            uint32(w[4]),
            uint64(w[5]),
            uint32(w[7]),
            actionTimeout,
            uint32(w[9])
        );
        assertEq(
            _reservationParameterWords()[8],
            uint256(actionTimeout),
            "timeout set"
        );
    }

    /// @dev The ten static return words of `reservationParameters()`.
    function _reservationParameterWords()
        internal
        view
        returns (uint256[10] memory)
    {
        (bool ok, bytes memory ret) = address(reservationRouter).staticcall(
            abi.encodeWithSelector(
                reservationRouter.reservationParameters.selector
            )
        );
        require(ok, "reservationParameters failed");
        return abi.decode(ret, (uint256[10]));
    }

    /// @dev Governance sets walletCreationPeriod and
    ///      walletCreationMinBtcBalance to 0; the other five wallet
    ///      parameters keep their values.
    function _allowNewWallet() internal {
        (
            ,
            ,
            uint64 maxBalance,
            uint64 closureMin,
            uint32 maxAge,
            uint64 maxTransfer,
            uint32 closingPeriod
        ) = bridge.walletParameters();
        _bridge_updateWalletParameters(
            0,
            0,
            maxBalance,
            closureMin,
            maxAge,
            maxTransfer,
            closingPeriod
        );
    }
}
