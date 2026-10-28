// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import {Snapshots} from "./Snapshots.sol";
import {vm} from "./utils/Hevm.sol";
import {Wallets as GlWallets} from "../../contracts/bridge/Wallets.sol";
import {BitcoinTx as PeBitcoinTx} from "../../contracts/bridge/BitcoinTx.sol";
import {BtcBuilder as PeBtcBuilder} from "./utils/BtcBuilder.sol";
import {Reservation as PeReservation} from "../../contracts/bridge/Reservation.sol";
import {Deposit as BrDeposit} from "../../contracts/bridge/Deposit.sol";
import {Redemption as BrRedemption} from "../../contracts/bridge/Redemption.sol";
import {Wallets as BrWallets} from "../../contracts/bridge/Wallets.sol";
import {MovingFunds as BrMovingFunds} from "../../contracts/bridge/MovingFunds.sol";
import {Fraud as BrFraud} from "../../contracts/bridge/Fraud.sol";
import {EnumerableSet as BrEnumerableSet} from "./utils/EnumerableSet.sol";
import {Reservation as RsReservation} from "../../contracts/bridge/Reservation.sol";
import {vm as RsVm} from "./utils/Hevm.sol";
import {Wallets as TvWallets} from "../../contracts/bridge/Wallets.sol";
import {Deposit as TvDeposit} from "../../contracts/bridge/Deposit.sol";
import {Redemption as TvRedemption} from "../../contracts/bridge/Redemption.sol";
import {EnumerableSet as TvEnumerableSet} from "./utils/EnumerableSet.sol";

