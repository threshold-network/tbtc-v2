// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import {Reservation} from "../../contracts/bridge/Reservation.sol";

import {ReservationInvariantHarness} from "./ReservationInvariantHarness.sol";

/// @notice Reservation accounting properties. Each property recomputes the
///         expected value from the position and action records and compares
///         it with the counter the library maintains. Medusa runs every
///         `property_*` function; the Foundry invariant test wraps them.
abstract contract ReservationProperties {
    struct TerminalRecord {
        uint256 reservationKey;
        uint64 requestNonce;
        Reservation.ActionState state;
    }

    ReservationInvariantHarness public harness;

    bytes20[] internal wallets;
    uint256[] internal keys;

    TerminalRecord[] internal terminals;
    mapping(bytes32 => bool) internal recordedTerminal;

    // Set when a successful request leaves a counter above its cap.
    bool public capViolation;

    // Set when a successful acceptance request leaves more open positions
    // than the hand-off reserve gate allows:
    // active <= (Live wallets - reserve) * per-wallet count cap.
    bool public reserveGateViolation;

    uint256 public ghostCreditedSat;
    uint256 public ghostMinerFeeSat;

    struct Expected {
        uint256 active;
        uint256 total;
        uint256[] walletCount;
        uint256[] walletAmount;
        uint256[] walletHolds;
    }

    function keyCount() external view returns (uint256) {
        return keys.length;
    }

    function keyAt(uint256 index) external view returns (uint256) {
        return keys[index];
    }

    function walletAt(uint256 index) external view returns (bytes20) {
        return wallets[index];
    }

    /// @dev Open positions (Active, ActionPending) hold capacity on their
    ///      custodian. A pending acceptance holds capacity on its target and
    ///      counts globally. A pending re-anchor holds its target's
    ///      per-wallet capacity and, when requested by a third party, one
    ///      hold; it does not change the global counters until it settles.
    function expectedCounters() internal view returns (Expected memory e) {
        e.walletCount = new uint256[](wallets.length);
        e.walletAmount = new uint256[](wallets.length);
        e.walletHolds = new uint256[](wallets.length);

        for (uint256 i = 0; i < keys.length; i++) {
            Reservation.ReservationRequest memory r = harness.reservation(
                keys[i]
            );
            if (
                r.state == Reservation.ReservationState.Active ||
                r.state == Reservation.ReservationState.ActionPending
            ) {
                uint256 w = walletIndex(r.walletPubKeyHash);
                e.walletCount[w] += 1;
                e.walletAmount[w] += r.anchorAmount;
                e.active += 1;
                e.total += r.anchorAmount;
            }

            Reservation.ReservationAction memory a = harness.action(
                keys[i],
                r.requestNonce
            );
            if (a.state != Reservation.ActionState.Pending) {
                continue;
            }
            uint256 t = walletIndex(a.targetWalletPubKeyHash);
            e.walletCount[t] += 1;
            e.walletAmount[t] += a.amount;
            if (a.actionType == Reservation.ActionType.Acceptance) {
                e.active += 1;
                e.total += a.amount;
            } else if (a.thirdPartyHold) {
                e.walletHolds[t] += 1;
            }
        }
    }

    function walletIndex(
        bytes20 walletPubKeyHash
    ) internal view returns (uint256) {
        for (uint256 i = 0; i < wallets.length; i++) {
            if (wallets[i] == walletPubKeyHash) {
                return i;
            }
        }
        revert("Unknown wallet");
    }

    function property_activeCountMatchesOpenPositions() public returns (bool) {
        (uint32 active, , ) = harness.totals();
        return active == expectedCounters().active;
    }

    function property_totalAmountMatchesOpenPositions() public returns (bool) {
        (, uint64 total, ) = harness.totals();
        return total == expectedCounters().total;
    }

    function property_walletCountersMatchOpenPositions() public returns (bool) {
        Expected memory e = expectedCounters();
        for (uint256 i = 0; i < wallets.length; i++) {
            (uint32 count, uint64 amount) = harness.walletReservationInfo(
                wallets[i]
            );
            if (count != e.walletCount[i] || amount != e.walletAmount[i]) {
                return false;
            }
        }
        return true;
    }

    function property_thirdPartyHoldsMatchPendingRequests()
        public
        returns (bool)
    {
        Expected memory e = expectedCounters();
        for (uint256 i = 0; i < wallets.length; i++) {
            if (
                harness.pendingThirdPartyReanchorHolds(wallets[i]) !=
                e.walletHolds[i]
            ) {
                return false;
            }
        }
        return true;
    }

    function property_pendingReservedDepositsMatchMarkers()
        public
        returns (bool)
    {
        uint256 expected;
        for (uint256 i = 0; i < keys.length; i++) {
            if (harness.pendingReservedDepositWallet(keys[i]) != bytes20(0)) {
                expected += 1;
            }
        }
        (, , uint64 pending) = harness.totals();
        return pending == expected;
    }

    /// @dev Every open position must be reachable from its current anchor
    ///      outpoint, which is how proofs and fraud defeats find it.
    function property_anchorIndexPointsAtOpenPositions() public returns (bool) {
        for (uint256 i = 0; i < keys.length; i++) {
            Reservation.ReservationRequest memory r = harness.reservation(
                keys[i]
            );
            if (
                r.state != Reservation.ReservationState.Active &&
                r.state != Reservation.ReservationState.ActionPending
            ) {
                continue;
            }
            if (
                harness.reservationByAnchorUtxo(
                    r.anchorTxHash,
                    r.anchorTxOutputIndex
                ) != keys[i]
            ) {
                return false;
            }
        }
        return true;
    }

    /// @dev Settled and Superseded generations never change again.
    function property_settledAndSupersededActionsAreFinal()
        public
        returns (bool)
    {
        for (uint256 i = 0; i < terminals.length; i++) {
            TerminalRecord memory t = terminals[i];
            if (
                harness.action(t.reservationKey, t.requestNonce).state !=
                t.state
            ) {
                return false;
            }
        }
        return true;
    }

    function property_capsHoldAfterEveryRequest() public view returns (bool) {
        return !capViolation;
    }

    /// @dev Checked right after each successful acceptance request, the
    ///      only step the gate guards. Governance may raise the reserve or
    ///      retire a wallet later, which legitimately leaves the count
    ///      above the bound until positions close.
    function property_reserveGateHoldsAfterEveryAcceptance()
        public
        view
        returns (bool)
    {
        return !reserveGateViolation;
    }

    /// @dev Each settled acceptance credits its anchor value once; each
    ///      re-anchor finances exactly its miner fee.
    function property_creditsMatchSettlements() public returns (bool) {
        return
            harness.bank().balanceOf(address(this)) == ghostCreditedSat &&
            harness.feeVault().financedSat() == ghostMinerFeeSat;
    }

    /// @dev Records every Settled or Superseded generation of the key so
    ///      later calls can check it never changes.
    function recordTerminals(uint256 reservationKey) internal {
        uint64 latest = harness.reservation(reservationKey).requestNonce;
        for (uint64 n = 1; n <= latest; n++) {
            bytes32 id = keccak256(abi.encodePacked(reservationKey, n));
            if (recordedTerminal[id]) {
                continue;
            }
            Reservation.ActionState s = harness.action(reservationKey, n).state;
            if (
                s == Reservation.ActionState.Settled ||
                s == Reservation.ActionState.Superseded
            ) {
                recordedTerminal[id] = true;
                terminals.push(TerminalRecord(reservationKey, n, s));
            }
        }
    }
}
