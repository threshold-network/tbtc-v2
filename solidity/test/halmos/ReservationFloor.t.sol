// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

// Halmos 0.3.3 symbolic checks for audit lead SP-85 (the re-anchor request
// floor is strictly above what acceptance admits, so an Active anchor of
// `txMaxFee + minAmount` sat or less can never be re-anchored).
//
// The arithmetic is copied, not called. `requestReservationReanchor` and the
// acceptance request are external library functions over `BridgeState.Storage`
// (linked libraries, wallet state machine, timeout rules), which is far more
// state than the one comparison under check. Each copy below cites its source;
// a change to the source line MUST be mirrored here or the check proves
// nothing. All amounts are uint64 exactly as in the contracts.
//
// DERIVED against the `reservations-upgrade` head, whose contracts carry the
// acceptance floor `deposit.amount > minAmount + 2 * txMaxFee`. The earlier
// revision of this harness was derived against a tree where the acceptance
// floor was still `deposit.amount >= minAmount + txMaxFee`, and it was carried
// over unchanged while the contracts moved, so every check below used to prove
// a statement about an admission rule the contracts no longer have. Every
// cited line number moved as well.
//
// Source lines (solidity/contracts/bridge), at this head:
//   Reservation.sol:596-600         request-time deposit floor
//                                   `deposit.amount > minAmount + 2 * txMaxFee`
//                                   (uint256 arithmetic: no overflow revert)
//   ReservationProofs.sol:462-465   `action.amount - anchorAmount <= action.txMaxFee`
//   ReservationProofs.sol:473-476   `anchorAmount >= action.minAmount`
//   Reservation.sol:900-906         `anchorAmount > txMaxFee + minAmount`
//                                   (re-anchor request floor; uint64 addition,
//                                   so it reverts on overflow)
//   ReservationProofs.sol:700-703   re-anchor settlement: fee <= txMaxFee
//   ReservationProofs.sol:708-711   re-anchor settlement: new anchor > txMaxFee
//   Reservation.sol:1614-1621       parameter setter: txMaxFee > 0 and
//                                   minAmount > txMaxFee
//
// Scope notes:
//  - One parameter set is used for acceptance and for the re-anchor request.
//    In the contracts acceptance uses the snapshot `action.txMaxFee` and
//    `action.minAmount` (Reservation.sol:674-675) while the re-anchor request
//    reads the live values (:867, :901). A governance parameter change between
//    the two is a second, separate way to get stuck and is not modelled.
//  - The acceptance deposit floor is computed in uint256
//    (`uint256(minAmount) + 2 * uint256(txMaxFee)`), so it cannot overflow and
//    never reverts. The re-anchor request floor is a uint64 addition
//    (`txMaxFee + minAmount`), which reverts on overflow; a re-anchor request
//    that overflows therefore fails, which is the same observable outcome as
//    the floor being unreachable. Both are excluded with `vm.assume` (see
//    `_assumeParams`).
//  - `minAmount > txMaxFee` (the parameter setter's rule) is modelled, and
//    `txMaxFee > 0`.
//  - The copies keep the contracts' own widths. Halmos 0.3.3 abstracts 256-bit
//    MUL and MOD as uninterpreted functions, and Solidity's checked
//    multiplication compiles to MULMOD, so a uint64 `2 * txMaxFee` is not
//    modelled exactly. Every bound below is therefore either computed in
//    uint256 (as the contract computes it) or written as two uint64 additions
//    rather than a multiplication. A derived uint64 deposit amount is never
//    computed from a bound.
//
// Every check below passes unless its name ends in `_expectedCounterexample`.
// Counterexamples are marked with a comment starting `expected counterexample`.

import {Test} from "forge-std/Test.sol";

