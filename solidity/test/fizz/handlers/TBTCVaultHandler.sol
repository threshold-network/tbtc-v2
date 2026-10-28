// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import "../Base.sol";
import {Properties} from "../Properties.sol";
import {Wallets} from "../../../contracts/bridge/Wallets.sol";
import {Deposit as TvVaultDeposit} from "../../../contracts/bridge/Deposit.sol";

/// @notice Handles the interaction with TBTCVault
abstract contract TBTCVaultHandler is Properties {
    /// @dev Redemption request under construction (kept in a memory struct to
    ///      stay below the stack limit).
    struct tBTCVault_Redeem {
        bytes20 pkh;
        BitcoinTx.UTXO utxo;
        // Main UTXO value not committed to pending redemptions (sat).
        uint256 spare;
        bytes script;
        bytes data;
        // TBTC amount passed to `unmintAndRedeem` (1e18 precision, may carry a
        // sub-satoshi remainder).
        uint256 tbtcAmount;
    }

    /// @dev An optimistic minting request accepted by TBTCVault, with the
    ///      index of the matching `harnessDeposits` entry.
    struct tBTCVault_OptimisticRequest {
        bytes32 fundingTxHash;
        uint32 outputIndex;
        uint256 harnessIndex;
    }

    /// @dev Every deposit for which `requestOptimisticMint` succeeded (each
    ///      deposit key at most once; the request may have been cancelled or
    ///      finalized since: always re-read the vault state).
    tBTCVault_OptimisticRequest[] internal tBTCVault_optimisticRequests;
    mapping(uint256 => bool) internal tBTCVault_requestTracked;

    // ――――――――――――――――――――――――― Clamped ――――――――――――――――――――――――――

    /// @dev Amount in `[1 sat, bank balance]` (TBTC units, may carry a
    ///      sub-satoshi remainder that `mint` truncates). The actor's Bank
    ///      allowance for the vault is topped up when too small.
    function tBTCVault_mint_clamped(uint256 amount) public {
        uint256 balance = bank.balanceOf(actor);
        if (balance == 0) return;
        amount = clampBetween(
            amount,
            SATOSHI_MULTIPLIER,
            balance * SATOSHI_MULTIPLIER
        );
        _tBTCVault_ensureBankAllowance(amount / SATOSHI_MULTIPLIER);
        tBTCVault_mint(amount);
    }

    /// @dev Amount in `[1 wei, TBTC balance]`; the actor's TBTC allowance for
    ///      the vault is topped up when too small.
    function tBTCVault_unmint_clamped(uint256 amount) public {
        uint256 balance = tbtc.balanceOf(actor);
        if (balance == 0) return;
        amount = clampBetween(amount, 1, balance);
        _tBTCVault_ensureTbtcAllowance(amount);
        tBTCVault_unmint(amount);
    }

    /// @dev Amount in `[redemptionDust, min(balance / 1e10, wallet spare
    ///      funds)]` sat, plus a sub-satoshi remainder when affordable.
    ///      Redemption data is built from a Live harness wallet with a main
    ///      UTXO and the redeemer equals the actor (as the vault requires).
    ///      The redemption is recorded only after the call succeeded.
    function tBTCVault_unmintAndRedeem_clamped(
        uint256 amount,
        uint256 entropy
    ) public {
        tBTCVault_Redeem memory r;
        if (!_tBTCVault_selectWallet(r, entropy)) return;

        uint256 balance = tbtc.balanceOf(actor);
        uint256 dust = _tBTCVault_redemptionDust();
        uint256 cap = balance / SATOSHI_MULTIPLIER;
        if (cap > r.spare) cap = r.spare;
        if (cap < dust || cap == 0) return;

        uint256 sats = clampBetween(amount, dust == 0 ? 1 : dust, cap);
        r.tbtcAmount = sats * SATOSHI_MULTIPLIER;
        uint256 rem = (entropy >> 64) % SATOSHI_MULTIPLIER;
        if (r.tbtcAmount + rem <= balance) r.tbtcAmount += rem;

        _tBTCVault_buildData(r, entropy >> 32);
        _tBTCVault_redeem(r);
    }

    /// @dev Picks a revealed, unswept deposit routed to TBTCVault that has no
    ///      open request, and requests an optimistic mint for it as a live
    ///      minter. Tracks the request on success.
    function tBTCVault_requestOptimisticMint_clamped(
        uint256 minterSeed,
        uint256 depositSeed
    ) public {
        if (tbtcVault.isOptimisticMintingPaused()) return;
        (bool minterFound, uint256 seed) = _tBTCVault_liveMinterSeed(
            minterSeed
        );
        if (!minterFound) return;

        (bool found, uint256 i) = _tBTCVault_findDepositToRequest(depositSeed);
        if (!found) return;

        bytes32 txHash = harnessDeposits[i].fundingTxHash;
        uint32 outputIndex = harnessDeposits[i].outputIndex;
        tBTCVault_requestOptimisticMint(seed, txHash, outputIndex);

        uint256 key = tbtcVault.calculateDepositKey(txHash, outputIndex);
        if (!tBTCVault_requestTracked[key]) {
            tBTCVault_requestTracked[key] = true;
            tBTCVault_optimisticRequests.push(
                tBTCVault_OptimisticRequest({
                    fundingTxHash: txHash,
                    outputIndex: outputIndex,
                    harnessIndex: i
                })
            );
        }
    }

    /// @dev Finalizes a tracked request whose delay has passed and whose
    ///      deposit is not swept yet, as a live minter.
    function tBTCVault_finalizeOptimisticMint_clamped(
        uint256 minterSeed,
        uint256 requestSeed
    ) public {
        if (tbtcVault.isOptimisticMintingPaused()) return;
        (bool minterFound, uint256 seed) = _tBTCVault_liveMinterSeed(
            minterSeed
        );
        if (!minterFound) return;
        (bool found, uint256 i) = _tBTCVault_findRequest(requestSeed, true);
        if (!found) return;

        tBTCVault_OptimisticRequest memory q = tBTCVault_optimisticRequests[i];
        tBTCVault_finalizeOptimisticMint(seed, q.fundingTxHash, q.outputIndex);
    }

    /// @dev Cancels a tracked, not yet finalized request as a live guardian.
    function tBTCVault_cancelOptimisticMint_clamped(
        uint256 guardianSeed,
        uint256 requestSeed
    ) public {
        (bool guardianFound, uint256 seed) = _tBTCVault_liveGuardianSeed(
            guardianSeed
        );
        if (!guardianFound) return;
        (bool found, uint256 i) = _tBTCVault_findRequest(requestSeed, false);
        if (!found) return;

        tBTCVault_OptimisticRequest memory q = tBTCVault_optimisticRequests[i];
        tBTCVault_cancelOptimisticMint(seed, q.fundingTxHash, q.outputIndex);
    }

    // ―――――――――――――――――――― Stress / boundary variants ―――――――――――――――――――――

    /// @dev Converts the actor's entire Bank balance.
    function tBTCVault_mint_full() public {
        uint256 balance = bank.balanceOf(actor);
        if (balance == 0) return;
        _tBTCVault_ensureBankAllowance(balance);
        tBTCVault_mint(balance * SATOSHI_MULTIPLIER);
    }

    /// @dev Sub-satoshi mint amount (< 1e10 wei): converts to 0 TBTC.
    function tBTCVault_mint_subSatoshi(uint256 amount) public {
        tBTCVault_mint(_tBTCVault_dustAmount(amount, SATOSHI_MULTIPLIER - 1));
    }

    /// @dev Unmints the actor's entire TBTC balance (a sub-satoshi remainder,
    ///      if any, stays behind).
    function tBTCVault_unmint_full() public {
        uint256 balance = tbtc.balanceOf(actor);
        if (balance == 0) return;
        _tBTCVault_ensureTbtcAllowance(balance);
        tBTCVault_unmint(balance);
    }

    /// @dev Sub-satoshi unmint amount (< 1e10 wei): burns and credits nothing.
    function tBTCVault_unmint_subSatoshi(uint256 amount) public {
        uint256 balance = tbtc.balanceOf(actor);
        if (balance == 0) return;
        uint256 dustAmount = _tBTCVault_dustAmount(amount, balance);
        _tBTCVault_ensureTbtcAllowance(dustAmount);
        tBTCVault_unmint(dustAmount);
    }

    /// @dev Redemption amounts at the boundaries: sub-satoshi, dust - 1 sat,
    ///      exactly dust, the full affordable amount (with and without a
    ///      sub-satoshi remainder) and one satoshi above the wallet's spare
    ///      funds.
    function tBTCVault_unmintAndRedeem_boundary(
        uint256 entropy,
        uint256 which
    ) public {
        tBTCVault_Redeem memory r;
        if (!_tBTCVault_selectWallet(r, entropy)) return;

        uint256 balance = tbtc.balanceOf(actor);
        uint256 dust = _tBTCVault_redemptionDust();
        uint256 cap = balance / SATOSHI_MULTIPLIER;
        if (cap > r.spare) cap = r.spare;

        which = which % 6;
        if (which == 0)
            r.tbtcAmount =
                balance < SATOSHI_MULTIPLIER - 1
                    ? balance
                    : SATOSHI_MULTIPLIER - 1;
        else if (which == 1)
            r.tbtcAmount = (dust == 0 ? 0 : dust - 1) * SATOSHI_MULTIPLIER;
        else if (which == 2) r.tbtcAmount = dust * SATOSHI_MULTIPLIER;
        else if (which == 3) r.tbtcAmount = cap * SATOSHI_MULTIPLIER;
        else if (which == 4)
            r.tbtcAmount =
                cap * SATOSHI_MULTIPLIER +
                ((balance - cap * SATOSHI_MULTIPLIER) % SATOSHI_MULTIPLIER);
        else r.tbtcAmount = (r.spare + 1) * SATOSHI_MULTIPLIER;

        _tBTCVault_buildData(r, entropy >> 32);
        _tBTCVault_redeem(r);
    }

    // ―――――――――――――――――――――― Round trips / probes ――――――――――――――――――――――

    /// @dev N (1..5) cycles of mint(x) then unmint(x), x in
    ///      `[1, bank * 1e10 + 1e10 - 1]` (remainders included). Net effect
    ///      must be zero (SP-04).
    function tBTCVault_mintUnmintRoundTrip(
        uint256 amount,
        uint256 cycles
    ) public {
        uint256 balance = bank.balanceOf(actor);
        if (balance == 0) return;
        amount = clampBetween(
            amount,
            1,
            balance * SATOSHI_MULTIPLIER + SATOSHI_MULTIPLIER - 1
        );
        cycles = clampBetween(cycles, 1, 5);
        _tBTCVault_maxAllowances();

        _setFocus(0, bytes20(0), bytes20(0), address(0), 0);
        snapshotBefore();
        for (uint256 i; i < cycles; i++) {
            vm.prank(actor);
            tbtcVault.mint(amount);
            vm.prank(actor);
            tbtcVault.unmint(amount);
        }
        snapshotAfter();
        property_mintUnmintRoundTripNoProfit();
    }

    /// @dev Bank.approveBalanceAndCall(tbtcVault, sat) then
    ///      TBTC.approveAndCall(tbtcVault, sat * 1e10); the mint leg must
    ///      credit exactly `sat * 1e10` TBTC (SP-05); allowances are restored
    ///      to the maximum afterwards.
    function tBTCVault_approveCallRoundTrip(uint256 amount) public {
        uint256 balance = bank.balanceOf(actor);
        if (balance == 0) return;
        uint256 sat = clampBetween(amount, 1, balance);
        uint256 tbtcWei = sat * SATOSHI_MULTIPLIER;

        _setFocus(0, bytes20(0), bytes20(0), address(0), 0);
        snapshotBefore();
        uint256 tbtcBefore = tbtc.balanceOf(actor);

        vm.prank(actor);
        bank.approveBalanceAndCall(address(tbtcVault), sat, "");
        eq(
            tbtc.balanceOf(actor),
            tbtcBefore + tbtcWei,
            "SP-05: approveBalanceAndCall mint leg did not credit sat*1e10 TBTC"
        );

        vm.prank(actor);
        tbtc.approveAndCall(address(tbtcVault), tbtcWei, "");

        snapshotAfter();
        _tBTCVault_maxAllowances();
        property_approveCallRoundTrip();
    }

    /// @dev x = x % 1e10: mint(x); unmint(x) change nothing, unmintAndRedeem(x)
    ///      is rejected, repayInKindFeeDebt(0) is rejected and sweepFees with
    ///      no debt and no excess reserve does not revert (SP-06).
    function tBTCVault_zeroAndDustSafe(uint256 x, uint256 seed) public {
        x = x % SATOSHI_MULTIPLIER;
        _tBTCVault_maxAllowances();

        bytes memory data = abi.encode(
            actor,
            bytes20(0),
            bytes32(0),
            uint32(0),
            uint64(0),
            bytes("")
        );
        tBTCVault_Redeem memory r;
        if (_tBTCVault_selectWallet(r, seed)) {
            _tBTCVault_buildData(r, seed >> 32);
            data = r.data;
        }
        (uint64 dust, , , , , , ) = bridge.redemptionParameters();
        bool sweepProbe =
            reservationVault.inKindFeeDebtSat() == 0 &&
                tbtc.balanceOf(address(reservationVault)) <=
                    reservationVault.feeReserveTarget();

        _setFocus(0, bytes20(0), bytes20(0), address(0), 0);
        snapshotBefore();

        vm.prank(actor);
        try tbtcVault.mint(x) {} catch {}
        vm.prank(actor);
        try tbtcVault.unmint(x) {} catch {}
        if (dust > 0) {
            vm.prank(actor);
            try tbtcVault.unmintAndRedeem(x, data) {
                t(false, "SP-06: unmintAndRedeem of a dust amount succeeded");
            } catch {}
        }
        vm.prank(actor);
        try reservationVault.repayInKindFeeDebt(0) {
            t(false, "SP-06: repayInKindFeeDebt(0) succeeded");
        } catch {}
        if (sweepProbe) {
            vm.prank(governance);
            try reservationVault.sweepFees(treasury) {} catch {
                t(
                    false,
                    "SP-06: sweepFees reverted with zero debt and no excess reserve"
                );
            }
        }

        snapshotAfter();
        property_zeroAndDustSafe();
    }

    /// @dev Maximum Bank and TBTC allowance of the actor for the vault.
    function _tBTCVault_maxAllowances() internal {
        uint256 current = bank.allowance(actor, address(tbtcVault));
        if (current != type(uint256).max) {
            vm.prank(actor);
            bank.increaseBalanceAllowance(
                address(tbtcVault),
                type(uint256).max - current
            );
        }
        if (tbtc.allowance(actor, address(tbtcVault)) != type(uint256).max) {
            vm.prank(actor);
            tbtc.approve(address(tbtcVault), type(uint256).max);
        }
    }

    // ―――――――――――――――――――――――― Donations ――――――――――――――――――――――――

    /// @dev Donation-style Bank balance transfer into TBTCVault (Bank
    ///      balance without minted TBTC behind it).
    function tBTCVault_donateBankBalance(uint256 amount) public {
        uint256 balance = bank.balanceOf(actor);
        if (balance == 0) return;
        amount = clampBetween(amount, 1, balance);

        _setFocus(0, bytes20(0), bytes20(0), address(0), 0);
        snapshotBefore();
        vm.prank(actor);
        bank.transferBalance(address(tbtcVault), amount);
        snapshotAfter();

        ghosts.bankDonatedToTbtcVaultSat += amount;
        ghosts.anyDonation = true;
        property_noValueCreationByActor();
    }

    /// @dev Donation-style TBTC transfer into TBTCVault.
    function tBTCVault_donateTBTC(uint256 amount) public {
        uint256 balance = tbtc.balanceOf(actor);
        if (balance == 0) return;
        amount = clampBetween(amount, 1, balance);

        _setFocus(0, bytes20(0), bytes20(0), address(0), 0);
        snapshotBefore();
        vm.prank(actor);
        tbtc.transfer(address(tbtcVault), amount);
        snapshotAfter();

        ghosts.anyDonation = true;
        property_noValueCreationByActor();
    }

    // ――――――――――――――――――――――― Secondary dispatcher ――――――――――――――――――――――

    /// @dev Governance-side functions. `arg0` / `arg1` feed the selected
    ///      function: add/remove minter/guardian choose a target from the
    ///      Base `minters` / `guardians` arrays (or `arg1` itself) and never
    ///      leave fewer than one of the Base accounts registered; fee divisor
    ///      is bounded to `[0, 10_000]` and delay to `[0, 2 days]`.
    function tBTCVault_secondary(
        uint8 selector,
        uint256 arg0,
        address arg1
    ) public {
        selector = uint8(selector % 10);
        _setFocus(0, bytes20(0), bytes20(0), address(0), 0);
        snapshotBefore();

        if (selector == 0) _tBTCVault_pauseOptimisticMinting();
        else if (selector == 1) _tBTCVault_unpauseOptimisticMinting();
        else if (selector == 2) _tBTCVault_addMinter(arg0, arg1);
        else if (selector == 3) _tBTCVault_removeMinter(arg0, arg1);
        else if (selector == 4) _tBTCVault_addGuardian(arg0, arg1);
        else if (selector == 5) _tBTCVault_removeGuardian(arg0, arg1);
        else if (selector == 6)
            _tBTCVault_beginOptimisticMintingFeeUpdate(uint32(arg0 % 10_001));
        else if (selector == 7) _tBTCVault_finalizeOptimisticMintingFeeUpdate();
        else if (selector == 8)
            _tBTCVault_beginOptimisticMintingDelayUpdate(
                uint32(arg0 % (2 days + 1))
            );
        else _tBTCVault_finalizeOptimisticMintingDelayUpdate();

        snapshotAfter();
        if (selector == 0)
            _tv_setOp(TvKind.GovPause, address(0), address(0), 0);
        else if (selector == 1)
            _tv_setOp(TvKind.GovUnpause, address(0), address(0), 0);
        else if (selector == 6)
            _tv_setOp(
                TvKind.GovBeginFee,
                address(0),
                address(0),
                arg0 % 10_001
            );
        else if (selector == 7)
            _tv_setOp(TvKind.GovFinalizeFee, address(0), address(0), 0);
        else if (selector == 8)
            _tv_setOp(
                TvKind.GovBeginDelay,
                address(0),
                address(0),
                arg0 % (2 days + 1)
            );
        else if (selector == 9)
            _tv_setOp(TvKind.GovFinalizeDelay, address(0), address(0), 0);
        else _tv_clearOp();
        property_optimisticPauseAndStaging();
        _tv_clearOp();
        property_noPrivilegeEscalation();
        property_lifecycleRolesEnforced();
        property_guardianMinterPowersGated();
    }

    // ―――――――――――――――――――――――― Unclamped ―――――――――――――――――――――――――

    function tBTCVault_mint(uint256 amount) public asActor {
        _setFocus(0, bytes20(0), bytes20(0), _tv_otherActor(), 0);
        snapshotBefore();

        tbtcVault.mint(amount);

        snapshotAfter();
        ghosts.lastFuzzedAmount = amount;
        _tv_setOp(TvKind.Mint, actor, address(0), amount);
        property_mintExact();
        property_noValueCreationByActor();
        property_noUnauthorizedBalanceChange();
        property_optimisticDebtAttribution();
        _tv_refreshOptDebt();
        _tv_clearOp();
    }

    function tBTCVault_unmint(uint256 amount) public asActor {
        _setFocus(0, bytes20(0), bytes20(0), _tv_otherActor(), 0);
        snapshotBefore();

        tbtcVault.unmint(amount);

        snapshotAfter();
        ghosts.lastFuzzedAmount = amount;
        _tv_setOp(TvKind.Unmint, actor, address(0), amount);
        property_unmintExact();
        property_noValueCreationByActor();
        property_noUnauthorizedBalanceChange();
        property_optimisticDebtAttribution();
        _tv_refreshOptDebt();
        _tv_clearOp();
    }

    /// @dev The Bank balance owner of the redemption request is TBTCVault.
    function tBTCVault_unmintAndRedeem(
        uint256 amount,
        bytes memory redemptionData
    ) public asActor {
        if (_tv_pendingRedemptionCount() >= FIZZ_SCAN_CAP) return;

        uint256 sat = amount / SATOSHI_MULTIPLIER;
        TvRedeem memory r = _tv_redeemBefore(
            address(tbtcVault),
            _tv_otherActor(),
            sat,
            redemptionData
        );
        snapshotBefore();
        r.pre = _tv_redeemPre(
            r,
            r.redeemer == actor &&
                tbtc.balanceOf(actor) >= sat * SATOSHI_MULTIPLIER &&
                tbtc.allowance(actor, address(tbtcVault)) >=
                    sat * SATOSHI_MULTIPLIER
        );

        try tbtcVault.unmintAndRedeem(amount, redemptionData) {} catch {
            _tv_redeemBlocked(r);
        }

        snapshotAfter();
        ghosts.lastFuzzedAmount = amount;
        _tv_setOp(TvKind.UnmintRedeem, address(tbtcVault), address(0), sat);
        tvOp.key = r.key;
        _tv_redeemAfter(r);
        property_unmintAndRedeemExact();
        property_noValueCreationByActor();
        property_noUnauthorizedBalanceChange();
        property_optimisticDebtAttribution();
        _tv_redeemProps();
        _tv_redeemRefresh(r);
        _tv_refreshOptDebt();
        _tv_clearOp();
    }

    function tBTCVault_requestOptimisticMint(
        uint256 minterSeed,
        bytes32 fundingTxHash,
        uint32 fundingOutputIndex
    ) public asMinter(minterSeed) {
        _setFocus(0, bytes20(0), bytes20(0), address(0), 0);
        snapshotBefore();

        tbtcVault.requestOptimisticMint(fundingTxHash, fundingOutputIndex);

        snapshotAfter();
        _tv_setOp(TvKind.OptRequest, address(0), address(0), 0);
        property_optimisticRequestMachine();
        property_optimisticPauseAndStaging();
        _tv_advanceOptShadows();
        _tv_clearOp();
    }

    function tBTCVault_finalizeOptimisticMint(
        uint256 minterSeed,
        bytes32 fundingTxHash,
        uint32 fundingOutputIndex
    ) public asMinter(minterSeed) {
        // SP-17 needs the complete set of finalized keys: admission control.
        if (ghosts.omFinalizedKeys.length >= FIZZ_SCAN_CAP) return;

        uint256 key = tbtcVault.calculateDepositKey(
            fundingTxHash,
            fundingOutputIndex
        );
        TvVaultDeposit.DepositRequest memory d = bridge.deposits(key);
        uint256 minted =
            d.amount >= d.treasuryFee
                ? (uint256(d.amount) - uint256(d.treasuryFee)) *
                    SATOSHI_MULTIPLIER
                : 0;

        _setFocus(key, bytes20(0), bytes20(0), d.depositor, 0);
        snapshotBefore();

        tbtcVault.finalizeOptimisticMint(fundingTxHash, fundingOutputIndex);

        snapshotAfter();
        ghosts.omFinalizedKeys.push(key);
        _tv_setOp(TvKind.OptFinalize, address(0), address(0), minted);
        tvOp.key = key;
        property_finalizeOptimisticMintExact();
        property_optimisticRequestMachine();
        property_optimisticDebtAttribution();
        property_optimisticPauseAndStaging();
        property_optimisticDebtBounded();
        _tv_advanceOptShadows();
        _tv_refreshOptDebt();
        _tv_clearOp();
    }

    function tBTCVault_cancelOptimisticMint(
        uint256 guardianSeed,
        bytes32 fundingTxHash,
        uint32 fundingOutputIndex
    ) public asGuardian(guardianSeed) {
        _setFocus(0, bytes20(0), bytes20(0), address(0), 0);
        snapshotBefore();

        tbtcVault.cancelOptimisticMint(fundingTxHash, fundingOutputIndex);

        snapshotAfter();
        _tv_setOp(TvKind.OptCancel, address(0), address(0), 0);
        property_optimisticRequestMachine();
        property_optimisticPauseAndStaging();
        _tv_advanceOptShadows();
        _tv_clearOp();
    }

    function _tBTCVault_pauseOptimisticMinting() internal asGovernance {
        tbtcVault.pauseOptimisticMinting();
    }

    function _tBTCVault_unpauseOptimisticMinting() internal asGovernance {
        tbtcVault.unpauseOptimisticMinting();
    }

    /// @dev `pick` selects the minter (a Base minter or `raw`).
    function _tBTCVault_addMinter(
        uint256 pick,
        address raw
    ) internal asGovernance {
        tbtcVault.addMinter(_tBTCVault_pickMinter(pick, raw));
    }

    /// @dev `pick` bit 0: caller is a guardian instead of governance (the
    ///      contract allows owner or guardian); remaining bits select the
    ///      minter. Skipped when it would unregister the last Base minter.
    function _tBTCVault_removeMinter(uint256 pick, address raw) internal {
        address minter = _tBTCVault_pickMinter(pick >> 1, raw);
        if (_tBTCVault_isLastBaseMinter(minter)) return;

        address caller = governance;
        if ((pick & 1) == 1) {
            (bool guardianFound, uint256 seed) = _tBTCVault_liveGuardianSeed(
                pick >> 8
            );
            if (guardianFound) caller = guardians[seed % guardians.length];
        }
        vm.prank(caller);
        tbtcVault.removeMinter(minter);
    }

    function _tBTCVault_addGuardian(
        uint256 pick,
        address raw
    ) internal asGovernance {
        tbtcVault.addGuardian(_tBTCVault_pickGuardian(pick, raw));
    }

    /// @dev Skipped when it would unregister the last Base guardian.
    function _tBTCVault_removeGuardian(uint256 pick, address raw) internal {
        address guardian = _tBTCVault_pickGuardian(pick, raw);
        if (_tBTCVault_isLastBaseGuardian(guardian)) return;

        vm.prank(governance);
        tbtcVault.removeGuardian(guardian);
    }

    /// @dev Divisor bounded to `[0, 10_000]` (0 disables the fee).
    function _tBTCVault_beginOptimisticMintingFeeUpdate(
        uint32 _newOptimisticMintingFeeDivisor
    ) internal asGovernance {
        tbtcVault.beginOptimisticMintingFeeUpdate(
            uint32(uint256(_newOptimisticMintingFeeDivisor) % 10_001)
        );
    }

    function _tBTCVault_finalizeOptimisticMintingFeeUpdate()
        internal
        asGovernance
    {
        tbtcVault.finalizeOptimisticMintingFeeUpdate();
    }

    /// @dev Delay bounded to `[0, 2 days]`, well within the time Medusa can
    ///      advance over a few calls.
    function _tBTCVault_beginOptimisticMintingDelayUpdate(
        uint32 _newOptimisticMintingDelay
    ) internal asGovernance {
        tbtcVault.beginOptimisticMintingDelayUpdate(
            uint32(uint256(_newOptimisticMintingDelay) % (2 days + 1))
        );
    }

    function _tBTCVault_finalizeOptimisticMintingDelayUpdate()
        internal
        asGovernance
    {
        tbtcVault.finalizeOptimisticMintingDelayUpdate();
    }

    // ―――――――――――――――――――――――― Internals ――――――――――――――――――――――――

    /// @dev Tops the actor's Bank allowance for the vault up to at least
    ///      `sats` (`increaseBalanceAllowance`: `approveBalance` rejects
    ///      non-atomic changes).
    function _tBTCVault_ensureBankAllowance(uint256 sats) internal {
        uint256 current = bank.allowance(actor, address(tbtcVault));
        if (current >= sats) return;
        vm.prank(actor);
        bank.increaseBalanceAllowance(
            address(tbtcVault),
            type(uint256).max - current
        );
    }

    /// @dev Tops the actor's TBTC allowance for the vault up to at least
    ///      `amount`.
    function _tBTCVault_ensureTbtcAllowance(uint256 amount) internal {
        if (tbtc.allowance(actor, address(tbtcVault)) >= amount) return;
        vm.prank(actor);
        tbtc.approve(address(tbtcVault), type(uint256).max);
    }

    /// @dev Sub-satoshi amount in `[1, min(cap, SATOSHI_MULTIPLIER - 1)]`
    ///      biased to its two ends. `cap` must be non-zero.
    function _tBTCVault_dustAmount(
        uint256 raw,
        uint256 cap
    ) internal returns (uint256) {
        uint256 hi =
            cap < SATOSHI_MULTIPLIER - 1 ? cap : SATOSHI_MULTIPLIER - 1;
        uint256 mode = raw % 3;
        if (mode == 0) return 1;
        if (mode == 1) return hi;
        return clampBetween(raw, 1, hi);
    }

    /// @dev Unmint-and-redeem of `r.tbtcAmount` through the vault; the
    ///      redemption is recorded only if the call did not revert.
    function _tBTCVault_redeem(tBTCVault_Redeem memory r) internal {
        _tBTCVault_ensureTbtcAllowance(r.tbtcAmount);
        tBTCVault_unmintAndRedeem(r.tbtcAmount, r.data);
        _recordRedemption(
            r.pkh,
            r.script,
            actor,
            uint64(r.tbtcAmount / SATOSHI_MULTIPLIER)
        );
    }

    function _tBTCVault_redemptionDust() internal view returns (uint256 dust) {
        (uint64 dustThreshold, , , , , , ) = bridge.redemptionParameters();
        dust = dustThreshold;
    }

    /// @dev Picks the first Live harness wallet (starting from a fuzzed
    ///      position) whose recorded main UTXO matches the Bridge's
    ///      `mainUtxoHash`, and fills `r.pkh`, `r.utxo` and `r.spare`.
    function _tBTCVault_selectWallet(
        tBTCVault_Redeem memory r,
        uint256 seed
    ) internal view returns (bool) {
        uint256 n = harnessWallets.length;
        for (uint256 k; k < n; k++) {
            bytes20 w = harnessWallets[((seed % n) + k) % n];
            BitcoinTx.UTXO memory u = harnessMainUtxo[w];
            if (u.txHash == bytes32(0)) continue;
            Wallets.Wallet memory info = bridge.wallets(w);
            if (info.state != Wallets.WalletState.Live) continue;
            if (
                info.mainUtxoHash !=
                keccak256(
                    abi.encodePacked(u.txHash, u.txOutputIndex, u.txOutputValue)
                )
            ) continue;
            if (info.pendingRedemptionsValue > u.txOutputValue) continue;
            r.pkh = w;
            r.utxo = u;
            r.spare = uint256(u.txOutputValue) - info.pendingRedemptionsValue;
            return true;
        }
        return false;
    }

    /// @dev Fills `r.script` and `r.data`. The data matches
    ///      `Redemption.requestRedemption`:
    ///      (address redeemer, bytes20 walletPubKeyHash, bytes32 mainUtxoTxHash,
    ///       uint32 mainUtxoTxOutputIndex, uint64 mainUtxoTxOutputValue,
    ///       bytes redeemerOutputScript); the redeemer is the actor, as
    ///      `TBTCVault._unmintAndRedeem` requires the decoded redeemer to
    ///      equal the TBTC burner.
    function _tBTCVault_buildData(
        tBTCVault_Redeem memory r,
        uint256 scriptSeed
    ) internal view {
        r.script = _tBTCVault_redeemerScript(scriptSeed, r.pkh);
        r.data = abi.encode(
            actor,
            r.pkh,
            r.utxo.txHash,
            r.utxo.txOutputIndex,
            r.utxo.txOutputValue,
            r.script
        );
    }

    /// @dev Length-prefixed standard output script (P2PKH, P2WPKH, P2SH or
    ///      P2WSH), unique per fuzz seed and redemption count.
    function _tBTCVault_redeemerScript(
        uint256 seed,
        bytes20 walletPkh
    ) internal view returns (bytes memory) {
        bytes32 h = keccak256(
            abi.encode(
                "fizz.tbtcVault.redeemer",
                seed,
                harnessRedemptions.length
            )
        );
        bytes20 h20 = bytes20(h);
        if (h20 == walletPkh) h20 = bytes20(keccak256(abi.encode(h)));
        uint256 kind = seed % 4;
        bytes memory script;
        if (kind == 0) script = BtcBuilder.p2pkh(h20);
        else if (kind == 1) script = BtcBuilder.p2wpkh(h20);
        else if (kind == 2) script = BtcBuilder.p2sh(h20);
        else script = BtcBuilder.p2wsh(h);
        return bytes.concat(bytes1(uint8(script.length)), script);
    }

    /// @dev First Base minter (from a fuzzed position) that is still
    ///      registered in the vault, as a seed for `asMinter`.
    function _tBTCVault_liveMinterSeed(
        uint256 seed
    ) internal view returns (bool, uint256) {
        uint256 n = minters.length;
        for (uint256 k; k < n; k++) {
            uint256 s = (seed % n) + k;
            if (tbtcVault.isMinter(minters[s % n])) return (true, s);
        }
        return (false, 0);
    }

    /// @dev First Base guardian (from a fuzzed position) that is still
    ///      registered in the vault, as a seed for `asGuardian`.
    function _tBTCVault_liveGuardianSeed(
        uint256 seed
    ) internal view returns (bool, uint256) {
        uint256 n = guardians.length;
        for (uint256 k; k < n; k++) {
            uint256 s = (seed % n) + k;
            if (tbtcVault.isGuardian(guardians[s % n])) return (true, s);
        }
        return (false, 0);
    }

    /// @dev First harness deposit (from a fuzzed position) that is routed to
    ///      TBTCVault, not swept and has no open optimistic minting request.
    function _tBTCVault_findDepositToRequest(
        uint256 seed
    ) internal view returns (bool, uint256) {
        uint256 n = harnessDeposits.length;
        for (uint256 k; k < n && k < 64; k++) {
            uint256 i = ((seed % n) + k) % n;
            if (
                harnessDeposits[i].vault != address(tbtcVault) ||
                harnessDeposits[i].swept
            ) continue;
            (uint64 requestedAt, ) = tbtcVault.optimisticMintingRequests(
                tbtcVault.calculateDepositKey(
                    harnessDeposits[i].fundingTxHash,
                    harnessDeposits[i].outputIndex
                )
            );
            if (requestedAt == 0) return (true, i);
        }
        return (false, 0);
    }

    /// @dev Tracked request (from a fuzzed position) that is open (requested,
    ///      not finalized); with `requireMature` also past the minting delay
    ///      and with an unswept deposit.
    function _tBTCVault_findRequest(
        uint256 seed,
        bool requireMature
    ) internal view returns (bool, uint256) {
        uint256 n = tBTCVault_optimisticRequests.length;
        for (uint256 k; k < n && k < 32; k++) {
            uint256 i = ((seed % n) + k) % n;
            tBTCVault_OptimisticRequest
                storage q = tBTCVault_optimisticRequests[i];
            (uint64 requestedAt, uint64 finalizedAt) = tbtcVault
                .optimisticMintingRequests(
                    tbtcVault.calculateDepositKey(
                        q.fundingTxHash,
                        q.outputIndex
                    )
                );
            if (requestedAt == 0 || finalizedAt != 0) continue;
            if (requireMature) {
                if (
                    block.timestamp <=
                    uint256(requestedAt) + tbtcVault.optimisticMintingDelay()
                ) continue;
                if (harnessDeposits[q.harnessIndex].swept) continue;
            }
            return (true, i);
        }
        return (false, 0);
    }

    /// @dev A Base minter, or `raw` when `pick` lands on the extra slot.
    function _tBTCVault_pickMinter(
        uint256 pick,
        address raw
    ) internal view returns (address) {
        uint256 n = minters.length;
        uint256 i = pick % (n + 1);
        return i == n ? raw : minters[i];
    }

    /// @dev A Base guardian, or `raw` when `pick` lands on the extra slot.
    function _tBTCVault_pickGuardian(
        uint256 pick,
        address raw
    ) internal view returns (address) {
        uint256 n = guardians.length;
        uint256 i = pick % (n + 1);
        return i == n ? raw : guardians[i];
    }

    /// @dev True when `minter` is the only Base minter still registered.
    function _tBTCVault_isLastBaseMinter(
        address minter
    ) internal view returns (bool) {
        if (!tbtcVault.isMinter(minter)) return false;
        bool isBase;
        uint256 live;
        for (uint256 i; i < minters.length; i++) {
            if (minters[i] == minter) isBase = true;
            if (tbtcVault.isMinter(minters[i])) live++;
        }
        return isBase && live <= 1;
    }

    /// @dev True when `guardian` is the only Base guardian still registered.
    function _tBTCVault_isLastBaseGuardian(
        address guardian
    ) internal view returns (bool) {
        if (!tbtcVault.isGuardian(guardian)) return false;
        bool isBase;
        uint256 live;
        for (uint256 i; i < guardians.length; i++) {
            if (guardians[i] == guardian) isBase = true;
            if (tbtcVault.isGuardian(guardians[i])) live++;
        }
        return isBase && live <= 1;
    }
}
