// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import "../Base.sol";
import {Properties} from "../Properties.sol";
import {Wallets} from "../../../contracts/bridge/Wallets.sol";

/// @notice Handles the interaction with TBTC
abstract contract TBTCHandler is Properties {
    /// @dev Redemption request under construction (kept in a memory struct to
    ///      stay below the stack limit).
    struct tBTC_Redeem {
        bytes20 pkh;
        BitcoinTx.UTXO utxo;
        // Main UTXO value not committed to pending redemptions (sat).
        uint256 spare;
        bytes script;
        bytes data;
        // Requested redemption amount (sat).
        uint256 sats;
        // TBTC amount passed to the vault (1e18 precision, may carry a
        // sub-satoshi remainder).
        uint256 tbtcAmount;
    }

    // ――――――――――――――――――――――――― Clamped ――――――――――――――――――――――――――

    function tBTC_transfer_clamped(
        uint256 recipientSeed,
        uint256 amount
    ) public {
        uint256 balance = tbtc.balanceOf(actor);
        if (balance == 0) return;
        amount = clampBetween(amount, 1, balance);
        tBTC_transfer(_tBTC_pickRecipient(recipientSeed), amount);
    }

    /// @dev Token owner is another actor; when its allowance for the current
    ///      actor is too small the owner approves the amount first.
    function tBTC_transferFrom_clamped(
        uint256 ownerSeed,
        uint256 recipientSeed,
        uint256 amount
    ) public {
        address owner = _tBTC_pickOtherActor(ownerSeed);
        uint256 balance = tbtc.balanceOf(owner);
        if (balance == 0) return;
        amount = clampBetween(amount, 1, balance);
        if (tbtc.allowance(owner, actor) < amount) {
            vm.prank(owner);
            tbtc.approve(actor, amount);
        }
        tBTC_transferFrom(owner, _tBTC_pickRecipient(recipientSeed), amount);
    }

    /// @dev Spender is an actor, TBTCVault or ReservationVault. Amount is 0,
    ///      `type(uint256).max` or a balance-sized value.
    function tBTC_approve_clamped(uint256 spenderSeed, uint256 amount) public {
        address spender = _tBTC_pickSpender(spenderSeed);
        uint256 mode = amount % 4;
        if (mode == 0) amount = 0;
        else if (mode == 1) amount = type(uint256).max;
        else amount = clampBetween(amount, 1, tbtc.balanceOf(actor) + 1);
        tBTC_approve(spender, amount);
    }

    /// @dev Spender is always TBTCVault. `entropy` even: plain unmint (empty
    ///      extraData). `entropy` odd: unmint-and-redeem with redemption data
    ///      built from a Live harness wallet and its main UTXO (falls back to
    ///      a plain unmint when no wallet can serve the amount). The
    ///      redemption is recorded only after the call succeeded.
    function tBTC_approveAndCall_clamped(
        uint256 amount,
        uint256 entropy
    ) public {
        uint256 balance = tbtc.balanceOf(actor);
        if (balance == 0) return;

        if (entropy % 2 == 1) {
            tBTC_Redeem memory r;
            if (_tBTC_prepareRedeem(r, amount, entropy >> 1, balance)) {
                tBTC_approveAndCall(address(tbtcVault), r.tbtcAmount, r.data);
                _recordRedemption(r.pkh, r.script, actor, uint64(r.sats));
                return;
            }
        }

        amount = clampBetween(amount, 1, balance);
        tBTC_approveAndCall(address(tbtcVault), amount, "");
    }

    function tBTC_burn_clamped(uint256 amount) public {
        uint256 balance = tbtc.balanceOf(actor);
        if (balance == 0) return;
        amount = clampBetween(amount, 1, balance);
        tBTC_burn(amount);
    }

    function tBTC_burnFrom_clamped(uint256 ownerSeed, uint256 amount) public {
        address owner = _tBTC_pickOtherActor(ownerSeed);
        uint256 balance = tbtc.balanceOf(owner);
        if (balance == 0) return;
        amount = clampBetween(amount, 1, balance);
        if (tbtc.allowance(owner, actor) < amount) {
            vm.prank(owner);
            tbtc.approve(actor, amount);
        }
        tBTC_burnFrom(owner, amount);
    }

    // ―――――――――――――――――――― Stress / boundary variants ―――――――――――――――――――――

    /// @dev Sub-satoshi (< 1e10 wei) transfers: 1 wei, the largest
    ///      sub-satoshi amount, or a value in between.
    function tBTC_transfer_subSatoshi(
        uint256 recipientSeed,
        uint256 amount
    ) public {
        uint256 balance = tbtc.balanceOf(actor);
        if (balance == 0) return;
        tBTC_transfer(
            _tBTC_pickRecipient(recipientSeed),
            _tBTC_dustAmount(amount, balance)
        );
    }

    function tBTC_transfer_full(uint256 recipientSeed) public {
        uint256 balance = tbtc.balanceOf(actor);
        if (balance == 0) return;
        tBTC_transfer(_tBTC_pickRecipient(recipientSeed), balance);
    }

    function tBTC_burn_subSatoshi(uint256 amount) public {
        uint256 balance = tbtc.balanceOf(actor);
        if (balance == 0) return;
        tBTC_burn(_tBTC_dustAmount(amount, balance));
    }

    function tBTC_burn_full() public {
        uint256 balance = tbtc.balanceOf(actor);
        if (balance == 0) return;
        tBTC_burn(balance);
    }

    // ―――――――――――――――――――――――― Donations ――――――――――――――――――――――――

    /// @dev Donation-style TBTC transfer into TBTCVault, ReservationVault,
    ///      the Bridge or the treasury.
    function tBTC_donateERC20(uint256 targetSeed, uint256 amount) public {
        uint256 balance = tbtc.balanceOf(actor);
        if (balance == 0) return;
        amount = clampBetween(amount, 1, balance);
        uint256 t = targetSeed % 4;
        address target =
            t == 0
                ? address(tbtcVault)
                : (
                    t == 1
                        ? address(reservationVault)
                        : (t == 2 ? address(bridge) : treasury)
                );
        tBTC_transfer(target, amount);
        ghosts.anyDonation = true;
    }

    // ―――――――――――――――――――――――― Unclamped ―――――――――――――――――――――――――

    function tBTC_transfer(address recipient, uint256 amount) public asActor {
        _setFocus(0, bytes20(0), bytes20(0), recipient, 0);
        snapshotBefore();
        stateBefore.focusAllowance = 0;

        tbtc.transfer(recipient, amount);

        snapshotAfter();
        stateAfter.focusAllowance = 0;
        _tv_tbtcRecipientGhosts(recipient, amount);
        _tv_setOp(TvKind.TbtcTransfer, actor, recipient, amount);
        property_noValueCreationByActor();
        property_tbtcTransferExact();
        _tv_clearOp();
    }

    /// @dev `spender` is the TBTC owner (token naming: the account whose
    ///      tokens are moved).
    function tBTC_transferFrom(
        address spender,
        address recipient,
        uint256 amount
    ) public asActor {
        _setFocus(0, bytes20(0), bytes20(0), spender, 0);
        snapshotBefore();
        stateBefore.focusAllowance = tbtc.allowance(spender, actor);

        tbtc.transferFrom(spender, recipient, amount);

        snapshotAfter();
        stateAfter.focusAllowance = tbtc.allowance(spender, actor);
        _tv_tbtcRecipientGhosts(recipient, amount);
        _tv_setOp(TvKind.TbtcTransferFrom, spender, recipient, amount);
        property_noValueCreationByActor();
        property_noUnauthorizedBalanceChange();
        property_tbtcTransferExact();
        _tv_clearOp();
    }

    function tBTC_approve(address spender, uint256 amount) public asActor {
        tbtc.approve(spender, amount);
    }

    /// @dev Spender TBTCVault with empty extraData: unmint (SP-02/07/08/15).
    ///      Spender TBTCVault with redemption data: unmintAndRedeem (SP-03
    ///      and the redemption properties). Any other spender: plain call.
    function tBTC_approveAndCall(
        address spender,
        uint256 amount,
        bytes memory extraData
    ) public asActor {
        if (spender == address(tbtcVault)) {
            if (extraData.length == 0) {
                _tBTC_unmintViaCall(amount);
            } else {
                _tBTC_redeemViaCall(amount, extraData);
            }
            return;
        }
        tbtc.approveAndCall(spender, amount, extraData);
    }

    function tBTC_burn(uint256 amount) public asActor {
        _setFocus(0, bytes20(0), bytes20(0), address(0), 0);
        snapshotBefore();
        uint256 burnedBefore = ghosts.tbtcBurnedDirectWei;

        tbtc.burn(amount);

        snapshotAfter();
        ghosts.tbtcBurnedDirectWei += amount;
        _tv_setOp(TvKind.TbtcBurn, actor, address(0), amount);
        tvOp.aux = burnedBefore;
        property_noValueCreationByActor();
        property_tbtcBurnNoBankRelease();
        _tv_clearOp();
    }

    function tBTC_burnFrom(address account, uint256 amount) public asActor {
        _setFocus(0, bytes20(0), bytes20(0), account, 0);
        snapshotBefore();
        stateBefore.focusAllowance = tbtc.allowance(account, actor);
        uint256 burnedBefore = ghosts.tbtcBurnedDirectWei;

        tbtc.burnFrom(account, amount);

        snapshotAfter();
        stateAfter.focusAllowance = tbtc.allowance(account, actor);
        ghosts.tbtcBurnedDirectWei += amount;
        _tv_setOp(TvKind.TbtcBurnFrom, account, address(0), amount);
        tvOp.aux = burnedBefore;
        property_noValueCreationByActor();
        property_noUnauthorizedBalanceChange();
        property_tbtcBurnNoBankRelease();
        _tv_clearOp();
    }

    /// @dev Unmint through approveAndCall(tbtcVault, amount, "") (SP-02).
    function _tBTC_unmintViaCall(uint256 amount) internal {
        _setFocus(0, bytes20(0), bytes20(0), _tv_otherActor(), 0);
        snapshotBefore();

        tbtc.approveAndCall(address(tbtcVault), amount, "");

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

    /// @dev Unmint-and-redeem through approveAndCall(tbtcVault, amount, data).
    ///      The Bank balance owner of the request is TBTCVault.
    function _tBTC_redeemViaCall(uint256 amount, bytes memory data) internal {
        if (_tv_pendingRedemptionCount() >= FIZZ_SCAN_CAP) return;

        uint256 sat = amount / SATOSHI_MULTIPLIER;
        TvRedeem memory r = _tv_redeemBefore(
            address(tbtcVault),
            _tv_otherActor(),
            sat,
            data
        );
        snapshotBefore();
        r.pre = _tv_redeemPre(
            r,
            r.redeemer == actor &&
                tbtc.balanceOf(actor) >= sat * SATOSHI_MULTIPLIER
        );

        try tbtc.approveAndCall(address(tbtcVault), amount, data) {} catch {
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

    // ―――――――――――――――――――――――― Internals ――――――――――――――――――――――――

    /// @dev Actors, TBTCVault, ReservationVault, Bridge and the treasury.
    function _tBTC_pickRecipient(uint256 seed) internal view returns (address) {
        uint256 n = actors.length;
        uint256 i = seed % (n + 4);
        if (i < n) return actors[i];
        if (i == n) return address(tbtcVault);
        if (i == n + 1) return address(reservationVault);
        if (i == n + 2) return address(bridge);
        return treasury;
    }

    /// @dev Actors, TBTCVault and ReservationVault.
    function _tBTC_pickSpender(uint256 seed) internal view returns (address) {
        uint256 n = actors.length;
        uint256 i = seed % (n + 2);
        if (i < n) return actors[i];
        if (i == n) return address(tbtcVault);
        return address(reservationVault);
    }

    function _tBTC_pickOtherActor(
        uint256 seed
    ) internal view returns (address) {
        uint256 n = actors.length;
        address picked = actors[seed % n];
        if (picked == actor) picked = actors[((seed % n) + 1) % n];
        return picked;
    }

    /// @dev Sub-satoshi amount in `[1, min(cap, SATOSHI_MULTIPLIER - 1)]`
    ///      biased to its two ends. `cap` must be non-zero.
    function _tBTC_dustAmount(
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

    function _tBTC_redemptionDust() internal view returns (uint256 dust) {
        (uint64 dustThreshold, , , , , , ) = bridge.redemptionParameters();
        dust = dustThreshold;
    }

    /// @dev Fills `r` for an unmint-and-redeem of the actor's TBTC: wallet,
    ///      main UTXO, amounts (in `[dust, min(balance / 1e10, spare)]` sat,
    ///      plus a sub-satoshi remainder when affordable), script and
    ///      redemption data (redeemer == actor, as TBTCVault requires).
    ///      Returns false when no Live wallet can serve a dust-sized request.
    function _tBTC_prepareRedeem(
        tBTC_Redeem memory r,
        uint256 amount,
        uint256 entropy,
        uint256 tbtcBalance
    ) internal returns (bool) {
        if (!_tBTC_selectWallet(r, entropy)) return false;

        uint256 dust = _tBTC_redemptionDust();
        uint256 cap = tbtcBalance / SATOSHI_MULTIPLIER;
        if (cap > r.spare) cap = r.spare;
        if (cap < dust || cap == 0) return false;

        r.sats = clampBetween(amount, dust == 0 ? 1 : dust, cap);
        r.tbtcAmount = r.sats * SATOSHI_MULTIPLIER;
        uint256 rem = (entropy >> 64) % SATOSHI_MULTIPLIER;
        if (r.tbtcAmount + rem <= tbtcBalance) r.tbtcAmount += rem;

        r.script = _tBTC_redeemerScript(entropy >> 32, r.pkh);
        r.data = abi.encode(
            actor,
            r.pkh,
            r.utxo.txHash,
            r.utxo.txOutputIndex,
            r.utxo.txOutputValue,
            r.script
        );
        return true;
    }

    /// @dev Picks the first Live harness wallet (starting from a fuzzed
    ///      position) whose recorded main UTXO matches the Bridge's
    ///      `mainUtxoHash`, and fills `r.pkh`, `r.utxo` and `r.spare`.
    function _tBTC_selectWallet(
        tBTC_Redeem memory r,
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
    function _tBTC_redeemerScript(
        uint256 seed,
        bytes20 walletPkh
    ) internal view returns (bytes memory) {
        bytes32 h = keccak256(
            abi.encode("fizz.tbtc.redeemer", seed, harnessRedemptions.length)
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
}
