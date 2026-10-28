// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import "../Base.sol";
import {Properties} from "../Properties.sol";
import {Wallets} from "../../../contracts/bridge/Wallets.sol";

/// @notice Handles the interaction with Bank
abstract contract BankHandler is Properties {
    /// @dev Redemption request under construction (kept in a memory struct to
    ///      stay below the stack limit).
    struct bank_Redeem {
        bytes20 pkh;
        BitcoinTx.UTXO utxo;
        // Main UTXO value not committed to pending redemptions (sat).
        uint256 spare;
        address redeemer;
        bytes script;
        bytes data;
        // Requested redemption amount (sat).
        uint256 amount;
    }

    // ――――――――――――――――――――――――― Clamped ――――――――――――――――――――――――――

    /// @dev Spender is an actor, TBTCVault, ReservationVault, Bridge or the
    ///      treasury. `Bank.approveBalance` rejects non-atomic changes, so a
    ///      non-zero allowance can only be reset to zero; a zero allowance is
    ///      set to either `type(uint256).max` or a balance-sized value.
    function bank_approveBalance_clamped(
        uint256 spenderSeed,
        uint256 amount
    ) public {
        address spender = _bank_pickAddress(spenderSeed);
        if (bank.allowance(actor, spender) != 0) {
            amount = 0;
        } else if (amount % 2 == 0) {
            amount = type(uint256).max;
        } else {
            amount = clampBetween(amount, 1, bank.balanceOf(actor) + 1);
        }
        bank_approveBalance(spender, amount);
    }

    /// @dev `entropy` even: mint path (spender TBTCVault, amount in
    ///      `[1, balance]`). `entropy` odd: redemption path (spender Bridge,
    ///      amount in `[redemptionDust, min(balance, wallet spare funds)]`,
    ///      redemption data built from a Live harness wallet and its main UTXO).
    function bank_approveBalanceAndCall_clamped(
        uint256 amount,
        uint256 entropy
    ) public {
        if (entropy % 2 == 0) {
            _bank_approveAndMint(amount);
        } else {
            _bank_approveAndRedeem(amount, entropy >> 1);
        }
    }

    function bank_increaseBalanceAllowance_clamped(
        uint256 spenderSeed,
        uint256 addedValue
    ) public {
        address spender = _bank_pickAddress(spenderSeed);
        uint256 current = bank.allowance(actor, spender);
        if (current == type(uint256).max) return;
        addedValue = clampBetween(addedValue, 1, bank.balanceOf(actor) + 1);
        uint256 headroom = type(uint256).max - current;
        if (addedValue > headroom) addedValue = headroom;
        bank_increaseBalanceAllowance(spender, addedValue);
    }

    function bank_decreaseBalanceAllowance_clamped(
        uint256 spenderSeed,
        uint256 subtractedValue
    ) public {
        address spender = _bank_pickAddress(spenderSeed);
        uint256 current = bank.allowance(actor, spender);
        if (current == 0) return;
        subtractedValue = clampBetween(subtractedValue, 1, current);
        bank_decreaseBalanceAllowance(spender, subtractedValue);
    }

    function bank_transferBalance_clamped(
        uint256 recipientSeed,
        uint256 amount
    ) public {
        uint256 balance = bank.balanceOf(actor);
        if (balance == 0) return;
        amount = clampBetween(amount, 1, balance);
        bank_transferBalance(_bank_pickAddress(recipientSeed), amount);
    }

    /// @dev The balance owner is another actor. When its allowance for the
    ///      current actor is too small, the owner grants the missing part first.
    function bank_transferBalanceFrom_clamped(
        uint256 ownerSeed,
        uint256 recipientSeed,
        uint256 amount
    ) public {
        address owner = _bank_pickOtherActor(ownerSeed);
        uint256 balance = bank.balanceOf(owner);
        if (balance == 0) return;
        amount = clampBetween(amount, 1, balance);

        uint256 current = bank.allowance(owner, actor);
        if (current < amount) {
            vm.prank(owner);
            bank.increaseBalanceAllowance(actor, amount - current);
        }
        bank_transferBalanceFrom(
            owner,
            _bank_pickAddress(recipientSeed),
            amount
        );
    }

    // ―――――――――――――――――――― Stress / boundary variants ―――――――――――――――――――――

    /// @dev Moves the entire Bank balance of the actor in one transfer.
    function bank_transferBalance_full(uint256 recipientSeed) public {
        uint256 balance = bank.balanceOf(actor);
        if (balance == 0) return;
        bank_transferBalance(_bank_pickAddress(recipientSeed), balance);
    }

    /// @dev 0, 1 or 2 satoshi transfers.
    function bank_transferBalance_dust(
        uint256 recipientSeed,
        uint256 amount
    ) public {
        bank_transferBalance(_bank_pickAddress(recipientSeed), amount % 3);
    }

    /// @dev Pushes the allowance exactly to `type(uint256).max` (the
    ///      "infinite allowance" sentinel of `transferBalanceFrom`).
    function bank_increaseBalanceAllowance_toMax(uint256 spenderSeed) public {
        address spender = _bank_pickAddress(spenderSeed);
        uint256 current = bank.allowance(actor, spender);
        if (current == type(uint256).max) return;
        bank_increaseBalanceAllowance(spender, type(uint256).max - current);
    }

    /// @dev Converts the entire Bank balance into TBTC in one call.
    function bank_approveBalanceAndCall_fullMint() public {
        uint256 balance = bank.balanceOf(actor);
        if (balance == 0) return;
        bank_approveBalanceAndCall(address(tbtcVault), balance, "");
    }

    /// @dev Redemption request with amounts at the boundaries of the
    ///      redemption path: dust - 1, dust, wallet spare funds (+1), the
    ///      `uint64` maximum (+1) and the full Bank balance.
    function bank_approveBalanceAndCall_redeemBoundary(
        uint256 entropy,
        uint256 which
    ) public {
        bank_Redeem memory r;
        if (!_bank_selectWallet(r, entropy)) return;

        uint256 dust = _bank_redemptionDust();
        which = which % 7;
        if (which == 0) r.amount = dust == 0 ? 0 : dust - 1;
        else if (which == 1) r.amount = dust;
        else if (which == 2) r.amount = r.spare;
        else if (which == 3) r.amount = r.spare + 1;
        else if (which == 4) r.amount = type(uint64).max;
        else if (which == 5) r.amount = uint256(type(uint64).max) + 1;
        else r.amount = bank.balanceOf(actor);

        _bank_buildData(r, _bank_pickRedeemer(entropy >> 8), entropy >> 32);
        bank_approveBalanceAndCall(address(bridge), r.amount, r.data);
        // Reached only if the Bridge accepted the request (the amount then
        // fits in uint64: the Bridge casts with SafeCast).
        _recordRedemption(r.pkh, r.script, r.redeemer, uint64(r.amount));
    }

    // ―――――――――――――――――――――――― Donations ――――――――――――――――――――――――

    /// @dev Donation-style Bank balance transfer straight into TBTCVault,
    ///      ReservationVault or the Bridge (unaccounted balance that vault
    ///      and bridge bookkeeping do not expect).
    function bank_donateBalance(uint256 targetSeed, uint256 amount) public {
        uint256 balance = bank.balanceOf(actor);
        if (balance == 0) return;
        amount = clampBetween(amount, 1, balance);
        uint256 t = targetSeed % 3;
        address target =
            t == 0
                ? address(tbtcVault)
                : (t == 1 ? address(reservationVault) : address(bridge));
        bank_transferBalance(target, amount);
    }

    // ―――――――――――――――――――――――― Unclamped ―――――――――――――――――――――――――

    function bank_approveBalance(
        address spender,
        uint256 amount
    ) public asActor {
        _setFocus(0, bytes20(0), bytes20(0), spender, 0);
        snapshotBefore();
        stateBefore.focusAllowance = bank.allowance(actor, spender);

        bank.approveBalance(spender, amount);

        snapshotAfter();
        stateAfter.focusAllowance = bank.allowance(actor, spender);
        _tv_setOp(TvKind.BankApprove, actor, spender, amount);
        property_bankTransferExact();
        _tv_clearOp();
    }

    /// @dev Spender TBTCVault: mint (SP-01/07/08/15). Spender Bridge:
    ///      redemption request (SP-25..27 and the redemption ledgers). Any
    ///      other spender: plain call (SP-08).
    function bank_approveBalanceAndCall(
        address spender,
        uint256 amount,
        bytes memory extraData
    ) public asActor {
        if (spender == address(tbtcVault)) {
            _bank_mintViaCall(amount, extraData);
            return;
        }
        if (spender == address(bridge)) {
            _bank_redeemViaCall(amount, extraData);
            return;
        }
        _setFocus(0, bytes20(0), bytes20(0), _tv_otherActor(), 0);
        snapshotBefore();

        bank.approveBalanceAndCall(spender, amount, extraData);

        snapshotAfter();
        _tv_clearOp();
        property_noUnauthorizedBalanceChange();
    }

    function bank_increaseBalanceAllowance(
        address spender,
        uint256 addedValue
    ) public asActor {
        _setFocus(0, bytes20(0), bytes20(0), spender, 0);
        snapshotBefore();
        stateBefore.focusAllowance = bank.allowance(actor, spender);

        bank.increaseBalanceAllowance(spender, addedValue);

        snapshotAfter();
        stateAfter.focusAllowance = bank.allowance(actor, spender);
        _tv_setOp(TvKind.BankIncrease, actor, spender, addedValue);
        property_bankTransferExact();
        _tv_clearOp();
    }

    function bank_decreaseBalanceAllowance(
        address spender,
        uint256 subtractedValue
    ) public asActor {
        _setFocus(0, bytes20(0), bytes20(0), spender, 0);
        snapshotBefore();
        stateBefore.focusAllowance = bank.allowance(actor, spender);

        bank.decreaseBalanceAllowance(spender, subtractedValue);

        snapshotAfter();
        stateAfter.focusAllowance = bank.allowance(actor, spender);
        _tv_setOp(TvKind.BankDecrease, actor, spender, subtractedValue);
        property_bankTransferExact();
        _tv_clearOp();
    }

    function bank_transferBalance(
        address recipient,
        uint256 amount
    ) public asActor {
        _setFocus(0, bytes20(0), bytes20(0), recipient, 0);
        snapshotBefore();

        bank.transferBalance(recipient, amount);

        snapshotAfter();
        _tv_bankRecipientGhosts(recipient, amount);
        _tv_setOp(TvKind.BankTransfer, actor, recipient, amount);
        property_noValueCreationByActor();
        property_bankTransferExact();
        _tv_clearOp();
    }

    /// @dev `spender` is the Bank balance owner (Bank naming).
    function bank_transferBalanceFrom(
        address spender,
        address recipient,
        uint256 amount
    ) public asActor {
        _setFocus(0, bytes20(0), bytes20(0), spender, 0);
        snapshotBefore();

        bank.transferBalanceFrom(spender, recipient, amount);

        snapshotAfter();
        _tv_bankRecipientGhosts(recipient, amount);
        _tv_setOp(TvKind.BankTransferFrom, spender, recipient, amount);
        property_noValueCreationByActor();
        property_noUnauthorizedBalanceChange();
        property_bankTransferExact();
        _tv_clearOp();
    }

    // ―――――――――――――――――――――― Round trips ――――――――――――――――――――――

    /// @dev transferBalance(to, x) as the actor then back as `to`, and
    ///      increaseBalanceAllowance(to, x) then decreaseBalanceAllowance(to, x).
    ///      Balances and the actor's allowance for `to` must be restored.
    function bank_transferRoundTrip(
        uint256 recipientSeed,
        uint256 amount
    ) public {
        uint256 balance = bank.balanceOf(actor);
        if (balance == 0) return;
        amount = clampBetween(amount, 1, balance);
        address to = _bank_pickOtherActor(recipientSeed);

        _setFocus(0, bytes20(0), bytes20(0), to, 0);
        snapshotBefore();
        stateBefore.focusAllowance = bank.allowance(actor, to);

        vm.prank(actor);
        bank.transferBalance(to, amount);
        vm.prank(to);
        bank.transferBalance(actor, amount);

        uint256 current = bank.allowance(actor, to);
        if (
            current != type(uint256).max &&
            amount <= type(uint256).max - current
        ) {
            vm.prank(actor);
            bank.increaseBalanceAllowance(to, amount);
            vm.prank(actor);
            bank.decreaseBalanceAllowance(to, amount);
        }

        snapshotAfter();
        stateAfter.focusAllowance = bank.allowance(actor, to);
        property_bankTransferRoundTrip();
    }

    // ―――――――――――――――――――――――― Internals ――――――――――――――――――――――――

    /// @dev Bank.approveBalanceAndCall(tbtcVault, amount) mints
    ///      `amount * 1e10` TBTC (SP-01).
    function _bank_mintViaCall(
        uint256 amount,
        bytes memory extraData
    ) internal {
        _setFocus(0, bytes20(0), bytes20(0), _tv_otherActor(), 0);
        snapshotBefore();

        bank.approveBalanceAndCall(address(tbtcVault), amount, extraData);

        snapshotAfter();
        ghosts.lastFuzzedAmount = amount * SATOSHI_MULTIPLIER;
        _tv_setOp(TvKind.Mint, actor, address(0), amount * SATOSHI_MULTIPLIER);
        property_mintExact();
        property_noValueCreationByActor();
        property_noUnauthorizedBalanceChange();
        property_optimisticDebtAttribution();
        _tv_refreshOptDebt();
        _tv_clearOp();
    }

    /// @dev Bank.approveBalanceAndCall(bridge, amount, redemptionData): the
    ///      Bank balance owner is the actor. The call is wrapped so that a
    ///      revert of a well-formed request is reported by SP-27.
    function _bank_redeemViaCall(uint256 amount, bytes memory data) internal {
        if (_tv_pendingRedemptionCount() >= FIZZ_SCAN_CAP) return;

        TvRedeem memory r = _tv_redeemBefore(
            actor,
            _tv_otherActor(),
            amount,
            data
        );
        snapshotBefore();
        r.pre = _tv_redeemPre(r, true);

        try bank.approveBalanceAndCall(address(bridge), amount, data) {} catch {
            _tv_redeemBlocked(r);
        }

        snapshotAfter();
        _tv_setOp(TvKind.None, actor, address(0), amount);
        tvOp.key = r.key;
        _tv_redeemAfter(r);
        property_noUnauthorizedBalanceChange();
        _tv_redeemProps();
        _tv_redeemRefresh(r);
        _tv_clearOp();
    }

    function _bank_approveAndMint(uint256 amount) internal {
        uint256 balance = bank.balanceOf(actor);
        if (balance == 0) return;
        amount = clampBetween(amount, 1, balance);
        bank_approveBalanceAndCall(address(tbtcVault), amount, "");
    }

    function _bank_approveAndRedeem(uint256 amount, uint256 entropy) internal {
        bank_Redeem memory r;
        if (!_bank_selectWallet(r, entropy)) return;

        uint256 dust = _bank_redemptionDust();
        uint256 cap = bank.balanceOf(actor);
        if (cap > r.spare) cap = r.spare;
        if (cap < dust || cap == 0) return;
        r.amount = clampBetween(amount, dust == 0 ? 1 : dust, cap);

        _bank_buildData(r, _bank_pickRedeemer(entropy >> 8), entropy >> 32);
        bank_approveBalanceAndCall(address(bridge), r.amount, r.data);
        _recordRedemption(r.pkh, r.script, r.redeemer, uint64(r.amount));
    }

    /// @dev Actors, TBTCVault, ReservationVault, Bridge and the treasury.
    function _bank_pickAddress(uint256 seed) internal view returns (address) {
        uint256 n = actors.length;
        uint256 i = seed % (n + 4);
        if (i < n) return actors[i];
        if (i == n) return address(tbtcVault);
        if (i == n + 1) return address(reservationVault);
        if (i == n + 2) return address(bridge);
        return treasury;
    }

    function _bank_pickOtherActor(
        uint256 seed
    ) internal view returns (address) {
        uint256 n = actors.length;
        address picked = actors[seed % n];
        if (picked == actor) picked = actors[((seed % n) + 1) % n];
        return picked;
    }

    /// @dev Mostly the actor itself (balance owner == redeemer); otherwise
    ///      another actor (rebate-authorization mismatch path).
    function _bank_pickRedeemer(uint256 seed) internal view returns (address) {
        if (seed % 3 == 0) return actors[(seed >> 8) % actors.length];
        return actor;
    }

    function _bank_redemptionDust() internal view returns (uint256 dust) {
        (uint64 dustThreshold, , , , , , ) = bridge.redemptionParameters();
        dust = dustThreshold;
    }

    /// @dev Picks the first Live harness wallet (starting from a fuzzed
    ///      position) whose recorded main UTXO matches the Bridge's
    ///      `mainUtxoHash`, and fills `r.pkh`, `r.utxo` and `r.spare`.
    function _bank_selectWallet(
        bank_Redeem memory r,
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

    /// @dev Length-prefixed standard output script (P2PKH, P2WPKH, P2SH or
    ///      P2WSH), unique per fuzz seed and redemption count.
    function _bank_redeemerScript(
        uint256 seed,
        bytes20 walletPkh
    ) internal view returns (bytes memory) {
        bytes32 h = keccak256(
            abi.encode("fizz.bank.redeemer", seed, harnessRedemptions.length)
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

    /// @dev Fills `r.redeemer`, `r.script` and `r.data`. The data matches
    ///      `Redemption.requestRedemption`:
    ///      (address redeemer, bytes20 walletPubKeyHash, bytes32 mainUtxoTxHash,
    ///       uint32 mainUtxoTxOutputIndex, uint64 mainUtxoTxOutputValue,
    ///       bytes redeemerOutputScript).
    function _bank_buildData(
        bank_Redeem memory r,
        address redeemer,
        uint256 scriptSeed
    ) internal view {
        r.redeemer = redeemer;
        r.script = _bank_redeemerScript(scriptSeed, r.pkh);
        r.data = abi.encode(
            redeemer,
            r.pkh,
            r.utxo.txHash,
            r.utxo.txOutputIndex,
            r.utxo.txOutputValue,
            r.script
        );
    }
}
