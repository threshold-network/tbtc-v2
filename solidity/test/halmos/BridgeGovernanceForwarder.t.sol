// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

// Halmos 0.3.3 symbolic checks for the two new BridgeGovernance lines added by
// tbtc-v2 PR #1179 (diff d1bf5bc281..f176768f):
//
//   1. `BridgeGovernance.requestReservationReanchor(uint256,bytes20)` -- an
//      onlyOwner forwarder that relays a governance-approved rotation of a
//      reservation's anchor off a Live source wallet to the Bridge.
//   2. `BridgeGovernance.pendingReservationCapsUpdate()` -- a view that
//      returns the five staged reservation-caps values plus the initiation
//      timestamp.
//
// Source under check (solidity/contracts/bridge/BridgeGovernance.sol) at
// f176768f (the PR #1179 head):
//   :1973-1984  requestReservationReanchor(uint256,bytes20) external onlyOwner
//                forwarding to IReservationBridge(address(bridge))
//                  .requestReservationReanchor(key, hash, new uint32[](0), 0)
//   :1999-2018  pendingReservationCapsUpdate() external view returning
//                reservationCapsData.{newMaxReservationsAmountPerWallet,
//                newReservationMaxSingleAmount, newMaxActiveReservations,
//                newMaxThirdPartyReanchorHoldsPerWallet, newHandoffReserveWallets,
//                reservationCapsChangeInitiated}
//
// The checks call the REAL BridgeGovernance code. The Bridge is replaced by
// `ReservationBridgeStub`, a minimal contract that records the forwarded call
// and can be told to revert, so the symbolic run does not need the whole
// Bridge state machine. The library `BridgeGovernanceParameters` is the real
// one, so `beginReservationCapsUpdate` and `finalizeReservationCapsUpdate`
// write the same storage slots the getter reads.
//
// Halmos limitations that shape these checks:
//  - `vm.prank` is supported (halmos 0.3.3, cheatcodes.py:943-953) and applies
//    to the next call only, so the owner check can be driven with a symbolic
//    caller address.
//  - Solidity's `Ownable._checkOwner` (OpenZeppelin 4.8.1) compares
//    `owner()` to `msg.sender`, so a symbolic non-owner caller is enough to
//    drive the reverting branch; the owner branch uses the deployer address.
//  - The staged caps values are written by the real `beginReservationCapsUpdate`
//    from symbolic values that are pairwise distinct, so a swap between two
//    of them, or a zeroed field, is observable.
//
// Every check below passes unless its name ends in `_expectedCounterexample`.

import {Test} from "forge-std/Test.sol";
import {Bridge} from "../../contracts/bridge/Bridge.sol";
import {BridgeGovernance} from "../../contracts/bridge/BridgeGovernance.sol";
import {BridgeGovernanceParameters} from "../../contracts/bridge/BridgeGovernanceParameters.sol";

/// @dev Minimal stand-in for the Bridge's reservation surface. It records the
///      single forwarded call so a check can assert what the forwarder sent,
///      and can be told to revert.
contract ReservationBridgeStub {
    uint256 public calls;
    uint256 public lastReservationKey;
    bytes20 public lastTargetWalletPubKeyHash;
    uint256 public lastMemberProofLength;
    uint256 public lastWalletMemberIndex;

    bool public shouldRevert;

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function requestReservationReanchor(
        uint256 reservationKey,
        bytes20 targetWalletPubKeyHash,
        uint32[] calldata walletMembersIDs,
        uint256 walletMemberIndex
    ) external {
        require(!shouldRevert, "stub: reverting on purpose");
        calls += 1;
        lastReservationKey = reservationKey;
        lastTargetWalletPubKeyHash = targetWalletPubKeyHash;
        lastMemberProofLength = walletMembersIDs.length;
        lastWalletMemberIndex = walletMemberIndex;
    }

    // Called by `BridgeGovernance.finalizeReservationCapsUpdate`; the real
    // Bridge enforces the relational caps check here, which is not what
    // these checks are about.
    function updateReservationCaps(
        uint64,
        uint64,
        uint32,
        uint32,
        uint32
    ) external {}
}