/// @notice Shared harness state and the bookkeeping helpers the handlers call.
abstract contract Properties is Snapshots {
    enum TvKind {
        None,
        Mint,
        Unmint,
        UnmintRedeem,
        BankTransfer,
        BankTransferFrom,
        BankApprove,
        BankIncrease,
        BankDecrease,
        TbtcTransfer,
        TbtcTransferFrom,
        TbtcBurn,
        TbtcBurnFrom,
        OptRequest,
        OptFinalize,
        OptCancel,
        GovPause,
        GovUnpause,
        GovBeginFee,
        GovFinalizeFee,
        GovBeginDelay,
        GovFinalizeDelay
    }

    struct TvOp {
        TvKind kind;
        // Balance owner / source of the move (transfers, burns, redemptions).
        address owner;
        // Receiver of the move (transfers).
        address recipient;
        // Amount of the operation (unit depends on `kind`).
        uint256 amount;
        // Redemption key / deposit key of the operation.
        uint256 key;
        // Free slot: ghost value read before the operation.
        uint256 aux;
        // All preconditions of the redemption request held.
        bool pre;
        // The redemption request reverted.
        bool reverted;
    }

    TvOp internal tvOp;

    function _tv_clearOp() internal {
        delete tvOp;
    }

    function _tv_refreshOptDebt() internal {
        for (uint256 i; i < actors.length; i++) {
            ghosts.prevOptDebt[actors[i]] = tbtcVault.optimisticMintingDebt(
                actors[i]
            );
        }
    }

    /// @dev True when two live rebate grants of the same staker share the
    ///      current timestamp (cancelRebate aliasing).
    function _tv_sameBlockRebate() internal view returns (bool) {
        uint256 n = ghosts.rebateGrants.length;
        for (uint256 i; i < n; i++) {
            RebateGrant storage gi = ghosts.rebateGrants[i];
            if (!gi.live || gi.timestamp != uint32(block.timestamp)) continue;
            for (uint256 j = i + 1; j < n; j++) {
                RebateGrant storage gj = ghosts.rebateGrants[j];
                if (
                    gj.live &&
                    gj.timestamp == gi.timestamp &&
                    gj.staker == gi.staker
                ) return true;
            }
        }
        return false;
    }
    uint8 internal constant bridge_FK_SUBMIT = 1;

    struct bridge_Range {
        uint64 out;
        uint64 redeemable;
        uint64 maxFee;
    }

    struct bridge_Hook {
        // Hook kinds.
        uint8 movingKind;
        uint8 sweepKind;
        uint8 fraudKind;
        // Probes (`try/catch` around a protocol call that must not revert).
        bool probePre;
        bool probeReverted;
        bool honestReverted;
        bool honestSettled;
        // The actor is the staker of the rebate (no delegation, direct caller).
        bool directRebate;
        // Wallet registration.
        bytes32 walletId;
        // Main UTXO consumed by the call.
        bytes32 oldMainTxHash;
        uint32 oldMainIndex;
        uint64 oldMainValue;
        // Main UTXO created by the call (change output / sweep output).
        bytes32 newMainTxHash;
        uint32 newMainIndex;
        uint64 newMainValue;
        // Deposit sweep.
        bool sweepOk;
        bool sweepViaTbtcVault;
        bool sweepTrusted;
        uint256 sweepFee;
        uint256 sumAmount;
        uint256 sumTreasuryFee;
        address bridgeTreasury;
        uint256 treasuryBankBefore;
        // Redemption proof.
        bool redOk;
        uint256 sumReq;
        uint256 sumFee;
        uint256 sumBurn;
        uint256 sumTimedOut;
        // Moving funds / moved funds sweeps.
        uint256 mfTotal;
        uint256 mfFirstIdx;
        uint256 mfCount;
        uint256 sweepKey;
        uint256 mainValue;
        uint256 seizeBefore;
        bytes32 commitBefore;
        // Fraud challenge under test.
        uint256 fraudKey;
        uint256 fraudValue;
        uint32 fraudReportedAt;
        // The call was the permissionless resetMovingFundsTimeout.
        bool timeoutReset;
    }

    bridge_Hook internal bridge_hook;
    /// @dev Deposit keys of a sweep (input order) / pending requests proven by a redemption proof.
    uint256[] internal bridge_hookKeys;
    /// @dev Distinct depositors of a sweep with their aggregated credit (sat) and pre-call balances.
    address[] internal bridge_hookDepositors;
    uint256[] internal bridge_hookCredit;
    uint256[] internal bridge_hookDebt;
    uint256[] internal bridge_hookTbtc;
    uint256[] internal bridge_hookBank;
    bridge_Range[] internal bridge_hookRanges;
    /// @dev `pendingMovedFundsSweepRequestsCount` of `harnessWallets[i]` before the call.
    uint32[] internal bridge_hookPendSweeps;
    /// @dev Non-reserved deposit keys revealed through BridgeHandler (reserved keys live in `ghosts.reservedDepositKeys`).
    uint256[] internal bridge_revealedKeys;
    uint256 internal constant _resProp_P_TOTAL = 6;

    /// @dev Rotating start of the per-call key window (advanced by the
    ///      reservation hub of the handlers, never by a property).
    uint256 internal _resProp_cursor;
    /// @dev Precondition of a proof that reverted; set by the
    ///      handler right before the NeverBlocked property in the catch path.
    bool internal _resProp_probePre;
    /// @dev Reservation flows: reservationTotalAmount before the acceptance request.
    bool internal _resProp_flowBaseSet;
    uint64 internal _resProp_flowTotalBase;

    function _resProp_cap(uint256 n) internal pure returns (uint256) {
        return n > FIZZ_SCAN_CAP ? FIZZ_SCAN_CAP : n;
    }

    /// @dev Word `index` of `reservationParameters()` (raw read avoids a
    ///      10-value stack destructuring).
    function _resProp_param(
        uint256 index
    ) internal view returns (uint256 value) {
        (bool ok, bytes memory ret) = address(reservationRouter).staticcall(
            abi.encodeWithSelector(
                reservationRouter.reservationParameters.selector
            )
        );
        require(ok && ret.length >= 320, "resProp: parameters read failed");
        // solhint-disable-next-line no-inline-assembly
        assembly {
            value := mload(add(add(ret, 32), mul(index, 32)))
        }
    }

    function _resProp_anchorKey(
        bytes32 txHash,
        uint32 outputIndex
    ) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(txHash, outputIndex)));
    }

    function _resProp_actionImageKey(
        uint256 key,
        uint64 nonce
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(key, nonce));
    }

    /// @dev Hash of every request-time snapshot field of a generation (all
    ///      fields but `state`).
    function _resProp_actionImage(
        uint256 key,
        uint64 nonce
    ) internal view returns (bytes32) {
        RsReservation.ReservationAction memory a = reservationRouter
            .reservationActions(key, nonce);
        bytes32 h1 = keccak256(
            abi.encode(
                a.targetWalletPubKeyHash,
                a.requestedAt,
                a.timeoutAt,
                a.txMaxFee,
                uint8(a.actionType),
                a.feePaid,
                a.redeemer
            )
        );
        bytes32 h2 = keccak256(
            abi.encode(
                a.actionDataHash,
                a.sourceAnchorUtxoHash,
                a.amount,
                a.termSeconds,
                a.dissolutionDelay,
                a.minAmount
            )
        );
        return keccak256(abi.encode(h1, h2));
    }

    function _resProp_acceptedImage(
        RsReservation.ReservationRequest memory r
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    r.owner,
                    r.acceptedAt,
                    r.expiresAt,
                    r.dissolutionEligibleAt
                )
            );
    }

    /// @dev Keys checked by the per-key shadow properties: the focus
    ///      reservation (if any) plus a `FIZZ_CURSOR_STEP` window of
    ///      `harnessReservationKeys` starting at the cursor.
    function _resProp_windowKeys()
        internal
        view
        returns (uint256[] memory keys)
    {
        uint256 n = _resProp_cap(harnessReservationKeys.length);
        uint256 step = n < FIZZ_CURSOR_STEP ? n : FIZZ_CURSOR_STEP;
        keys = new uint256[](step + 1);
        uint256 count;
        uint256 fk = focus.resKey;
        if (fk != 0) {
            keys[count++] = fk;
        }
        uint256 start = n == 0 ? 0 : _resProp_cursor % n;
        for (uint256 j; j < step; j++) {
            uint256 k = harnessReservationKeys[(start + j) % n];
            if (k != fk) {
                keys[count++] = k;
            }
        }
        // solhint-disable-next-line no-inline-assembly
        assembly {
            mstore(keys, count)
        }
    }

    /// @dev Window start / size over a ghost array of length `len`.
    function _resProp_window(
        uint256 len
    ) internal view returns (uint256 start, uint256 size) {
        uint256 n = _resProp_cap(len);
        size = n < FIZZ_CURSOR_STEP ? n : FIZZ_CURSOR_STEP;
        start = n == 0 ? 0 : _resProp_cursor % n;
    }

    /// @dev Mirror of `RebateStaking.getStaker`: the address whose stake is
    ///      credited with the rebate of `user`.
    function _peripheral_stakerOf(
        address user
    ) internal view returns (address) {
        address delegator = rebateStaking.delegates(user);
        if (rebateStaking.getStake(user) == 0 && delegator != address(0)) {
            return delegator;
        }
        return user;
    }

    /// @dev Refreshes `ghosts.prevRebateLen` / `ghosts.prevRebateFeeSum` of
    ///      every actor. Called by handlers AFTER the history check.
    function _peripheral_refreshRebateShadow() internal {
        for (uint256 i; i < actors.length; i++) {
            address a = actors[i];
            uint256 len = rebateStaking.getRebateLength(a);
            uint256 n = len < FIZZ_SCAN_CAP ? len : FIZZ_SCAN_CAP;
            uint256 sum;
            for (uint256 j; j < n; j++) {
                (, uint64 fee) = rebateStaking.getRebate(a, j);
                sum += fee;
            }
            ghosts.prevRebateLen[a] = len;
            ghosts.prevRebateFeeSum[a] = sum;
        }
    }

    // ── end Peripheral shard ──
}