contract ReservationFloorHalmos is Test {
    // --- copies of the contract arithmetic (MUST match the cited lines) -----

    /// Reservation.sol:596-600. The acceptance deposit floor:
    /// `deposit.amount > minAmount + 2 * txMaxFee`.
    /// The contract computes the right-hand side in uint256, so this copy
    /// does too and cannot overflow.
    function depositAccepted(
        uint64 depositAmount,
        uint64 txMaxFee,
        uint64 minAmount
    ) internal pure returns (bool) {
        return
            uint256(depositAmount) >
                uint256(minAmount) + 2 * uint256(txMaxFee);
    }

    /// ReservationProofs.sol:462-465 and :473-476. `depositAmount -
    /// anchorAmount` panics (0x11) when the anchor exceeds the deposit, which
    /// is a revert, so such an anchor is not admitted.
    function anchorAdmitted(
        uint64 depositAmount,
        uint64 anchorAmount,
        uint64 txMaxFee,
        uint64 minAmount
    ) internal pure returns (bool) {
        return
            anchorAmount <= depositAmount &&
            depositAmount - anchorAmount <= txMaxFee &&
            anchorAmount >= minAmount;
    }

    /// Reservation.sol:900-906 (current code, strict). The right-hand side is
    /// a uint64 addition in the contract and reverts on overflow, so the
    /// copy keeps the uint64 type and the overflow is excluded upstream.
    function reanchorFloorOk(
        uint64 anchorAmount,
        uint64 txMaxFee,
        uint64 minAmount
    ) internal pure returns (bool) {
        return anchorAmount > txMaxFee + minAmount;
    }

    /// Candidate fix A: the same floor with `>=`.
    function reanchorFloorOkGeq(
        uint64 anchorAmount,
        uint64 txMaxFee,
        uint64 minAmount
    ) internal pure returns (bool) {
        return anchorAmount >= txMaxFee + minAmount;
    }

    /// Parameter setter rules (Reservation.sol:1614-1621) plus the
    /// no-overflow exclusions described in the file header.
    function _assumeParams(uint64 txMaxFee, uint64 minAmount) internal pure {
        vm.assume(txMaxFee > 0);
        vm.assume(minAmount > txMaxFee);
        vm.assume(
            uint256(minAmount) + uint256(txMaxFee) <= type(uint64).max
        );
    }

    // --- current code -------------------------------------------------------

    /// SP-85 as a safety property: every anchor that acceptance admits can be
    /// re-anchored.
    ///
    /// Under the derived floor the smallest admissible deposit is
    /// `minAmount + 2 * txMaxFee + 1`, so an admitted anchor is at least
    /// `deposit - txMaxFee > minAmount + txMaxFee` and clears the re-anchor
    /// floor strictly. The gap the OLD floor had does not exist here.
    /// Expected result: pass.
    function check_SP85_currentCode_admittedAnchorIsReanchorable(
        uint64 depositAmount,
        uint64 anchorAmount,
        uint64 txMaxFee,
        uint64 minAmount
    ) public pure {
        _assumeParams(txMaxFee, minAmount);
        vm.assume(depositAccepted(depositAmount, txMaxFee, minAmount));
        vm.assume(
            anchorAdmitted(depositAmount, anchorAmount, txMaxFee, minAmount)
        );

        assert(reanchorFloorOk(anchorAmount, txMaxFee, minAmount));
    }

    /// The stuck band is `[minAmount, minAmount + txMaxFee]`: the anchors the
    /// re-anchor floor rejects. The same property as the check above, stated
    /// over the band: no admitted anchor lies in it.
    /// Expected result: pass.
    function check_SP85_currentCode_noAdmittedAnchorLiesInTheStuckBand(
        uint64 depositAmount,
        uint64 anchorAmount,
        uint64 txMaxFee,
        uint64 minAmount
    ) public pure {
        _assumeParams(txMaxFee, minAmount);
        vm.assume(depositAccepted(depositAmount, txMaxFee, minAmount));
        vm.assume(
            anchorAdmitted(depositAmount, anchorAmount, txMaxFee, minAmount)
        );

        // Strictly above the band: `deposit > min + 2 * fee` and
        // `deposit - anchor <= fee` give `anchor > min + fee`.
        assert(anchorAmount > minAmount + txMaxFee);
    }

    /// The band is unreachable from acceptance: no anchor in
    /// `[minAmount, minAmount + txMaxFee]` can be admitted by an accepted
    /// deposit.
    ///
    /// The assumptions are that the anchor sits in the band
    /// (`anchor <= min + fee`) and that it is admitted by the deposit
    /// (`deposit - anchor <= fee`, so `deposit <= anchor + fee`). Together
    /// they give `deposit <= min + 2 * fee`, which is exactly the negation of
    /// the acceptance floor. So the deposit cannot have been accepted.
    ///
    /// This is the check that would fail if the acceptance floor were
    /// relaxed back to `deposit >= min + fee`: the old floor admits a
    /// deposit of `min + fee` with a full-fee anchor of `min`, which is in
    /// the band.
    /// Expected result: pass.
    function check_SP85_currentCode_stuckBandIsUnreachable(
        uint64 depositAmount,
        uint64 anchorAmount,
        uint64 txMaxFee,
        uint64 minAmount
    ) public pure {
        _assumeParams(txMaxFee, minAmount);
        vm.assume(anchorAmount >= minAmount);
        vm.assume(anchorAmount <= minAmount + txMaxFee);
        vm.assume(
            anchorAdmitted(depositAmount, anchorAmount, txMaxFee, minAmount)
        );

        assert(!depositAccepted(depositAmount, txMaxFee, minAmount));
    }

    /// The regime where the acceptance floor is above every possible uint64
    /// deposit: `minAmount + 2 * txMaxFee` exceeds `type(uint64).max`, so no
    /// deposit can clear the floor and no anchor can be admitted at all.
    /// Expected result: pass.
    function check_SP85_currentCode_floorAboveUint64AdmitsNothing(
        uint64 txMaxFee,
        uint64 minAmount
    ) public pure {
        _assumeParams(txMaxFee, minAmount);
        vm.assume(
            uint256(minAmount) + 2 * uint256(txMaxFee) > type(uint64).max
        );

        assert(!depositAccepted(type(uint64).max, txMaxFee, minAmount));
    }

    /// The witness that the band check above is not vacuous: under the OLD
    /// acceptance floor (`deposit.amount >= minAmount + txMaxFee`, the floor
    /// the contracts had before the acceptance-floor fix) a deposit of exactly
    /// `minAmount + txMaxFee` with a full-fee anchor of `minAmount` is
    /// admitted, and that anchor sits in the stuck band and can never be
    /// re-anchored. The old floor therefore admitted the defect SP-85
    /// describes; the current floor does not.
    /// expected counterexample: minAmount 2, txMaxFee 1, deposit 3, anchor 2.
    function check_SP85_oldFloor_admittedTheStuckBand_expectedCounterexample(
        uint64 depositAmount,
        uint64 anchorAmount,
        uint64 txMaxFee,
        uint64 minAmount
    ) public pure {
        _assumeParams(txMaxFee, minAmount);
        // The old floor: `deposit.amount >= minAmount + txMaxFee`.
        vm.assume(depositAmount >= minAmount + txMaxFee);
        vm.assume(
            anchorAdmitted(depositAmount, anchorAmount, txMaxFee, minAmount)
        );

        // The anchor is in the stuck band and cannot be re-anchored.
        assert(anchorAmount <= minAmount + txMaxFee);
        assert(!reanchorFloorOk(anchorAmount, txMaxFee, minAmount));
    }

    /// Concrete values from the fuzz campaigns (test/fizz/Base.sol:120-121:
    /// minAmount 10_000, txMaxFee 1_000). The acceptance floor is
    /// `10_000 + 2 * 1_000 = 12_000`, strict, so the smallest admissible
    /// deposit is 12_001 and it admits the lowest anchor 11_001, exactly one
    /// sat above the re-anchor floor 11_000.
    /// Expected result: pass.
    function check_SP85_currentCode_campaignValues() public pure {
        uint64 minAmount = 10_000;
        uint64 txMaxFee = 1_000;

        // The old smallest admissible deposit, 11_000, and the new floor
        // itself, 12_000, are both rejected: the floor is strict.
        assert(!depositAccepted(11_000, txMaxFee, minAmount));
        assert(!depositAccepted(12_000, txMaxFee, minAmount));

        // The new smallest admissible deposit, 12_001, with zero miner fee
        // admits the anchor 12_001, which clears the re-anchor floor 11_000.
        assert(depositAccepted(12_001, txMaxFee, minAmount));
        assert(anchorAdmitted(12_001, 12_001, txMaxFee, minAmount));
        assert(reanchorFloorOk(12_001, txMaxFee, minAmount));

        // The same deposit with the maximum fee admits the anchor 11_001,
        // the lowest admissible anchor: exactly one sat above the floor.
        assert(anchorAdmitted(12_001, 11_001, txMaxFee, minAmount));
        assert(reanchorFloorOk(11_001, txMaxFee, minAmount));

        // Neighbours outside the admitted set: a deposit one sat short, and
        // an anchor that loses more than txMaxFee.
        assert(!depositAccepted(12_000, txMaxFee, minAmount));
        assert(!anchorAdmitted(12_001, 11_000, txMaxFee, minAmount));
    }

    /// Why the floor exists (Reservation.sol:890-899): after a re-anchor hop
    /// that spends up to txMaxFee the anchor stays above minAmount, so the
    /// cumulative grind is capped at (initial anchor - minAmount). Current
    /// strict floor. Expected result: pass.
    function check_SP85_currentCode_antiGrindFloorHolds(
        uint64 anchorAmount,
        uint64 hopFee,
        uint64 txMaxFee,
        uint64 minAmount
    ) public pure {
        _assumeParams(txMaxFee, minAmount);
        vm.assume(reanchorFloorOk(anchorAmount, txMaxFee, minAmount));
        vm.assume(hopFee <= txMaxFee);

        uint64 next = anchorAmount - hopFee;

        assert(next > minAmount);
        assert(next > txMaxFee); // ReservationProofs.sol:708-711
    }

    // --- candidate fix A: relax the re-anchor floor to `>=` -----------------

    /// Fix A alone does NOT close the gap of the OLD acceptance floor: it
    /// only closes the zero-fee boundary. Admitted anchors in [minAmount,
    /// minAmount + txMaxFee) stayed stuck under that floor.
    /// The derived acceptance floor already closes the gap, so Fix A is
    /// redundant here and this check finds no counterexample.
    /// Expected result: pass.
    function check_SP85_fixA_geqFloorAlone(
        uint64 depositAmount,
        uint64 anchorAmount,
        uint64 txMaxFee,
        uint64 minAmount
    ) public pure {
        _assumeParams(txMaxFee, minAmount);
        vm.assume(depositAccepted(depositAmount, txMaxFee, minAmount));
        vm.assume(
            anchorAdmitted(depositAmount, anchorAmount, txMaxFee, minAmount)
        );

        assert(reanchorFloorOkGeq(anchorAmount, txMaxFee, minAmount));
    }

    /// Fix A still keeps the anti-grinding purpose: after one hop the anchor
    /// stays at or above minAmount, which is the acceptance invariant
    /// (ReservationProofs.sol:473-476), and above the settlement dust floor
    /// (:708-711). Expected result: pass.
    function check_SP85_fixA_geqFloorKeepsAntiGrindFloor(
        uint64 anchorAmount,
        uint64 hopFee,
        uint64 txMaxFee,
        uint64 minAmount
    ) public pure {
        _assumeParams(txMaxFee, minAmount);
        vm.assume(reanchorFloorOkGeq(anchorAmount, txMaxFee, minAmount));
        vm.assume(hopFee <= txMaxFee);

        uint64 next = anchorAmount - hopFee;

        assert(next >= minAmount);
        assert(next > txMaxFee);
    }

    // --- candidate fix B: raise the deposit minimum -------------------------

    /// Fix B, as it now stands in the contracts: acceptance requires
    /// `deposit.amount > minAmount + 2 * txMaxFee` (Reservation.sol:596-600),
    /// re-anchor floor unchanged. Every admitted anchor is then
    /// re-anchorable, because anchor >= deposit - txMaxFee > minAmount +
    /// txMaxFee. The bound is computed in uint256, so it cannot overflow.
    /// Expected result: pass.
    function check_SP85_fixB_strictDepositMinimumClosesGap(
        uint64 depositAmount,
        uint64 anchorAmount,
        uint64 txMaxFee,
        uint64 minAmount
    ) public pure {
        _assumeParams(txMaxFee, minAmount);
        vm.assume(depositAmount > minAmount + 2 * txMaxFee);
        vm.assume(
            anchorAdmitted(depositAmount, anchorAmount, txMaxFee, minAmount)
        );

        assert(reanchorFloorOk(anchorAmount, txMaxFee, minAmount));
    }

    /// Fix B with a NON-strict minimum (`>= minAmount + 2 * txMaxFee`) and the
    /// current strict floor does not close the gap: it is off by one.
    /// expected counterexample: minAmount 2, txMaxFee 1, deposit 4, anchor 3
    /// (fee 1): anchor == minAmount + txMaxFee, and the floor needs `>`.
    function check_SP85_fixB_nonStrictDepositMinimum_expectedCounterexample(
        uint64 depositAmount,
        uint64 anchorAmount,
        uint64 txMaxFee,
        uint64 minAmount
    ) public pure {
        _assumeParams(txMaxFee, minAmount);
        vm.assume(depositAmount >= minAmount + 2 * txMaxFee);
        vm.assume(
            anchorAdmitted(depositAmount, anchorAmount, txMaxFee, minAmount)
        );

        assert(reanchorFloorOk(anchorAmount, txMaxFee, minAmount));
    }

    /// Fix A and non-strict Fix B together (re-anchor floor `>=`, deposit
    /// minimum `>= minAmount + 2 * txMaxFee`): every admitted anchor is
    /// re-anchorable. Expected result: pass.
    function check_SP85_fixAB_geqFloorWithNonStrictMinimumClosesGap(
        uint64 depositAmount,
        uint64 anchorAmount,
        uint64 txMaxFee,
        uint64 minAmount
    ) public pure {
        _assumeParams(txMaxFee, minAmount);
        vm.assume(depositAmount >= minAmount + 2 * txMaxFee);
        vm.assume(
            anchorAdmitted(depositAmount, anchorAmount, txMaxFee, minAmount)
        );

        assert(reanchorFloorOkGeq(anchorAmount, txMaxFee, minAmount));
    }

    // --- vacuity witnesses: the fix checks above are not vacuous ------------

    /// expected counterexample (a witness, not a defect): the assumptions of
    /// the strict Fix B check are satisfiable, so that check is not vacuous.
    function check_SP85_witness_fixBStrictAssumptionsSatisfiable_expectedCounterexample(
        uint64 depositAmount,
        uint64 anchorAmount,
        uint64 txMaxFee,
        uint64 minAmount
    ) public pure {
        _assumeParams(txMaxFee, minAmount);
        vm.assume(depositAmount > minAmount + 2 * txMaxFee);
        vm.assume(
            anchorAdmitted(depositAmount, anchorAmount, txMaxFee, minAmount)
        );

        assert(false);
    }

    /// expected counterexample (a witness, not a defect): the assumptions of
    /// the combined Fix A plus non-strict Fix B check are satisfiable.
    function check_SP85_witness_fixABAssumptionsSatisfiable_expectedCounterexample(
        uint64 depositAmount,
        uint64 anchorAmount,
        uint64 txMaxFee,
        uint64 minAmount
    ) public pure {
        _assumeParams(txMaxFee, minAmount);
        vm.assume(depositAmount >= minAmount + 2 * txMaxFee);
        vm.assume(
            anchorAdmitted(depositAmount, anchorAmount, txMaxFee, minAmount)
        );

        assert(false);
    }
}