contract BridgeGovernanceForwarderHalmos is Test {
    ReservationBridgeStub internal stub;
    BridgeGovernance internal governance;

    address internal owner = address(this);

    BridgeGovernanceParameters.ReservationCapsData internal anchorCaps;

    function setUp() public {
        stub = new ReservationBridgeStub();
        governance = new BridgeGovernance(Bridge(address(stub)), 48 hours);
    }

    /// @dev Forces this contract to carry a link reference to the
    ///      `BridgeGovernanceParameters` library, so that Halmos resolves
    ///      and deploys that library before the test contract's code runs
    ///      (halmos resolves library placeholders only in the test
    ///      contract's own creation bytecode, __main__.py:296-300). The
    ///      placeholder is the same string in the nested
    ///      `BridgeGovernance` creation bytecode, so the library address is
    ///      substituted there too and the library delegatecalls work.
    function libraryLinkAnchor() external {
        BridgeGovernanceParameters.beginReservationCapsUpdate(
            anchorCaps,
            1,
            1,
            1,
            1,
            1
        );
    }

    // ---------------------------------------------------------------------
    // Property 1: access control of the forwarder.
    // ---------------------------------------------------------------------

    /// The forwarder is onlyOwner: a caller that is not the owner must be
    /// refused and must not reach the Bridge.
    /// Expected result: pass.
    function check_forwarder_rejectsNonOwner(address caller) public {
        vm.assume(caller != owner);
        vm.assume(caller != address(0));

        vm.prank(caller);
        (bool ok, bytes memory ret) = address(governance).call(
            abi.encodeWithSignature(
                "requestReservationReanchor(uint256,bytes20)",
                uint256(1),
                bytes20(0x1111111111111111111111111111111111111111)
            )
        );

        assertFalse(ok, "non-owner must be refused");
        assertEq(
            ret,
            abi.encodeWithSignature(
                "Error(string)",
                "Ownable: caller is not the owner"
            ),
            "wrong revert reason"
        );
        assertEq(stub.calls(), 0, "the Bridge must not be reached");
    }

    /// The owner may call the forwarder, and the call reaches the Bridge with
    /// exactly the arguments the owner supplied.
    /// Expected result: pass.
    function check_forwarder_ownerCallReachesBridge(
        uint256 reservationKey,
        bytes20 targetWalletPubKeyHash
    ) public {
        vm.assume(reservationKey != 0);
        vm.assume(targetWalletPubKeyHash != bytes20(0));

        governance.requestReservationReanchor(
            reservationKey,
            targetWalletPubKeyHash
        );

        assertEq(stub.calls(), 1, "the Bridge must be reached exactly once");
        assertEq(
            stub.lastReservationKey(),
            reservationKey,
            "reservation key must be forwarded unchanged"
        );
        assertEq(
            uint256(uint160(stub.lastTargetWalletPubKeyHash())),
            uint256(uint160(targetWalletPubKeyHash)),
            "target wallet hash must be forwarded unchanged"
        );
    }

    /// The forwarder must carry an empty member proof and member index 0:
    /// the governance path takes no signing-group member proof, and a
    /// non-empty proof would make `Reservation.requestReservationReanchor`
    /// run the source-wallet member check.
    /// Expected result: pass.
    function check_forwarder_carriesNoMemberProof(
        uint256 reservationKey,
        bytes20 targetWalletPubKeyHash
    ) public {
        governance.requestReservationReanchor(
            reservationKey,
            targetWalletPubKeyHash
        );

        assertEq(
            stub.lastMemberProofLength(),
            0,
            "the member proof must be empty"
        );
        assertEq(stub.lastWalletMemberIndex(), 0, "the member index must be 0");
    }

    /// A revert from the Bridge must propagate: the forwarder must not swallow
    /// it (no try/catch, no ignored return value).
    /// Expected result: pass.
    function check_forwarder_propagatesBridgeRevert(
        uint256 reservationKey,
        bytes20 targetWalletPubKeyHash
    ) public {
        stub.setShouldRevert(true);

        vm.prank(owner);
        (bool ok, ) = address(governance).call(
            abi.encodeWithSignature(
                "requestReservationReanchor(uint256,bytes20)",
                reservationKey,
                targetWalletPubKeyHash
            )
        );

        assertFalse(ok, "the Bridge revert must propagate");
        assertEq(stub.calls(), 0, "the stub must not record a call");
    }

    // ---------------------------------------------------------------------
    // Property 2: the getter returns the staged values.
    // ---------------------------------------------------------------------

    /// Nothing staged: the getter returns all zeros, including the
    /// timestamp.
    /// Expected result: pass.
    function check_getter_emptySlotReturnsZeros() public {
        (
            uint256 perWallet,
            uint256 singleAmount,
            uint256 maxActive,
            uint256 thirdPartyHolds,
            uint256 handoffReserve,
            uint256 initiated
        ) = governance.pendingReservationCapsUpdate();

        assertEq(uint256(perWallet), 0, "per-wallet amount must be 0");
        assertEq(uint256(singleAmount), 0, "single amount must be 0");
        assertEq(uint256(maxActive), 0, "max active must be 0");
        assertEq(uint256(thirdPartyHolds), 0, "third-party holds must be 0");
        assertEq(uint256(handoffReserve), 0, "hand-off reserve must be 0");
        assertEq(initiated, 0, "initiation timestamp must be 0");
    }

    /// After `beginReservationCapsUpdate`, the getter returns each staged
    /// value in its own slot: the five values in the begin's argument order,
    /// then the initiation timestamp. The values are pairwise distinct, so a
    /// permutation of the tuple is observable.
    /// Expected result: pass.
    function check_getter_returnsStagedTuple(
        uint64 newMaxReservationsAmountPerWallet,
        uint64 newReservationMaxSingleAmount,
        uint32 newMaxActiveReservations,
        uint32 newMaxThirdPartyReanchorHoldsPerWallet,
        uint32 newHandoffReserveWallets
    ) public {
        vm.assume(newMaxReservationsAmountPerWallet != 0);
        vm.assume(newReservationMaxSingleAmount != 0);
        vm.assume(newMaxActiveReservations != 0);
        vm.assume(newMaxThirdPartyReanchorHoldsPerWallet != 0);
        vm.assume(newHandoffReserveWallets != 0);
        // Pairwise distinct, so a permutation of the tuple is observable.
        vm.assume(
            uint256(newMaxReservationsAmountPerWallet) !=
                uint256(newReservationMaxSingleAmount)
        );
        vm.assume(
            uint256(newReservationMaxSingleAmount) !=
                uint256(newMaxActiveReservations)
        );
        vm.assume(
            uint256(newMaxActiveReservations) !=
                uint256(newMaxThirdPartyReanchorHoldsPerWallet)
        );
        vm.assume(
            uint256(newMaxThirdPartyReanchorHoldsPerWallet) !=
                uint256(newHandoffReserveWallets)
        );
        vm.assume(
            uint256(newHandoffReserveWallets) !=
                uint256(newMaxReservationsAmountPerWallet)
        );

        governance.beginReservationCapsUpdate(
            newMaxReservationsAmountPerWallet,
            newReservationMaxSingleAmount,
            newMaxActiveReservations,
            newMaxThirdPartyReanchorHoldsPerWallet,
            newHandoffReserveWallets
        );

        (
            uint256 perWallet,
            uint256 singleAmount,
            uint256 maxActive,
            uint256 thirdPartyHolds,
            uint256 handoffReserve,
            uint256 initiated
        ) = governance.pendingReservationCapsUpdate();

        assertEq(
            uint256(perWallet),
            uint256(newMaxReservationsAmountPerWallet),
            "per-wallet amount"
        );
        assertEq(
            uint256(singleAmount),
            uint256(newReservationMaxSingleAmount),
            "single amount"
        );
        assertEq(
            uint256(maxActive),
            uint256(newMaxActiveReservations),
            "max active"
        );
        assertEq(
            uint256(thirdPartyHolds),
            uint256(newMaxThirdPartyReanchorHoldsPerWallet),
            "third-party holds"
        );
        assertEq(
            uint256(handoffReserve),
            uint256(newHandoffReserveWallets),
            "hand-off reserve"
        );
        assertEq(initiated, block.timestamp, "initiation timestamp");
    }

    /// The getter reports the timestamp of the LAST begin, not the first:
    /// `beginReservationCapsUpdate` overwrites the single staged slot in
    /// place.
    /// Expected result: pass.
    function check_getter_reportsLatestBegin(
        uint32 firstMaxActive,
        uint32 secondMaxActive
    ) public {
        vm.assume(firstMaxActive != 0);
        vm.assume(secondMaxActive != 0);
        vm.assume(firstMaxActive != secondMaxActive);

        governance.beginReservationCapsUpdate(
            1_000_000,
            100_000,
            firstMaxActive,
            1,
            1
        );

        vm.warp(block.timestamp + 1);
        governance.beginReservationCapsUpdate(
            1_000_000,
            100_000,
            secondMaxActive,
            1,
            1
        );

        (, , uint256 maxActive, , , uint256 initiated) = governance
            .pendingReservationCapsUpdate();

        assertEq(
            uint256(maxActive),
            uint256(secondMaxActive),
            "the last begin wins"
        );
        assertEq(initiated, block.timestamp, "the last begin's timestamp");
    }

    /// After `finalizeReservationCapsUpdate` the slot is cleared and the
    /// getter returns zeros again, timestamp included.
    /// Expected result: pass.
    function check_getter_clearedAfterFinalize() public {
        governance.beginReservationCapsUpdate(2_000_000, 1_200_000, 150, 1, 1);

        vm.warp(block.timestamp + 48 hours);
        governance.finalizeReservationCapsUpdate();

        (
            uint256 perWallet,
            uint256 singleAmount,
            uint256 maxActive,
            uint256 thirdPartyHolds,
            uint256 handoffReserve,
            uint256 initiated
        ) = governance.pendingReservationCapsUpdate();

        assertEq(uint256(perWallet), 0, "per-wallet amount must be cleared");
        assertEq(uint256(singleAmount), 0, "single amount must be cleared");
        assertEq(uint256(maxActive), 0, "max active must be cleared");
        assertEq(
            uint256(thirdPartyHolds),
            0,
            "third-party holds must be cleared"
        );
        assertEq(
            uint256(handoffReserve),
            0,
            "hand-off reserve must be cleared"
        );
        assertEq(initiated, 0, "the timestamp must be cleared");
    }

    /// The getter is a view: it does not change state, so it can be called by
    /// any address, including one that is not the owner.
    /// Expected result: pass.
    function check_getter_isCallableByAnyone(address caller) public {
        vm.assume(caller != address(0));

        governance.beginReservationCapsUpdate(2_000_000, 1_200_000, 150, 1, 1);

        vm.prank(caller);
        (
            uint256 perWallet,
            uint256 singleAmount,
            uint256 maxActive,
            uint256 thirdPartyHolds,
            uint256 handoffReserve,
            uint256 initiated
        ) = governance.pendingReservationCapsUpdate();

        assertEq(uint256(perWallet), 2_000_000, "per-wallet amount");
        assertEq(uint256(singleAmount), 1_200_000, "single amount");
        assertEq(uint256(maxActive), 150, "max active");
        assertEq(uint256(thirdPartyHolds), 1, "third-party holds");
        assertEq(uint256(handoffReserve), 1, "hand-off reserve");
        assertEq(initiated, block.timestamp, "initiation timestamp");
    }
}
