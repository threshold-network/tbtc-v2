// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import {BitcoinTx} from "../../contracts/bridge/BitcoinTx.sol";
import {Reservation} from "../../contracts/bridge/Reservation.sol";
import {ReservationRouter} from "../../contracts/bridge/ReservationRouter.sol";
import {WalletProposalValidator} from "../../contracts/bridge/WalletProposalValidator.sol";
import {WalletProposalValidatorConstants} from "../../contracts/bridge/WalletProposalValidatorConstants.sol";
import {Wallets} from "../../contracts/bridge/Wallets.sol";
import {Bank} from "../../contracts/bank/Bank.sol";
import {ReservationVault} from "../../contracts/vault/ReservationVault.sol";
import {TBTC} from "../../contracts/token/TBTC.sol";

import {ReservationHandler} from "./ReservationHandler.sol";
import {ReservationStackHarness} from "./ReservationStackHarness.sol";

/// @notice Forwards a call so that the target sees a sender that is not the
///         governance of the harness. Used to prove that the router's
///         governance-only mutators cannot be reached by anyone else.
contract SurfaceCaller {
    function call(address target, bytes memory data) external returns (bool) {
        (bool ok, ) = target.call(data);
        return ok;
    }
}

/// @notice Fuzz entry point for the reservation *surface* contracts: the
///         `ReservationVault`, the `ReservationRouter` and the
///         `WalletProposalValidator`. The accounting properties of the
///         parent campaign keep running against the accounting harness; the
///         actions and properties here add the contracts the accounting
///         campaign never calls.
/// @dev The router is reached the way production reaches it: the harness's
///      fallback `delegatecall`s the router, so the router's code runs on
///      the harness's `BridgeState.Storage`. The vault and the validator
///      are the production contracts. Only two writes are harness plumbing
///      and not production code paths: `revealReservedDeposit` writes the
///      reveal-time records, and `fundVaultBank` tops up the vault's Bank
///      balance so the burn path has a Bank side to decrease.
contract ReservationSurfaceHandler is ReservationHandler {
    uint256 internal constant SATOSHI_MULTIPLIER = 1e10;
    uint256 internal constant MAX_STACK_KEYS = 16;
    uint256 internal constant MAX_STACK_WALLETS = 6;

    ReservationStackHarness public stack;
    SurfaceCaller public nonGovernanceCaller;

    bytes20[] internal stackWallets;
    uint256[] internal stackKeys;
    /// @dev The designated wallet of each revealed stack deposit. The
    ///      position record only carries it once an acceptance settles, so
    ///      the request path needs the reveal-time value.
    mapping(uint256 => bytes20) internal stackKeyWallet;
    address[] internal stackDepositors;

    // Ghosts: the vault figures predicted independently of the vault's own
    // return values, so a mismatch is a real disagreement about arithmetic.
    uint256 public ghostVaultTbtc;
    uint256 public ghostFeeDebtSat;
    uint256 public ghostRoutedSat;
    /// @dev Predicted TBTC supply: minted on every credit, reduced by every
    ///      burn and repayment. Compared with `totalSupply` by a property.
    uint256 public ghostSupplyTbtc;
    mapping(address => uint256) public ghostDepositorTbtc;

    uint256 public ghostAnchorAccepted;
    uint256 public ghostAnchorRejected;
    uint256 public ghostReanchorAccepted;
    uint256 public ghostReanchorRejected;
    uint256 public ghostSweepAccepted;
    uint256 public ghostSweepRejected;
    /// @dev The sweep validator accepted a proposal over a deposit revealed
    ///      as reserved, which the reservation flow forbids.
    bool public reservedSweepAccepted;

    // Violation flags. A property that never fires is indistinguishable from
    // one that cannot fire, so each flag has a covered positive control in
    // the Foundry suite.
    bool public unbackedAnchorAccepted;
    bool public overFeeAnchorAccepted;
    bool public zeroFeeAnchorAccepted;
    bool public foreignWalletAnchorAccepted;
    bool public overFeeReanchorAccepted;
    bool public nonGovernanceParameterChange;
    bool public repointedVaultWhilePending;
    bool public earlyTimeoutSucceeded;
    bool public reanchorTimeoutWithoutCooldown;

    constructor() {
        stack = new ReservationStackHarness();
        nonGovernanceCaller = new SurfaceCaller();

        // The handler is the harness's governance, so it can reach the
        // router's governance-only mutators, and an SPV maintainer, so the
        // proof entry points pass their modifier.
        stack.setSpvMaintainer(address(this), true);

        stack.setupReservationCaps(30_000_000, 2_000_000, 4, 1, 1);
        stack.setupReservationParameters(
            address(stack.reservationVault()),
            100_000, // min amount
            10_000, // tx max fee
            90 days, // term
            7 days, // dissolution delay
            6_000_000, // max total amount
            2, // max reservations per wallet
            6 hours, // action timeout
            7 days // renewal window
        );

        for (uint256 i = 0; i < MAX_STACK_WALLETS; i++) {
            bytes20 wallet = bytes20(uint160(0x5000 + i));
            stack.registerLiveWallet(wallet);
            stackWallets.push(wallet);
        }

        stackDepositors.push(address(stack));
        stackDepositors.push(address(this));
        stackDepositors.push(address(0xA11CE));
        stackDepositors.push(address(0xB0B));
    }

    // ---------------------------------------------------------------------
    // Stack actions: reserved deposits and the position lifecycle
    // ---------------------------------------------------------------------

    /// @dev Reveals a reserved deposit in the stack. The depositor is the
    ///      handler, because `requestReservationAcceptance` is
    ///      depositor-gated on `msg.sender` and the library call preserves
    ///      the handler as the sender. The refund locktime is an absolute CLTV value, so it is
    ///      set well past the validator's 24-hour refund safety margin.
    function surfaceReveal(
        uint256 walletSeed,
        uint64 amountSeed,
        uint32 deadlineSeed
    ) external {
        if (stackKeys.length >= MAX_STACK_KEYS) {
            return;
        }
        // Stay under the single-reservation cap most of the time so the
        // acceptance path is reachable, but exceed it regularly so the cap
        // check stays exercised.
        (, uint64 maxSingle, , ) = stack.reservationCapsProbe();
        uint64 amount;
        if (maxSingle > 130_000 && amountSeed % 4 != 0) {
            amount = uint64(120_001 + (amountSeed % (maxSingle - 120_000)));
        } else {
            amount = uint64(120_001 + (amountSeed % 2_500_000));
        }
        // The refund locktime is an absolute CLTV value. It is set far out
        // so the deposit stays admissible while the fuzzer moves the clock
        // forward by up to a day per call.
        uint32 refundLocktime = uint32(
            block.timestamp + 200 days + (deadlineSeed % 100 days)
        );
        // `requestReservationAcceptance` requires the designated wallet to be
        // Live, so a deposit revealed to a retired wallet can never be
        // accepted. Prefer a Live wallet so the acceptance path stays
        // reachable while the fuzzer retires wallets.
        bytes20 wallet = stackWallets[walletSeed % stackWallets.length];
        if (stack.walletState(wallet) != Wallets.WalletState.Live) {
            for (uint256 i = 0; i < stackWallets.length; i++) {
                if (
                    stack.walletState(stackWallets[i]) ==
                    Wallets.WalletState.Live
                ) {
                    wallet = stackWallets[i];
                    break;
                }
            }
        }

        try
            stack.revealReservedDeposit(
                address(this),
                wallet,
                bytes8(uint64(walletSeed)), // blinding factor
                bytes20(uint160(0x50300D)),
                refundLocktime,
                amount,
                refundLocktime
            )
        returns (uint256 depositKey) {
            stackKeys.push(depositKey);
            stackKeyWallet[depositKey] = wallet;
            successes["surfaceReveal"] += 1;
        } catch {}
    }

    function surfaceRequestAcceptance(uint256 keySeed) external {
        if (stackKeys.length == 0) return;
        uint256 key = stackKeys[keySeed % stackKeys.length];
        bytes20 wallet = stackKeyWallet[key];
        if (wallet == bytes20(0)) return;
        try stack.requestReservationAcceptance(key, wallet) {
            successes["surfaceRequestAcceptance"] += 1;
        } catch {}
    }

    /// @dev Settles the pending acceptance. The settlement credits the gross
    ///      anchor through the reservation vault, which is the path that
    ///      mints and retains the initiation fee.
    /// @dev Drives the whole acceptance path, so the settlement and the vault
    ///      credit are reachable from any state: issue the authorization if
    ///      there is none, then settle it through the real vault credit.
    function surfaceProveAcceptance(
        uint256 keySeed,
        uint64 nonceSeed,
        uint64 feeSeed
    ) external {
        if (stackKeys.length == 0) return;
        uint256 key = stackKeys[keySeed % stackKeys.length];
        nonceSeed; // kept for call-sequence stability, the nonce is the live one
        _proveAcceptance(key, feeSeed);
    }

    /// @dev mode 0: privileged (governance) request, which is the only one
    ///      allowed off a Live source; 1: third party.
    /// @dev The third-party mode must change the caller, not only the
    ///      `privileged` argument. The stack deposits belong to this
    ///      handler and the handler is an approved SPV maintainer, so a
    ///      request from the handler is privileged under both exemptions
    ///      whatever the argument says, and the third-party hold cap is
    ///      never reached. The third-party mode therefore calls from
    ///      `THIRD_PARTY`, which is neither the reservation owner nor a
    ///      maintainer, exactly like the accounting campaign does.
    function surfaceRequestReanchor(
        uint256 keySeed,
        uint256 targetSeed,
        uint8 mode
    ) external {
        if (stackKeys.length == 0) return;
        uint256 key = stackKeys[keySeed % stackKeys.length];
        bytes20 target = stackWallets[targetSeed % stackWallets.length];
        mode = mode % 2;
        if (mode == 1) {
            vm.prank(THIRD_PARTY);
        }
        try stack.requestReservationReanchor(key, target, mode == 0) {
            successes["surfaceRequestReanchor"] += 1;
            if (mode == 1) {
                successes["surfaceRequestReanchorThirdParty"] += 1;
            }
        } catch {}
    }

    /// @dev Settles the pending re-anchor. The settlement finances the
    ///      miner fee by calling `financeInKindFee` on the real vault, so
    ///      this action is the one that drives the vault's burn or debt
    ///      path from production code.
    /// @dev Drives an open position and a pending re-anchor, then settles the
    ///      re-anchor through the real `financeInKindFee` on the vault.
    function surfaceProveReanchor(
        uint256 keySeed,
        uint64 nonceSeed,
        uint64 feeSeed
    ) external {
        if (stackKeys.length == 0) return;
        uint256 key = stackKeys[keySeed % stackKeys.length];
        nonceSeed;
        _proveReanchor(key, feeSeed);
    }

    /// @dev mode 0: the acceptance-timeout notification; 1: the re-anchor
    ///      action timeout. Both go through the router's own entry points, so
    ///      the router's code and the library's deadline checks both run.
    function surfaceNotifyTimeout(uint256 keySeed, uint8 mode) external {
        if (stackKeys.length == 0) return;
        uint256 key = stackKeys[keySeed % stackKeys.length];
        if (mode % 2 == 0) {
            if (
                stack.callRouter(
                    abi.encodeWithSelector(
                        ReservationRouter
                            .notifyReservationAcceptanceTimedOut
                            .selector,
                        key
                    )
                )
            ) {
                successes["surfaceAcceptanceTimedOut"] += 1;
            }
            return;
        }

        Reservation.ReservationRequest memory r = stack.reservationRecord(key);
        Reservation.ReservationAction memory a = stack.reservationActionRecord(
            key,
            r.requestNonce
        );
        if (
            stack.callRouter(
                abi.encodeWithSelector(
                    ReservationRouter.notifyReservationActionTimeout.selector,
                    key
                )
            )
        ) {
            if (
                a.state == Reservation.ActionState.Pending &&
                stack.reservationRecord(key).reanchorCooldownUntil == 0
            ) {
                reanchorTimeoutWithoutCooldown = true;
            }
            successes["surfaceActionTimedOut"] += 1;
        }
    }

    /// @dev Attempts a timeout notification strictly before the deadline.
    ///      A successful notification is a violation of INV-601.
    function surfaceEarlyTimeout(uint256 keySeed) external {
        if (stackKeys.length == 0) return;
        uint256 key = stackKeys[keySeed % stackKeys.length];
        Reservation.ReservationRequest memory r = stack.reservationRecord(key);
        Reservation.ReservationAction memory a = stack.reservationActionRecord(
            key,
            r.requestNonce
        );
        if (a.state != Reservation.ActionState.Pending) return;
        /* solhint-disable-next-line not-rely-on-time */
        if (block.timestamp >= a.timeoutAt) return;

        if (
            stack.callRouter(
                abi.encodeWithSelector(
                    ReservationRouter.notifyReservationActionTimeout.selector,
                    key
                )
            )
        ) {
            earlyTimeoutSucceeded = true;
        }
    }

    function surfaceRetireDeposit(uint256 keySeed, uint8 path) external {
        if (stackKeys.length == 0) return;
        uint256 key = stackKeys[keySeed % stackKeys.length];
        path = path % 3;
        bytes memory data;
        if (path == 0) {
            data = abi.encodeWithSelector(
                ReservationRouter.notifyStaleReservedDeposit.selector,
                key
            );
        } else if (path == 1) {
            data = abi.encodeWithSelector(
                ReservationRouter.forceStaleReservedDeposit.selector,
                key
            );
        } else {
            data = abi.encodeWithSelector(
                ReservationRouter.releaseReservedDepositToPool.selector,
                key,
                address(0x300D)
            );
        }
        if (stack.callRouter(data)) {
            successes[
                path == 0
                    ? "surfaceStale"
                    : path == 1
                        ? "surfaceForceStale"
                        : "surfaceRelease"
            ] += 1;
        }
    }

    function surfaceStrand(uint256 keySeed) external {
        if (stackKeys.length == 0) return;
        if (
            stack.callRouter(
                abi.encodeWithSelector(
                    ReservationRouter.notifyReservationStranded.selector,
                    stackKeys[keySeed % stackKeys.length]
                )
            )
        ) {
            successes["surfaceStranded"] += 1;
        }
    }

    /// @dev Retires a wallet along its lifecycle. At least three wallets are
    ///      kept Live: the hand-off reserve gate needs Live wallets beyond the
    ///      reserve to admit an acceptance, so retiring every wallet would
    ///      make the acceptance path unreachable for the rest of a sequence.
    /// @dev The selected wallet is kept. The Live count is guarded only for
    ///      a wallet that is currently Live, because the guard exists to
    ///      keep Live wallets available. A wallet that already left Live may
    ///      advance along the rest of its lifecycle, so a MovingFunds wallet
    ///      can reach Closing and a Closing wallet can reach Closed.
    ///      Replacing a retiring selection with a Live wallet made those two
    ///      states unreachable in the campaign.
    function surfaceAdvanceWallet(uint256 walletSeed, bool terminate) external {
        if (stackWallets.length == 0) return;
        uint256 live;
        for (uint256 i = 0; i < stackWallets.length; i++) {
            if (
                stack.walletState(stackWallets[i]) == Wallets.WalletState.Live
            ) {
                live += 1;
            }
        }
        bytes20 wallet = stackWallets[walletSeed % stackWallets.length];
        Wallets.WalletState s = stack.walletState(wallet);
        if (
            s == Wallets.WalletState.Closed ||
            s == Wallets.WalletState.Terminated
        ) {
            return;
        }
        // Retiring a Live wallet reduces the Live count, so the hand-off
        // reserve guard applies to it only.
        if (s == Wallets.WalletState.Live && live <= 3) return;
        Wallets.WalletState next =
            terminate
                ? Wallets.WalletState.Terminated
                : Wallets.WalletState(uint8(s) + 1);
        stack.setWalletState(wallet, next);
        successes["surfaceAdvanceWallet"] += 1;
    }

    // ---------------------------------------------------------------------
    // Vault actions
    // ---------------------------------------------------------------------

    /// @dev Credits the vault through the production
    ///      `Bank.increaseBalanceAndCall` → `receiveBalanceIncrease` path.
    ///      The vault's Bank balance is topped up first: the credit moves
    ///      the whole Bank credit into the TBTC vault, so the burn path
    ///      would otherwise have no Bank side to decrease.
    function surfaceCredit(uint256 depositorSeed, uint64 amountSeed) external {
        uint64 amount = uint64(100_000 + (amountSeed % 5_000_000));
        // One seed in sixteen sends the empty depositor list, so the vault's
        // own `No depositors specified` guard answers instead of the Bank's.
        if (depositorSeed % 16 == 15) {
            stack.fundVaultBank(amount);
            try stack.creditVaultEmpty(amount) {
                successes["surfaceCreditEmpty"] += 1;
            } catch {}
            return;
        }
        address depositor = stackDepositors[
            depositorSeed % stackDepositors.length
        ];
        uint16 bps = vault().initiationFeeBps();
        uint256 grossTbtc = uint256(amount) * SATOSHI_MULTIPLIER;
        uint256 feeTbtc = (grossTbtc * bps) / 10_000;

        uint256 bankSide = uint256(amount) + (amountSeed % 500_000);
        stack.fundVaultBank(uint64(bankSide));

        try stack.creditVault(depositor, amount) {
            ghostVaultTbtc += feeTbtc;
            ghostRoutedSat += amount;
            ghostSupplyTbtc += grossTbtc;
            ghostDepositorTbtc[depositor] += grossTbtc - feeTbtc;
            successes["surfaceCredit"] += 1;
        } catch {}
    }

    /// @dev Finances an in-kind fee directly. The predicted burn and debt
    ///      are computed from the vault's own reserve and fee parameters
    ///      before the call, so the property that reads them back is not
    ///      fed by the vault's own arithmetic.
    function surfaceFinanceInKindFee(uint64 feeSeed) external {
        // A zero fee is forwarded: the vault returns early on it, which is
        // one of its own guards, so no fuzzed input should skip the call.
        uint64 feeSat = uint64(feeSeed % 300_000);
        uint256 vaultTbtcBefore = tbtc().balanceOf(address(vault()));
        uint64 predictedBurned = uint64(
            min(uint256(feeSat), vaultTbtcBefore / SATOSHI_MULTIPLIER)
        );

        _fundBankSide(predictedBurned);
        try stack.financeInKindFee(feeSat) {
            ghostVaultTbtc -= uint256(predictedBurned) * SATOSHI_MULTIPLIER;
            ghostSupplyTbtc -= uint256(predictedBurned) * SATOSHI_MULTIPLIER;
            ghostFeeDebtSat += feeSat - predictedBurned;
            successes["surfaceFinanceInKindFee"] += 1;
        } catch {}
    }

    function surfaceRepay(uint64 amountSeed) external {
        // The raw amount reaches the vault so its own guards answer: the
        // zero-amount and no-debt reverts, and the cap of a repayment above
        // the outstanding debt. The ghost uses the capped amount, which is
        // what the vault is allowed to burn.
        uint64 debt = vault().inKindFeeDebtSat();
        uint64 amount = uint64(amountSeed % 400_000);
        uint64 repaySat = uint64(min(uint256(amount), uint256(debt)));
        _fundBankSide(repaySat);
        try stack.repayInKindFeeDebt(amount) {
            // The vault receives the TBTC and burns it in the same call, so
            // its own balance does not move; the payer's does, and the supply
            // shrinks.
            ghostDepositorTbtc[address(stack)] -=
                uint256(repaySat) * SATOSHI_MULTIPLIER;
            ghostSupplyTbtc -= uint256(repaySat) * SATOSHI_MULTIPLIER;
            ghostFeeDebtSat -= repaySat;
            successes["surfaceRepay"] += 1;
        } catch {}
    }

    function surfaceSweepFees(uint256 recipientSeed) external {
        // One seed in four names the zero recipient, so the vault's own
        // recipient guard answers instead of being skipped here.
        address recipient =
            recipientSeed % 4 == 3
                ? address(0)
                : address(uint160(0x5E0000 + (recipientSeed % 3)));
        uint64 debt = vault().inKindFeeDebtSat();
        uint256 balance = tbtc().balanceOf(address(vault()));
        uint64 predictedBurn = uint64(
            min(uint256(debt), balance / SATOSHI_MULTIPLIER)
        );
        uint256 afterBurn =
            balance - uint256(predictedBurn) * SATOSHI_MULTIPLIER;
        uint256 target = vault().feeReserveTarget();
        uint256 predictedSweep = afterBurn > target ? afterBurn - target : 0;

        _fundBankSide(predictedBurn);
        try stack.sweepFees(recipient) {
            ghostVaultTbtc -= uint256(predictedBurn) * SATOSHI_MULTIPLIER;
            ghostSupplyTbtc -= uint256(predictedBurn) * SATOSHI_MULTIPLIER;
            ghostFeeDebtSat -= predictedBurn;
            ghostVaultTbtc -= predictedSweep;
            ghostDepositorTbtc[recipient] += predictedSweep;
            successes["surfaceSweepFees"] += 1;
        } catch {}
    }

    function surfaceUpdateInitiationFee(uint16 bpsSeed) external {
        // The range crosses the protocol ceiling (500 bps), so both the
        // accepted and the rejected arm are reachable.
        try stack.updateInitiationFee(uint16(bpsSeed % 700)) {
            successes["surfaceUpdateInitiationFee"] += 1;
        } catch {}
    }

    function surfaceUpdateFeeReserveTarget(uint64 targetSeed) external {
        try
            stack.updateFeeReserveTarget(
                uint256(targetSeed % 500_000) * SATOSHI_MULTIPLIER
            )
        {
            successes["surfaceUpdateFeeReserveTarget"] += 1;
        } catch {}
    }

    /// @dev Calls a vault entry point from an address that is neither the
    ///      Bank, the configured Bridge, nor the vault owner. Every one of
    ///      them must refuse. This is the only way to reach those guards:
    ///      the harness is all three, and `receiveBalanceApproval` has no
    ///      protocol caller at all.
    /// @param which 0 `receiveBalanceIncrease`, 1 `financeInKindFee`,
    ///        2 `updateFeeReserveTarget`, 3 `sweepFees`,
    ///        4 `updateInitiationFee`, 5 `receiveBalanceApproval`.
    function surfaceVaultOutsider(uint8 which, uint64 seed) external {
        address[] memory depositors = new address[](1);
        depositors[0] = address(this);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = seed % 100_000;

        uint8 mode = which % 6;
        bytes memory data;
        if (mode == 0) {
            data = abi.encodeCall(
                ReservationVault.receiveBalanceIncrease,
                (depositors, amounts)
            );
        } else if (mode == 1) {
            data = abi.encodeCall(
                ReservationVault.financeInKindFee,
                (uint64(seed % 100_000))
            );
        } else if (mode == 2) {
            data = abi.encodeCall(
                ReservationVault.updateFeeReserveTarget,
                (uint256(seed) * SATOSHI_MULTIPLIER)
            );
        } else if (mode == 3) {
            data = abi.encodeCall(
                ReservationVault.sweepFees,
                (address(uint160(0x5E0000)))
            );
        } else if (mode == 4) {
            data = abi.encodeCall(
                ReservationVault.updateInitiationFee,
                (uint16(seed % 700))
            );
        } else {
            data = abi.encodeCall(
                ReservationVault.receiveBalanceApproval,
                (address(this), uint256(seed), bytes(""))
            );
        }

        // A success here would be a real access-control bug. There is no
        // property over it: no honest corruption can make such a flag fire,
        // so the counters are the record and the guard coverage is the point.
        if (nonGovernanceCaller.call(address(vault()), data)) {
            successes["surfaceVaultOutsiderAccepted"] += 1;
        } else {
            successes["surfaceVaultOutsider"] += 1;
        }
    }

    // ---------------------------------------------------------------------
    // Router actions
    // ---------------------------------------------------------------------

    /// @dev Governance path into the router's parameter update. The address
    ///      change is what P7 (INV-109) forbids while a reserved deposit is
    ///      pending, so the property records a violation when the vault
    ///      address actually changes while the pending count is non-zero.
    function routerUpdateParameters(
        uint8 vaultSeed,
        uint64 totalSeed,
        uint32 perWalletSeed
    ) external {
        address vaultBefore = stack.reservationVaultAddress();
        address newVault = vaultSeed % 2 == 0 ? vaultBefore : address(0xBAAD);
        uint256 pendingBefore = stack.pendingReservedDepositsProbe();

        bool ok = stack.callRouter(
            abi.encodeWithSelector(
                ReservationRouter.updateReservationParameters.selector,
                newVault,
                100_000,
                10_000,
                90 days,
                7 days,
                uint64(1_000_000 + (totalSeed % 5_000_000)),
                1 + (perWalletSeed % 4),
                6 hours,
                7 days
            )
        );
        if (ok) {
            successes["routerUpdateParameters"] += 1;
            // INV-109: the vault may only be re-pointed while no reserved
            // deposit is pending. A change with a pending deposit is a
            // violation.
            if (
                pendingBefore > 0 &&
                newVault != vaultBefore &&
                stack.reservationVaultAddress() != vaultBefore
            ) {
                repointedVaultWhilePending = true;
            }
        }
    }

    function routerUpdateCaps(
        uint64 singleSeed,
        uint32 activeSeed,
        uint32 holdsSeed,
        uint32 reserveSeed
    ) external {
        bool ok = stack.callRouter(
            abi.encodeWithSelector(
                ReservationRouter.updateReservationCaps.selector,
                uint64(1_000_000 + (singleSeed % 5_000_000)),
                uint64(50_000 + (singleSeed % 3_000_000)),
                1 + (activeSeed % 8),
                holdsSeed % 3,
                1 + (reserveSeed % 2)
            )
        );
        if (ok) {
            successes["routerUpdateCaps"] += 1;
        }
    }

    /// @dev A non-governance caller attempts the router's governance-only
    ///      mutators through a forwarding contract, so the router sees a
    ///      sender that is not the governance. Any change is a violation of
    ///      INV-401.
    function routerNonGovernanceUpdate(uint8 which, uint64 seed) external {
        address vaultBefore = stack.reservationVaultAddress();
        (uint64 singleBefore, , uint32 activeBefore, ) = stack
            .reservationCapsProbe();
        uint256 pendingBefore = stack.pendingReservedDepositsProbe();
        bool reservedBefore =
            stackKeys.length > 0 && stack.isReservedDepositProbe(stackKeys[0]);

        bytes memory data;
        which = which % 3;
        if (which == 2) {
            // The governance-only force-stale override. A non-governance
            // caller that could clear a pending reserved deposit would
            // break the griefing guard the override exists for.
            if (stackKeys.length == 0) return;
            data = abi.encodeWithSelector(
                ReservationRouter.forceStaleReservedDeposit.selector,
                stackKeys[0]
            );
        } else if (which == 0) {
            data = abi.encodeWithSelector(
                ReservationRouter.updateReservationParameters.selector,
                address(0xBAD0),
                100_000,
                10_000,
                90 days,
                7 days,
                uint64(1_000_000 + (seed % 5_000_000)),
                2,
                6 hours,
                7 days
            );
        } else {
            data = abi.encodeWithSelector(
                ReservationRouter.updateReservationCaps.selector,
                uint64(1_000_000 + (seed % 5_000_000)),
                uint64(50_000 + (seed % 3_000_000)),
                1 + (uint32(seed) % 8),
                1,
                1
            );
        }

        bool ok = nonGovernanceCaller.call(address(stack), data);

        (uint64 singleAfter, , uint32 activeAfter, ) = stack
            .reservationCapsProbe();
        if (
            stack.reservationVaultAddress() != vaultBefore ||
            singleAfter != singleBefore ||
            activeAfter != activeBefore ||
            (reservedBefore &&
                (stack.pendingReservedDepositsProbe() != pendingBefore ||
                    !stack.isReservedDepositProbe(stackKeys[0])))
        ) {
            nonGovernanceParameterChange = true;
        }
        if (ok) {
            successes["routerNonGovernanceUpdateSucceeded"] += 1;
        }
    }

    function routerNotifyTimeout(uint256 keySeed, uint8 mode) external {
        if (stackKeys.length == 0) return;
        uint256 key = stackKeys[keySeed % stackKeys.length];
        bytes memory data =
            mode % 2 == 0
                ? abi.encodeWithSelector(
                    ReservationRouter
                        .notifyReservationAcceptanceTimedOut
                        .selector,
                    key
                )
                : abi.encodeWithSelector(
                    ReservationRouter.notifyReservationActionTimeout.selector,
                    key
                );
        bool ok = stack.callRouter(data);
        if (ok) {
            successes["routerNotifyTimeout"] += 1;
        }
    }

    function routerForceStale(uint256 keySeed) external {
        if (stackKeys.length == 0) return;
        uint256 key = stackKeys[keySeed % stackKeys.length];
        bool ok = stack.callRouter(
            abi.encodeWithSelector(
                ReservationRouter.forceStaleReservedDeposit.selector,
                key
            )
        );
        if (ok) {
            successes["routerForceStale"] += 1;
        }
    }

    function routerReanchor(uint256 keySeed, uint256 targetSeed) external {
        if (stackKeys.length == 0) return;
        uint256 key = stackKeys[keySeed % stackKeys.length];
        bytes20 target = stackWallets[targetSeed % stackWallets.length];
        bool ok = stack.callRouter(
            abi.encodeWithSelector(
                ReservationRouter.requestReservationReanchor.selector,
                key,
                target,
                new uint32[](0),
                0
            )
        );
        if (ok) {
            successes["routerReanchor"] += 1;
        }
    }

    /// @dev Reads the router's view surface through the fallback so the
    ///      view code is covered and its answers are compared with the
    ///      storage the harness wrote. Any disagreement means the router is
    ///      reading a different slot than the library writes.
    function routerReadViews() external {
        (bool ok, bytes memory data) = address(stack).staticcall(
            abi.encodeWithSelector(ReservationRouter.reservationCaps.selector)
        );
        if (ok) {
            (
                uint64 perWalletAmount,
                uint64 singleAmount,
                uint32 maxActive,
                uint32 maxHolds
            ) = abi.decode(data, (uint64, uint64, uint32, uint32));
            (
                uint64 probePerWallet,
                uint64 probeSingle,
                uint32 probeActive,
                uint32 probeHolds
            ) = stack.reservationCapsProbe();
            if (
                perWalletAmount != probePerWallet ||
                singleAmount != probeSingle ||
                maxActive != probeActive ||
                maxHolds != probeHolds
            ) {
                routerViewMismatch = true;
            }
        }

        (ok, data) = address(stack).staticcall(
            abi.encodeWithSelector(
                ReservationRouter.pendingReservedDeposits.selector
            )
        );
        if (ok) {
            if (
                abi.decode(data, (uint64)) !=
                stack.pendingReservedDepositsProbe()
            ) {
                routerViewMismatch = true;
            }
        }

        (ok, data) = address(stack).staticcall(
            abi.encodeWithSelector(
                ReservationRouter.activeReservationsCount.selector
            )
        );
        if (ok) {
            if (
                abi.decode(data, (uint32)) !=
                stack.activeReservationsCountProbe()
            ) {
                routerViewMismatch = true;
            }
        }

        // The per-wallet counters, the anchor index, the reserved-deposit
        // marker and the third-party holds. They take a wallet or a key, so
        // they are read against the first wallet and the first key.
        if (stackWallets.length != 0) {
            bytes20 wallet = stackWallets[0];

            (ok, data) = address(stack).staticcall(
                abi.encodeWithSelector(
                    ReservationRouter.walletReservationsCount.selector,
                    wallet
                )
            );
            if (ok) {
                (uint32 count, uint64 amount) = stack
                    .walletReservationInfoProbe(wallet);
                if (abi.decode(data, (uint32)) != count) {
                    routerViewMismatch = true;
                }
                (ok, data) = address(stack).staticcall(
                    abi.encodeWithSelector(
                        ReservationRouter.walletReservationsAmount.selector,
                        wallet
                    )
                );
                if (ok) {
                    if (abi.decode(data, (uint64)) != amount) {
                        routerViewMismatch = true;
                    }
                }
            }

            (ok, data) = address(stack).staticcall(
                abi.encodeWithSelector(
                    ReservationRouter.pendingThirdPartyReanchorHolds.selector,
                    wallet
                )
            );
            if (ok) {
                abi.decode(data, (uint32));
            }

            if (stackKeys.length != 0) {
                uint256 key = stackKeys[0];
                (ok, data) = address(stack).staticcall(
                    abi.encodeWithSelector(
                        ReservationRouter.reservedDepositWallet.selector,
                        key
                    )
                );
                if (ok) {
                    // Compared with the storage the library writes, not with
                    // the reveal-time wallet: a retired deposit is cleared, and
                    // both sides must show that.
                    if (
                        abi.decode(data, (bytes20)) !=
                        stack.reservedDepositWalletProbe(key)
                    ) {
                        routerViewMismatch = true;
                    }
                }

                (ok, data) = address(stack).staticcall(
                    abi.encodeWithSelector(
                        ReservationRouter.reservationByAnchorUtxo.selector,
                        stack.fundingTxHash(key),
                        uint32(0)
                    )
                );
                if (ok) {
                    abi.decode(data, (uint256));
                }
            }
        }

        // The getters the action above never called: the parameter record,
        // the hand-off reserve and the two per-key records. They are read
        // through the fallback like the rest, so the router's view bodies
        // execute on the harness storage.
        (ok, data) = address(stack).staticcall(
            abi.encodeWithSelector(
                ReservationRouter.reservationParameters.selector
            )
        );
        if (ok) {
            abi.decode(
                data,
                (
                    address,
                    uint64,
                    uint64,
                    uint32,
                    uint32,
                    uint64,
                    uint64,
                    uint32,
                    uint32,
                    uint32
                )
            );
        }

        (ok, data) = address(stack).staticcall(
            abi.encodeWithSelector(
                ReservationRouter.reservationHandoffReserveWallets.selector
            )
        );
        if (ok) {
            abi.decode(data, (uint32));
        }

        (ok, data) = address(stack).staticcall(
            abi.encodeWithSelector(ReservationRouter.reservationRouter.selector)
        );
        if (ok) {
            abi.decode(data, (address));
        }

        if (stackKeys.length != 0) {
            uint256 key = stackKeys[0];
            (ok, data) = address(stack).staticcall(
                abi.encodeWithSelector(
                    ReservationRouter.reservations.selector,
                    key
                )
            );
            if (ok) {
                abi.decode(data, (Reservation.ReservationRequest));
            }

            uint64 nonce = stack.reservationRecord(key).requestNonce;
            if (nonce != 0) {
                (ok, data) = address(stack).staticcall(
                    abi.encodeWithSelector(
                        ReservationRouter.reservationActions.selector,
                        key,
                        nonce
                    )
                );
                if (ok) {
                    abi.decode(data, (Reservation.ReservationAction));
                }
            }
        }

        successes["routerReadViews"] += 1;
    }

    bool public routerViewMismatch;

    // ---------------------------------------------------------------------
    // Validator actions
    // ---------------------------------------------------------------------

    /// @dev Builds a reservation anchor proposal for the pending acceptance
    ///      action of `key` and asks the real validator to validate it.
    ///      `mutation` selects a variant that must be rejected, so the
    ///      rejection properties have a positive control.
    /// @param mutation 0: as authorized, 1: fee above the action's max,
    ///        2: zero fee, 3: a wallet other than the authorized target.
    function surfaceValidateAnchor(
        uint256 keySeed,
        uint64 feeSeed,
        uint8 mutation
    ) external {
        if (stackKeys.length == 0) return;
        uint256 key = stackKeys[keySeed % stackKeys.length];
        if (!_ensurePendingAcceptance(key)) return;

        uint64 nonce = _acceptanceNonce(key);
        Reservation.ReservationAction memory a = stack.reservationActionRecord(
            key,
            nonce
        );

        mutation = mutation % 4;
        uint256 fee = uint256(a.amount) % (a.txMaxFee + 1);
        if (fee == 0) fee = 1;
        bytes20 proposalWallet = a.targetWalletPubKeyHash;
        if (mutation == 1) {
            fee = uint256(a.txMaxFee) + 1 + (feeSeed % 10_000);
        } else if (mutation == 2) {
            fee = 0;
        } else if (mutation == 3) {
            proposalWallet = bytes20(uint160(0xDEADBEEF));
        }

        bool accepted = _tryValidateAnchor(
            _anchorProposal(key, nonce, proposalWallet, fee),
            _depositExtraInfo(key)
        );
        if (accepted) {
            ghostAnchorAccepted += 1;
            if (mutation == 1) overFeeAnchorAccepted = true;
            if (mutation == 2) zeroFeeAnchorAccepted = true;
            if (mutation == 3) foreignWalletAnchorAccepted = true;
        } else {
            ghostAnchorRejected += 1;
        }
    }

    /// @dev Builds a re-anchor proposal for the pending re-anchor action of
    ///      `key`. `mutation` 1 raises the fee above the action's snapshot;
    ///      the validator must reject it.
    function surfaceValidateReanchor(
        uint256 keySeed,
        uint64 feeSeed,
        uint8 mutation
    ) external {
        if (stackKeys.length == 0) return;
        uint256 key = stackKeys[keySeed % stackKeys.length];
        if (!_ensurePendingReanchor(key)) return;

        Reservation.ReservationRequest memory r = stack.reservationRecord(key);
        Reservation.ReservationAction memory a = stack.reservationActionRecord(
            key,
            r.requestNonce
        );

        uint256 fee = uint256(a.amount) % (a.txMaxFee + 1);
        if (fee == 0) fee = 1;
        if (mutation % 2 == 1) {
            fee = uint256(a.txMaxFee) + 1 + (feeSeed % 10_000);
        }

        bool accepted = _tryValidateReanchor(
            WalletProposalValidator.ReservationReanchorProposal({
                sourceWalletPubKeyHash: r.walletPubKeyHash,
                reservationKey: key,
                requestNonce: r.requestNonce,
                targetWalletPubKeyHash: a.targetWalletPubKeyHash,
                reanchorTxFee: fee
            })
        );
        if (accepted) {
            ghostReanchorAccepted += 1;
            if (mutation % 2 == 1) overFeeReanchorAccepted = true;
        } else {
            ghostReanchorRejected += 1;
        }
    }

    /// @dev A proposal with no backing action at all: every nonce the
    ///      position never issued. The validator must reject all of them.
    function surfaceValidateUnbackedAnchor(
        uint256 keySeed,
        uint64 nonceSeed,
        uint64 feeSeed
    ) external {
        if (stackKeys.length == 0) return;
        uint256 key = stackKeys[keySeed % stackKeys.length];
        Reservation.ReservationRequest memory r = stack.reservationRecord(key);
        if (r.requestNonce == 0) return;

        uint64 nonce = r.requestNonce + 1 + (nonceSeed % 3);
        if (
            _tryValidateAnchor(
                _anchorProposal(
                    key,
                    nonce,
                    r.walletPubKeyHash == bytes20(0)
                        ? stackKeyWallet[key]
                        : r.walletPubKeyHash,
                    1 + (feeSeed % 10_000)
                ),
                _depositExtraInfo(key)
            )
        ) {
            unbackedAnchorAccepted = true;
            ghostAnchorAccepted += 1;
        } else {
            ghostAnchorRejected += 1;
        }
    }

    /// @dev Ordinary deposit-sweep probe. The validator's sweep rules are a
    ///      different entry point from the two reservation proposals, and
    ///      one of them is the only on-chain guard that stops an ordinary
    ///      sweep from taking a deposit that was revealed as reserved:
    ///      `Reserved deposits must not be swept`.
    /// @param mutation 0: a pool deposit with valid extra info, which must
    ///        be accepted (the positive control, and the only path that
    ///        exercises the proposal loop end to end); 1: the same
    ///        proposal over a reserved reservation key, which must be
    ///        rejected by the reservation rule; 2: a pool deposit already
    ///        marked swept; 3: a pool deposit younger than the minimum
    ///        deposit age.
    function surfaceValidateSweep(
        uint256 keySeed,
        uint64 feeSeed,
        uint8 mutation
    ) external {
        mutation = mutation % 4;

        uint256 key;
        if (mutation == 1) {
            if (stackKeys.length == 0) return;
            key = stackKeys[keySeed % stackKeys.length];
        } else {
            uint8 slot = uint8(keySeed % 8);
            try
                stack.revealOrGetPoolDeposit(
                    slot,
                    stackWallets[slot % stackWallets.length],
                    uint64(200_000 + (feeSeed % 1_000_000))
                )
            returns (uint256 poolKey) {
                key = poolKey;
            } catch {
                return;
            }
        }

        if (mutation == 2) {
            stack.markDepositSwept(key);
        }
        if (mutation != 3) {
            uint32 revealedAt = stack.depositRevealedAt(key);
            uint32 minAge =
                revealedAt + WalletProposalValidatorConstants.DEPOSIT_MIN_AGE;
            if (block.timestamp <= minAge) {
                vm.warp(uint256(minAge) + 1);
            }
        }

        (, , uint64 depositTxMaxFee, ) = stack.depositParameters();
        uint256 fee = uint256(feeSeed % (uint256(depositTxMaxFee) + 1));
        if (fee == 0) fee = 1;

        WalletProposalValidator.DepositExtraInfo
            memory info = _depositExtraInfo(key);
        WalletProposalValidator.DepositKey[]
            memory depositsKeys = new WalletProposalValidator.DepositKey[](1);
        depositsKeys[0] = WalletProposalValidator.DepositKey({
            fundingTxHash: stack.fundingTxHash(key),
            fundingOutputIndex: 0
        });
        WalletProposalValidator.DepositExtraInfo[]
            memory extraInfos = new WalletProposalValidator.DepositExtraInfo[](
                1
            );
        extraInfos[0] = info;
        uint256[] memory revealBlocks = new uint256[](1);
        revealBlocks[0] = block.number;

        bool accepted;
        try
            stack.validator().validateDepositSweepProposal(
                WalletProposalValidator.DepositSweepProposal({
                    walletPubKeyHash: info.walletPubKeyHash,
                    depositsKeys: depositsKeys,
                    sweepTxFee: fee,
                    depositsRevealBlocks: revealBlocks
                }),
                extraInfos
            )
        returns (bool valid) {
            accepted = valid;
        } catch {
            accepted = false;
        }

        if (accepted) {
            ghostSweepAccepted += 1;
            if (mutation == 1) reservedSweepAccepted = true;
        } else {
            ghostSweepRejected += 1;
        }
    }

    // ---------------------------------------------------------------------
    // Properties: the vault
    // ---------------------------------------------------------------------

    /// @dev P8 (INV-209, INV-701, INV-704): the vault mints the gross anchor
    ///      and retains exactly the initiation fee, so its TBTC balance is
    ///      the retained fees minus what it burned and swept. The predicted
    ///      balance is built from the fee parameter and each call's own
    ///      inputs, not from the vault's return values.
    function property_vaultTbtcBalanceMatchesFeesBurnedAndSwept()
        public
        view
        returns (bool)
    {
        return tbtc().balanceOf(address(vault())) == ghostVaultTbtc;
    }

    /// @dev P8 (INV-209, INV-701, INV-704): a credited depositor receives
    ///      the gross amount minus the initiation fee, exactly.
    function property_depositorReceivesGrossMinusInitiationFee()
        public
        view
        returns (bool)
    {
        for (uint256 i = 0; i < stackDepositors.length; i++) {
            address d = stackDepositors[i];
            if (tbtc().balanceOf(d) != ghostDepositorTbtc[d]) {
                return false;
            }
        }
        return true;
    }

    /// @dev P9 (INV-207, INV-705): `inKindFeeDebtSat` equals the financed
    ///      fees the reserve could not cover, minus repayments and
    ///      debt-first sweeps.
    function property_inKindFeeDebtMatchesFinancing()
        public
        view
        returns (bool)
    {
        return vault().inKindFeeDebtSat() == ghostFeeDebtSat;
    }

    /// @dev P11 (INV-212): the TBTC supply the vault stack minted equals the
    ///      satoshi routed through it minus what its burns and repayments
    ///      removed. Supply tracks the Bitcoin backing one-for-one.
    function property_supplyStaysInLockstepWithRoutedSatoshi()
        public
        view
        returns (bool)
    {
        return tbtc().totalSupply() == ghostSupplyTbtc;
    }

    /// @dev P24 (INV-401): the vault's fee never exceeds the protocol
    ///      ceiling, whatever the fuzzer proposes.
    function property_vaultFeeStaysWithinTheCeiling()
        public
        view
        returns (bool)
    {
        return vault().initiationFeeBps() <= vault().MAX_FEE_BASIS_POINTS();
    }

    /// @dev P7 (INV-109): the vault was never re-pointed while a reserved
    ///      deposit was pending.
    function property_vaultIsNeverRepointedWhileDepositsArePending()
        public
        view
        returns (bool)
    {
        return !repointedVaultWhilePending;
    }

    // ---------------------------------------------------------------------
    // Properties: the router
    // ---------------------------------------------------------------------

    /// @dev P24 (INV-401, SM-A1, SM-A4, SM-A5, SM-A6): only governance may
    ///      change the reservation parameters or caps, and only governance
    ///      may force a stale deposit.
    function property_onlyGovernanceChangesRouterParameters()
        public
        view
        returns (bool)
    {
        return !nonGovernanceParameterChange;
    }

    /// @dev P24 (INV-401): the router's views agree with the storage the
    ///      library writes, so the delegatecall reads the same slot.
    function property_routerViewsAgreeWithStorage() public view returns (bool) {
        return !routerViewMismatch;
    }

    /// @dev P22 (INV-601, INV-602): a timeout notification is refused
    ///      before the deadline, and a timed-out re-anchor sets a cooldown.
    function property_timeoutsAreRefusedBeforeTheDeadline()
        public
        view
        returns (bool)
    {
        return !earlyTimeoutSucceeded;
    }

    /// @dev P22 (INV-601, INV-602): a timed-out re-anchor always leaves a
    ///      cooldown behind.
    function property_reanchorTimeoutSetsCooldown() public view returns (bool) {
        return !reanchorTimeoutWithoutCooldown;
    }

    // ---------------------------------------------------------------------
    // Properties: the validator
    // ---------------------------------------------------------------------

    /// @dev P24 (INV-401, SM-A5): the validator never accepts a proposal
    ///      that no pending action backs.
    function property_validatorRejectsUnbackedProposals()
        public
        view
        returns (bool)
    {
        return !unbackedAnchorAccepted;
    }

    /// @dev P24 (INV-401, SM-A5): the validator never accepts a proposal
    ///      whose fee is above the action's snapshotted maximum, whose fee
    ///      is zero, or that names a wallet the action does not authorize.
    function property_validatorRejectsOutOfBoundProposals()
        public
        view
        returns (bool)
    {
        return
            !overFeeAnchorAccepted &&
            !zeroFeeAnchorAccepted &&
            !foreignWalletAnchorAccepted &&
            !overFeeReanchorAccepted;
    }

    /// @dev P24 (INV-401, SM-A5): the sweep validator never accepts a
    ///      proposal over a deposit revealed as reserved. This is the only
    ///      rule that keeps an ordinary sweep from taking funds anchored
    ///      through the reservation flow, and it lives in a different entry
    ///      point from the two reservation proposals.
    function property_validatorNeverSweepsReservedDeposits()
        public
        view
        returns (bool)
    {
        return !reservedSweepAccepted;
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /// @dev Warps forward past the validator's `DEPOSIT_MIN_AGE` for the
    ///      deposit behind `key`. Time only moves forward.
    function _warpPastDepositAge(uint256 key) internal {
        uint32 revealedAt = stack.depositRevealedAt(key);
        if (revealedAt == 0) return;
        if (block.timestamp <= uint256(revealedAt) + 2 hours) {
            vm.warp(uint256(revealedAt) + 2 hours + 1);
        }
    }

    /// @dev The current request nonce of a position whose latest generation
    ///      is a pending acceptance, or zero.
    function _acceptanceNonce(uint256 key) internal view returns (uint64) {
        Reservation.ReservationRequest memory r = stack.reservationRecord(key);
        if (r.requestNonce == 0) return 0;
        Reservation.ReservationAction memory a = stack.reservationActionRecord(
            key,
            r.requestNonce
        );
        if (
            a.actionType != Reservation.ActionType.Acceptance ||
            a.state != Reservation.ActionState.Pending
        ) {
            return 0;
        }
        return r.requestNonce;
    }

    /// @dev True while the generation `nonce` is still inside its signing
    ///      window, i.e. the validator's `REQUEST_TIMEOUT_SAFETY_MARGIN` has
    ///      not eaten it.
    function _signingWindowOpen(
        uint256 key,
        uint64 nonce
    ) internal view returns (bool) {
        Reservation.ReservationAction memory a = stack.reservationActionRecord(
            key,
            nonce
        );
        /* solhint-disable-next-line not-rely-on-time */
        return block.timestamp < uint256(a.timeoutAt) - 2 hours;
    }

    /// @dev Expires a generation past its signing window through the router's
    ///      permissionless notification, which is the production recovery
    ///      path, and returns whether the notification went through.
    function _expireGeneration(
        uint256 key,
        Reservation.ActionType kind
    ) internal returns (bool) {
        (bool ok, bytes memory data) = address(stack).call(
            kind == Reservation.ActionType.Acceptance
                ? abi.encodeWithSelector(
                    ReservationRouter
                        .notifyReservationAcceptanceTimedOut
                        .selector,
                    key
                )
                : abi.encodeWithSelector(
                    ReservationRouter.notifyReservationActionTimeout.selector,
                    key
                )
        );
        data;
        return ok;
    }

    /// @dev Issues an acceptance authorization for `key` if there is none, and
    ///      refreshes one whose signing window has closed. Returns true when a
    ///      signable pending acceptance generation exists.
    function _ensurePendingAcceptance(uint256 key) internal returns (bool) {
        bytes20 wallet = stackKeyWallet[key];
        if (wallet == bytes20(0)) return false;
        _warpPastDepositAge(key);

        for (uint256 attempt = 0; attempt < 2; attempt++) {
            uint64 nonce = _acceptanceNonce(key);
            if (nonce != 0) {
                if (_signingWindowOpen(key, nonce)) return true;
                // Move to the deadline so the timeout notification is legal,
                // then let the next loop iteration re-issue the generation.
                uint256 timeoutAt = stack
                    .reservationActionRecord(key, nonce)
                    .timeoutAt;
                if (block.timestamp < timeoutAt) vm.warp(timeoutAt);
                _expireGeneration(key, Reservation.ActionType.Acceptance);
                continue;
            }
            if (
                stack.reservationRecord(key).state !=
                Reservation.ReservationState.Unknown
            ) {
                return false;
            }
            try stack.requestReservationAcceptance(key, wallet) {} catch {
                return false;
            }
        }

        uint64 fresh = _acceptanceNonce(key);
        return fresh != 0 && _signingWindowOpen(key, fresh);
    }

    /// @dev Settles the pending acceptance of `key`, opening the position.
    function _proveAcceptance(
        uint256 key,
        uint64 feeSeed
    ) internal returns (bool) {
        if (!_ensurePendingAcceptance(key)) return false;
        uint64 nonce = _acceptanceNonce(key);
        Reservation.ReservationAction memory a = stack.reservationActionRecord(
            key,
            nonce
        );
        if (a.amount <= a.txMaxFee) return false;
        uint64 anchorAmount = a.amount - (feeSeed % (a.txMaxFee + 1));
        uint16 bps = vault().initiationFeeBps();
        uint256 feeTbtc =
            (uint256(anchorAmount) * SATOSHI_MULTIPLIER * bps) / 10_000;

        try
            stack.proveAcceptance(
                key,
                nonce,
                keccak256(abi.encodePacked("surfaceAnchor", nonce, key)),
                anchorAmount
            )
        returns (bool late) {
            ghostVaultTbtc += feeTbtc;
            // The settlement credits the deposit's own depositor, which for
            // a stack deposit is this handler.
            ghostDepositorTbtc[address(this)] +=
                uint256(anchorAmount) * SATOSHI_MULTIPLIER -
                feeTbtc;
            ghostRoutedSat += anchorAmount;
            ghostSupplyTbtc += uint256(anchorAmount) * SATOSHI_MULTIPLIER;
            successes[
                late ? "surfaceProveAcceptanceLate" : "surfaceProveAcceptance"
            ] += 1;
            recordTerminals(key);
            return true;
        } catch {
            return false;
        }
    }

    /// @dev Opens the position if it is not open yet.
    function _ensureOpenPosition(uint256 key) internal returns (bool) {
        if (
            stack.reservationRecord(key).state ==
            Reservation.ReservationState.Active
        ) {
            return true;
        }
        if (!_proveAcceptance(key, uint64(key))) return false;
        return
            stack.reservationRecord(key).state ==
            Reservation.ReservationState.Active;
    }

    /// @dev True when the latest generation is a re-anchor inside its signing
    ///      window.
    function _reanchorSignable(uint256 key) internal view returns (bool) {
        Reservation.ReservationRequest memory r = stack.reservationRecord(key);
        if (r.requestNonce == 0) return false;
        Reservation.ReservationAction memory a = stack.reservationActionRecord(
            key,
            r.requestNonce
        );
        return
            a.actionType == Reservation.ActionType.Reanchor &&
            a.state == Reservation.ActionState.Pending &&
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp < uint256(a.timeoutAt) - 2 hours;
    }

    /// @dev Issues a re-anchor authorization for `key` if there is none, and
    ///      refreshes one whose signing window has closed.
    function _ensurePendingReanchor(uint256 key) internal returns (bool) {
        if (_reanchorSignable(key)) return true;

        // A pending re-anchor whose signing window has closed leaves the
        // position in `ActionPending`, and the acceptance fallback in
        // `_ensureOpenPosition` cannot resolve that state: the position
        // holds a re-anchor generation, not an acceptance. The stale
        // generation is expired first, through the production recovery path,
        // so the position returns to `Active` and a fresh generation can be
        // issued.
        if (!_recoverStaleReanchor(key)) return false;
        if (!_ensureOpenPosition(key)) return false;

        Reservation.ReservationRequest memory r = stack.reservationRecord(key);
        bytes20 target = stackWallets[
            uint256(uint160(r.walletPubKeyHash)) % stackWallets.length
        ];
        if (target == r.walletPubKeyHash) {
            target = stackWallets[
                (uint256(uint160(r.walletPubKeyHash)) + 1) % stackWallets.length
            ];
        }
        // The target must be Live, and the campaign retires wallets, so the
        // first choice may no longer be one.
        if (stack.walletState(target) != Wallets.WalletState.Live) {
            bytes20 live = _liveWalletOtherThan(r.walletPubKeyHash);
            if (live == bytes20(0)) return false;
            target = live;
        }
        try stack.requestReservationReanchor(key, target, true) {} catch {
            return false;
        }
        return _reanchorSignable(key);
    }

    /// @dev Expires a pending re-anchor generation whose signing window has
    ///      closed. Returns true when there is nothing stale to recover from
    ///      or when the recovery went through. A position that is not in
    ///      `ActionPending`, or whose latest generation is not a pending
    ///      re-anchor, has nothing to recover.
    function _recoverStaleReanchor(uint256 key) internal returns (bool) {
        Reservation.ReservationRequest memory r = stack.reservationRecord(key);
        if (r.requestNonce == 0) return true;
        Reservation.ReservationAction memory a = stack.reservationActionRecord(
            key,
            r.requestNonce
        );
        if (
            a.actionType != Reservation.ActionType.Reanchor ||
            a.state != Reservation.ActionState.Pending
        ) {
            return true;
        }
        if (_reanchorSignable(key)) return true;

        // Move to the deadline so the timeout notification is legal, then
        // notify through the router, which is the production recovery path.
        /* solhint-disable-next-line not-rely-on-time */
        if (block.timestamp < uint256(a.timeoutAt)) vm.warp(a.timeoutAt);
        if (!_expireGeneration(key, Reservation.ActionType.Reanchor)) {
            return false;
        }
        successes["surfaceReanchorRecovered"] += 1;
        return true;
    }

    /// @dev The first Live wallet that is not `source`, or the zero value
    ///      when there is none.
    function _liveWalletOtherThan(
        bytes20 source
    ) internal view returns (bytes20) {
        for (uint256 i = 0; i < stackWallets.length; i++) {
            bytes20 candidate = stackWallets[i];
            if (
                candidate != source &&
                stack.walletState(candidate) == Wallets.WalletState.Live
            ) {
                return candidate;
            }
        }
        return bytes20(0);
    }

    /// @dev Settles the pending re-anchor of `key`.
    function _proveReanchor(
        uint256 key,
        uint64 feeSeed
    ) internal returns (bool) {
        if (!_ensurePendingReanchor(key)) return false;
        Reservation.ReservationRequest memory r = stack.reservationRecord(key);
        Reservation.ReservationAction memory a = stack.reservationActionRecord(
            key,
            r.requestNonce
        );
        if (a.amount <= a.txMaxFee) return false;
        uint64 newAmount = a.amount - (feeSeed % (a.txMaxFee + 1));
        uint64 minerFee = a.amount - newAmount;
        uint64 burnable = uint64(
            min(
                uint256(minerFee),
                tbtc().balanceOf(address(vault())) / SATOSHI_MULTIPLIER
            )
        );

        try
            stack.proveReanchor(
                key,
                r.requestNonce,
                keccak256(
                    abi.encodePacked("surfaceReanchor", r.requestNonce, key)
                ),
                newAmount
            )
        returns (bool late) {
            ghostVaultTbtc -= uint256(burnable) * SATOSHI_MULTIPLIER;
            ghostSupplyTbtc -= uint256(burnable) * SATOSHI_MULTIPLIER;
            ghostFeeDebtSat += minerFee - burnable;
            successes[
                late ? "surfaceProveReanchorLate" : "surfaceProveReanchor"
            ] += 1;
            recordTerminals(key);
            return true;
        } catch {
            return false;
        }
    }

    function _anchorProposal(
        uint256 key,
        uint64 requestNonce,
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
                requestNonce: requestNonce,
                anchorTxFee: anchorTxFee
            });
    }

    function _depositExtraInfo(
        uint256 key
    ) internal view returns (WalletProposalValidator.DepositExtraInfo memory) {
        (
            BitcoinTx.Info memory fundingTx,
            bytes8 blindingFactor,
            bytes20 walletPubKeyHash,
            bytes20 refundPubKeyHash,
            bytes4 refundLocktime
        ) = stack.depositFixture(key);
        return
            WalletProposalValidator.DepositExtraInfo({
                fundingTx: fundingTx,
                blindingFactor: blindingFactor,
                walletPubKeyHash: walletPubKeyHash,
                refundPubKeyHash: refundPubKeyHash,
                refundLocktime: refundLocktime
            });
    }

    function _tryValidateAnchor(
        WalletProposalValidator.ReservationAnchorProposal memory proposal,
        WalletProposalValidator.DepositExtraInfo memory extraInfo
    ) internal returns (bool) {
        try
            stack.validator().validateReservationAnchorProposal(
                proposal,
                extraInfo
            )
        returns (bool valid) {
            return valid;
        } catch {
            return false;
        }
    }

    function _tryValidateReanchor(
        WalletProposalValidator.ReservationReanchorProposal memory proposal
    ) internal returns (bool) {
        try
            stack.validator().validateReservationReanchorProposal(proposal)
        returns (bool valid) {
            return valid;
        } catch {
            return false;
        }
    }

    function stackKeyCount() external view returns (uint256) {
        return stackKeys.length;
    }

    function stackKeyAt(uint256 index) external view returns (uint256) {
        return stackKeys[index];
    }

    function stackWalletOf(uint256 key) external view returns (bytes20) {
        return stackKeyWallet[key];
    }

    /// @dev The state of the campaign wallet at `index`, so a deterministic
    ///      control can follow one wallet through its lifecycle.
    function stackWalletAt(
        uint256 index
    ) external view returns (bytes20 wallet, uint8 state) {
        wallet = stackWallets[index % stackWallets.length];
        state = uint8(stack.walletState(wallet));
    }

    /// @dev Tops up the vault's Bank balance to the satoshi a burn will
    ///      decrease. `receiveBalanceIncrease` moves the whole Bank credit
    ///      into the TBTC vault, so the Bank side of a burn has to come from
    ///      elsewhere; in production the vault keeps it from the deposits it
    ///      credits, here the harness funds it.
    function _fundBankSide(uint64 sat) internal {
        uint256 current = bank().balanceOf(address(vault()));
        if (current < sat) {
            stack.fundVaultBank(uint64(sat - current));
        }
    }

    function tbtc() internal view returns (TBTC) {
        return stack.tbtcToken();
    }

    function vault() internal view returns (ReservationVault) {
        return stack.reservationVault();
    }

    function bank() internal view returns (Bank) {
        return stack.bank();
    }

    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
