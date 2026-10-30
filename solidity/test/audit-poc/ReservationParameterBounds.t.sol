// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// Regression tests for two mutations of `updateReservationParameters` found by
// the targeted slither-mutate pass of 2026-10-07 (operator LOR). Before this
// file no Foundry or Hardhat test sent an out-of-range term or renewal window,
// so both survived.
//
// Source lines involved (solidity/contracts/bridge/Reservation.sol):
//   1281-1285  term in [MIN_RESERVATION_TERM, MAX_RESERVATION_TERM]
//              (90 and 730 days); the mutant `>= MIN || <= MAX` is always
//              true, so any term passes.
//   1286-1290  0 < renewal window < term; the mutant `> 0 || < term` passes
//              a zero window and a window equal to the term.
//
// The setter is called as the governance account on the fizz deployment
// (test/fizz/Base.sol). Every other argument keeps its current value.

import {Test} from "forge-std/Test.sol";
import {Handlers} from "../fizz/handlers/Handlers.sol";

contract ReservationParameterBoundsTest is Test, Handlers {
    modifier asActor() override {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    string internal constant ERR_TERM =
        "Reservation term out of protocol bounds";
    string internal constant ERR_RENEWAL =
        "Renewal window must be shorter than the term";

    // Reservation.sol:72-73.
    uint32 internal constant MIN_TERM = 90 days;
    uint32 internal constant MAX_TERM = 730 days;

    function setUp() public {
        setup();
    }

    function test_term_belowMinimumReverts() public {
        uint256[10] memory w = _words();
        vm.expectRevert(bytes(ERR_TERM));
        _update(w, MIN_TERM - 1, uint32(w[9]));
    }

    function test_term_aboveMaximumReverts() public {
        uint256[10] memory w = _words();
        vm.expectRevert(bytes(ERR_TERM));
        _update(w, MAX_TERM + 1, uint32(w[9]));
    }

    function test_term_bothBoundsAccepted() public {
        uint256[10] memory w = _words();
        _update(w, MIN_TERM, uint32(w[9]));
        assertEq(_words()[3], uint256(MIN_TERM), "minimum term set");
        _update(_words(), MAX_TERM, uint32(w[9]));
        assertEq(_words()[3], uint256(MAX_TERM), "maximum term set");
    }

    function test_renewalWindow_zeroReverts() public {
        uint256[10] memory w = _words();
        vm.expectRevert(bytes(ERR_RENEWAL));
        _update(w, uint32(w[3]), 0);
    }

    function test_renewalWindow_equalToTermReverts() public {
        uint256[10] memory w = _words();
        vm.expectRevert(bytes(ERR_RENEWAL));
        _update(w, uint32(w[3]), uint32(w[3]));
    }

    function test_renewalWindow_oneSecondBelowTermAccepted() public {
        uint256[10] memory w = _words();
        _update(w, uint32(w[3]), uint32(w[3]) - 1);
        assertEq(_words()[9], w[3] - 1, "renewal window set");
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev Calls the setter as governance with the current words, except the
    ///      term and the renewal window. Word 6 of `reservationParameters()`
    ///      is the running total and is not an argument of the setter.
    function _update(
        uint256[10] memory w,
        uint32 term,
        uint32 renewalWindow
    ) internal {
        vm.prank(governance);
        reservationRouter.updateReservationParameters(
            address(uint160(w[0])),
            uint64(w[1]),
            uint64(w[2]),
            term,
            uint32(w[4]),
            uint64(w[5]),
            uint32(w[7]),
            uint32(w[8]),
            renewalWindow
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
}
