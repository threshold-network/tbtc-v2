// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {Reservation} from "../../contracts/bridge/Reservation.sol";
import {ReservationRouter} from "../../contracts/bridge/ReservationRouter.sol";
import {WalletProposalValidator} from "../../contracts/bridge/WalletProposalValidator.sol";

import {ReservationSurfaceHandler} from "./ReservationSurfaceHandler.sol";
import {ReservationStackHarness} from "./ReservationStackHarness.sol";
import {SurfaceCaller} from "./ReservationSurfaceHandler.sol";

/// @notice Tests for the reservation surface campaign: the vault, the router
///         and the validator. The deterministic cases double as positive
///         controls for the campaign properties. A property that never fails
///         is indistinguishable from one that cannot fail, so every property
///         here has a case that exercises both outcomes.
contract ReservationSurfaceTest is Test {
    uint256 internal constant SATOSHI_MULTIPLIER = 1e10;
    uint256 internal constant INITIATION_FEE_BPS = 40;

    ReservationSurfaceHandler internal handler;
    ReservationStackHarness internal stack;

    function setUp() public {
        handler = new ReservationSurfaceHandler();
        stack = handler.stack();
    }

    // ---------------------------------------------------------------------
    // Reach: the reveal and acceptance authorization
    // ---------------------------------------------------------------------

    function test_revealOpensAPendingAcceptanceGeneration() public {
        handler.surfaceReveal(0, 2_000_001, 1);
        assertEq(handler.stackKeyCount(), 1, "reveal did not record a key");

        uint256 key = handler.stackKeyAt(0);
        assertEq(stack.deposits(key).depositor, address(handler));
        assertTrue(stack.isReservedDepositProbe(key));

        handler.surfaceRequestAcceptance(0);
        Reservation.ReservationAction memory action = stack
            .reservationActionRecord(key, 1);
        assertEq(
            uint8(action.actionType),
            uint8(Reservation.ActionType.Acceptance)
        );
        assertEq(uint8(action.state), uint8(Reservation.ActionState.Pending));
    }

    // ---------------------------------------------------------------------
    // Property P8 / INV-209, INV-701, INV-704: the vault credit
    // ---------------------------------------------------------------------

    function test_vaultCreditRetainsExactlyTheInitiationFee() public {
        address depositor = address(0xA11CE);
        uint64 amount = 1_000_000;
        uint256 grossTbtc = uint256(amount) * SATOSHI_MULTIPLIER;
        uint256 feeTbtc = (grossTbtc * INITIATION_FEE_BPS) / 10_000;

        stack.creditVault(depositor, amount);

        assertEq(
            stack.tbtcToken().balanceOf(depositor),
            grossTbtc - feeTbtc,
            "depositor did not receive gross minus the initiation fee"
        );
        assertEq(
            stack.tbtcToken().balanceOf(address(stack.reservationVault())),
            feeTbtc,
            "the vault did not retain the initiation fee"
        );
        assertEq(
            stack.tbtcToken().totalSupply(),
            grossTbtc,
            "the credit did not mint the gross anchor amount"
        );
        assertEq(stack.bank().balanceOf(address(stack.reservationVault())), 0);
    }

    // ---------------------------------------------------------------------
    // Property P9 / INV-207, INV-705: the in-kind fee debt
    // ---------------------------------------------------------------------

    function test_inKindFeeBurnsTheReserveAndRecordsTheShortfall() public {
        uint64 amount = 1_000_000;
        stack.creditVault(address(0xA11CE), amount);
        uint256 reserveTbtc = stack.tbtcToken().balanceOf(
            address(stack.reservationVault())
        );
        assertEq(reserveTbtc, 4e13);

        // The reserve covers 4_000 satoshi of the 10_000 asked for.
        uint64 feeSat = 10_000;
        stack.fundVaultBank(feeSat);
        stack.financeInKindFee(feeSat);

        assertEq(
            stack.tbtcToken().balanceOf(address(stack.reservationVault())),
            0,
            "the whole reserve should have been burned"
        );
        assertEq(
            stack.reservationVault().inKindFeeDebtSat(),
            feeSat - uint64(reserveTbtc / SATOSHI_MULTIPLIER),
            "the uncovered fee should be recorded as debt"
        );
    }

    function test_repayInKindFeeDebtClearsTheRecordedDebt() public {
        stack.creditVault(address(0xA11CE), 1_000_000);
        stack.fundVaultBank(10_000);
        stack.financeInKindFee(10_000);
        uint64 debt = stack.reservationVault().inKindFeeDebtSat();
        assertEq(debt, 6_000);

        // Anyone may repay; the harness pays with TBTC it earned as a
        // depositor.
        stack.creditVault(address(stack), 1_000_000);
        stack.fundVaultBank(debt);
        stack.repayInKindFeeDebt(debt);

        assertEq(stack.reservationVault().inKindFeeDebtSat(), 0);
    }

    // ---------------------------------------------------------------------
    // Property P24 / INV-401, SM-A5: the validator's admission rules
    // ---------------------------------------------------------------------

    function _pendingAnchorProposal(
        uint256 key,
        bytes20 walletPubKeyHash,
        uint256 anchorTxFee
    )
        internal
        view
        returns (WalletProposalValidator.ReservationAnchorProposal memory)
    {
        return
            WalletProposalValidator.ReservationAnchorProposal({
                walletPubKeyHash: walletPubKeyHash,
                depositKey: WalletProposalValidator.DepositKey({
                    fundingTxHash: stack.fundingTxHash(key),
                    fundingOutputIndex: 0
                }),
                requestNonce: stack.reservationRecord(key).requestNonce,
                anchorTxFee: anchorTxFee
            });
    }

    function _depositExtraInfo(
        uint256 key
    )
        internal
        view
        returns (WalletProposalValidator.DepositExtraInfo memory e)
    {
        (
            e.fundingTx,
            e.blindingFactor,
            e.walletPubKeyHash,
            e.refundPubKeyHash,
            e.refundLocktime
        ) = stack.depositFixture(key);
    }

    function _revealedAndRequested() internal returns (uint256 key) {
        handler.surfaceReveal(0, 2_000_001, 1);
        handler.surfaceRequestAcceptance(0);
        key = handler.stackKeyAt(0);
        // The validator requires the deposit to be older than
        // `DEPOSIT_MIN_AGE`.
        vm.warp(block.timestamp + 2 hours + 1);
    }

    function test_validatorAcceptsAWellFormedProposal() public {
        uint256 key = _revealedAndRequested();
        bytes20 wallet = handler.stackWalletOf(key);
        WalletProposalValidator validator = stack.validator();

        assertTrue(
            validator.validateReservationAnchorProposal(
                _pendingAnchorProposal(key, wallet, 1_000),
                _depositExtraInfo(key)
            ),
            "a well formed anchor proposal must be accepted"
        );
    }

    function _expectAnchorRejected(
        uint256 key,
        uint64 nonce,
        bytes20 wallet,
        uint256 fee,
        string memory reason
    ) internal {
        WalletProposalValidator.ReservationAnchorProposal
            memory proposal = _pendingAnchorProposal(key, wallet, fee);
        proposal.requestNonce = nonce;
        WalletProposalValidator.DepositExtraInfo
            memory extraInfo = _depositExtraInfo(key);
        WalletProposalValidator validator = stack.validator();

        vm.expectRevert(abi.encodeWithSignature("Error(string)", reason));
        validator.validateReservationAnchorProposal(proposal, extraInfo);
    }

    function test_validatorRejectsAProposalAboveTheSnapshottedMaxFee() public {
        uint256 key = _revealedAndRequested();
        bytes20 wallet = handler.stackWalletOf(key);
        uint64 nonce = stack.reservationRecord(key).requestNonce;
        uint64 txMaxFee = stack.reservationActionRecord(key, nonce).txMaxFee;

        _expectAnchorRejected(
            key,
            nonce,
            wallet,
            uint256(txMaxFee) + 1,
            "Proposed transaction fee is too high"
        );
    }

    function test_validatorRejectsAZeroFeeProposal() public {
        uint256 key = _revealedAndRequested();
        bytes20 wallet = handler.stackWalletOf(key);

        _expectAnchorRejected(
            key,
            stack.reservationRecord(key).requestNonce,
            wallet,
            0,
            "Proposed transaction fee cannot be zero"
        );
    }

    function test_validatorRejectsAForeignWalletProposal() public {
        uint256 key = _revealedAndRequested();

        _expectAnchorRejected(
            key,
            stack.reservationRecord(key).requestNonce,
            bytes20(uint160(0xDEADBEEF)),
            1_000,
            "Wallet is not in Live or MovingFunds state"
        );
    }

    function test_validatorRejectsAProposalWithNoBackingAction() public {
        uint256 key = _revealedAndRequested();
        bytes20 wallet = handler.stackWalletOf(key);

        _expectAnchorRejected(
            key,
            2, // no such generation
            wallet,
            1_000,
            "Not a pending acceptance action"
        );
    }

    // ---------------------------------------------------------------------
    // Property P24 / INV-401: the router's role matrix
    // ---------------------------------------------------------------------

    function test_nonGovernanceCannotUpdateReservationParameters() public {
        bytes memory data = abi.encodeWithSelector(
            ReservationRouter.updateReservationParameters.selector,
            address(0xBAD0),
            uint64(100_000),
            uint64(10_000),
            uint32(90 days),
            uint32(7 days),
            uint64(5_000_000),
            uint32(2),
            uint32(6 hours),
            uint32(7 days)
        );

        bool ok = handler.nonGovernanceCaller().call(address(stack), data);
        assertFalse(ok, "a non-governance caller reached the mutator");
        assertTrue(
            stack.reservationVaultAddress() != address(0xBAD0),
            "a non-governance caller re-pointed the reservation vault"
        );
    }

    function test_nonGovernanceCannotForceAStaleDeposit() public {
        handler.surfaceReveal(0, 2_000_001, 1);
        uint256 key = handler.stackKeyAt(0);

        bool ok = handler.nonGovernanceCaller().call(
            address(stack),
            abi.encodeWithSelector(
                ReservationRouter.forceStaleReservedDeposit.selector,
                key
            )
        );
        assertFalse(ok, "a non-governance caller forced a stale deposit");
        assertTrue(stack.isReservedDepositProbe(key));
    }

    function test_governanceCanUpdateCapsThroughTheRouter() public {
        stack.callRouterStrict(
            abi.encodeWithSelector(
                ReservationRouter.updateReservationCaps.selector,
                uint64(3_000_000),
                uint64(2_000_000),
                uint32(4),
                uint32(1),
                uint32(1)
            )
        );
        (uint64 perWallet, uint64 single, , ) = stack.reservationCapsProbe();
        assertEq(perWallet, 3_000_000);
        assertEq(single, 2_000_000);
    }

    // ---------------------------------------------------------------------
    // Property P7 / INV-109: the vault cannot be re-pointed under load
    // ---------------------------------------------------------------------

    function test_vaultIsNotRepointedWhileADepositIsPending() public {
        handler.surfaceReveal(0, 2_000_001, 1);
        assertGt(stack.pendingReservedDepositsProbe(), 0);
        address vaultBefore = stack.reservationVaultAddress();

        bool ok = stack.callRouter(
            abi.encodeWithSelector(
                ReservationRouter.updateReservationParameters.selector,
                address(0xBAD0),
                uint64(100_000),
                uint64(10_000),
                uint32(90 days),
                uint32(7 days),
                uint64(5_000_000),
                uint32(2),
                uint32(6 hours),
                uint32(7 days)
            )
        );
        assertFalse(ok, "the vault was re-pointed with a deposit pending");
        assertEq(stack.reservationVaultAddress(), vaultBefore);
    }

    // ---------------------------------------------------------------------
    // Property P22 / INV-601, INV-602: the timeout notifications
    // ---------------------------------------------------------------------

    function test_timeoutNotificationIsRefusedBeforeTheDeadline() public {
        uint256 key = _revealedAndRequested();
        Reservation.ReservationAction memory action = stack
            .reservationActionRecord(
                key,
                stack.reservationRecord(key).requestNonce
            );
        assertLt(block.timestamp, action.timeoutAt);

        bool ok = stack.callRouter(
            abi.encodeWithSelector(
                ReservationRouter.notifyReservationAcceptanceTimedOut.selector,
                key
            )
        );
        assertFalse(ok, "a timeout was accepted before its deadline");
    }

    function test_timeoutNotificationSucceedsAfterTheDeadline() public {
        uint256 key = _revealedAndRequested();
        Reservation.ReservationAction memory action = stack
            .reservationActionRecord(
                key,
                stack.reservationRecord(key).requestNonce
            );
        vm.warp(action.timeoutAt);

        assertTrue(
            stack.callRouter(
                abi.encodeWithSelector(
                    ReservationRouter
                        .notifyReservationAcceptanceTimedOut
                        .selector,
                    key
                )
            ),
            "a timeout was refused after its deadline"
        );
    }

    // ---------------------------------------------------------------------
    // Property P24 / INV-401: the router's views read the right slots
    // ---------------------------------------------------------------------

    function test_routerViewsAgreeWithStorage() public {
        (bool ok, bytes memory data) = address(stack).staticcall(
            abi.encodeWithSelector(ReservationRouter.reservationCaps.selector)
        );
        assertTrue(ok);
        (
            uint64 perWallet,
            uint64 single,
            uint32 maxActive,
            uint32 maxHolds
        ) = abi.decode(data, (uint64, uint64, uint32, uint32));
        (
            uint64 probePerWallet,
            uint64 probeSingle,
            uint32 probeActive,
            uint32 probeHolds
        ) = stack.reservationCapsProbe();
        assertEq(perWallet, probePerWallet);
        assertEq(single, probeSingle);
        assertEq(maxActive, probeActive);
        assertEq(maxHolds, probeHolds);
    }
}

/// @notice Stateful invariant run over the surface handler. Medusa runs the
///         same handler with the same actions; this is the Foundry mirror.
contract ReservationSurfaceInvariantsTest is StdInvariant, Test {
    ReservationSurfaceHandler internal handler;

    function setUp() public {
        handler = new ReservationSurfaceHandler();

        bytes4[] memory selectors = new bytes4[](18);
        selectors[0] = handler.surfaceReveal.selector;
        selectors[1] = handler.surfaceRequestAcceptance.selector;
        selectors[2] = handler.surfaceProveAcceptance.selector;
        selectors[3] = handler.surfaceRequestReanchor.selector;
        selectors[4] = handler.surfaceProveReanchor.selector;
        selectors[5] = handler.surfaceValidateAnchor.selector;
        selectors[6] = handler.surfaceValidateReanchor.selector;
        selectors[7] = handler.surfaceValidateUnbackedAnchor.selector;
        selectors[8] = handler.surfaceCredit.selector;
        selectors[9] = handler.surfaceFinanceInKindFee.selector;
        selectors[10] = handler.surfaceRepay.selector;
        selectors[11] = handler.surfaceSweepFees.selector;
        selectors[12] = handler.surfaceUpdateInitiationFee.selector;
        selectors[13] = handler.surfaceUpdateFeeReserveTarget.selector;
        selectors[14] = handler.routerUpdateParameters.selector;
        selectors[15] = handler.routerNonGovernanceUpdate.selector;
        selectors[16] = handler.surfaceNotifyTimeout.selector;
        selectors[17] = handler.surfaceAdvanceWallet.selector;
        targetSelector(
            StdInvariant.FuzzSelector({
                addr: address(handler),
                selectors: selectors
            })
        );
        targetContract(address(handler));
    }

    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 60
    function invariant_reservationSurface() public {
        // P8 / INV-209, INV-701, INV-704
        assertTrue(
            handler.property_vaultTbtcBalanceMatchesFeesBurnedAndSwept(),
            "vault TBTC balance drifted from the fee accounting"
        );
        assertTrue(
            handler.property_depositorReceivesGrossMinusInitiationFee(),
            "a depositor balance drifted from gross minus the fee"
        );
        // P9 / INV-207, INV-705
        assertTrue(
            handler.property_inKindFeeDebtMatchesFinancing(),
            "in-kind fee debt drifted from the financing record"
        );
        // P11 / INV-212
        assertTrue(
            handler.property_supplyStaysInLockstepWithRoutedSatoshi(),
            "TBTC supply drifted from the routed satoshi"
        );
        // P7 / INV-109
        assertTrue(
            handler.property_vaultIsNeverRepointedWhileDepositsArePending(),
            "the vault was re-pointed with a deposit pending"
        );
        // P22 / INV-601, INV-602
        assertTrue(
            handler.property_timeoutsAreRefusedBeforeTheDeadline(),
            "a timeout was accepted before its deadline"
        );
        assertTrue(
            handler.property_reanchorTimeoutSetsCooldown(),
            "a timed out re-anchor left no cooldown"
        );
        // P24 / INV-401
        assertTrue(
            handler.property_onlyGovernanceChangesRouterParameters(),
            "a non-governance caller changed the reservation parameters"
        );
        assertTrue(
            handler.property_routerViewsAgreeWithStorage(),
            "the router's views disagree with the storage they read"
        );
        assertTrue(
            handler.property_validatorRejectsUnbackedProposals(),
            "the validator accepted a proposal no action backs"
        );
        assertTrue(
            handler.property_validatorRejectsOutOfBoundProposals(),
            "the validator accepted an out-of-bound proposal"
        );
    }
}
