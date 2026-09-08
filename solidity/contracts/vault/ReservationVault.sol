// SPDX-License-Identifier: GPL-3.0-only

// ██████████████     ▐████▌     ██████████████
// ██████████████     ▐████▌     ██████████████
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
// ██████████████     ▐████▌     ██████████████
// ██████████████     ▐████▌     ██████████████
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌

pragma solidity 0.8.17;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import "./IReservationFeeFinancer.sol";
import "./IVault.sol";
import "./TBTCVault.sol";
import "../bank/Bank.sol";
import "../bridge/IReservationBridge.sol";
import "../bridge/Reservation.sol";
import "../token/TBTC.sol";

/// @title Reservation vault
/// @notice The reservation vault is the liability-side companion of the
///         Bridge's `Reservation` library. Deposits revealed with this vault
///         address are treated as UTXO reservations: instead of being swept
///         into the pooled supply, they are anchored by the wallet and
///         redeemable in-kind. When the Bridge proves a reservation's anchor
///         transaction, it credits the gross anchored amount to this vault,
///         which mints TBTC gross and forwards it to depositors minus the
///         initiation fee. The initiation fee is retained in the vault as
///         the in-kind fee reserve until `sweepFees` moves the excess over
///         `feeReserveTarget` to governance's recipient.
/// @dev The vault deliberately keeps no claim registry of its own -- the
///      Bridge's reservation records are the single source of truth and are
///      consulted for ownership checks.
contract ReservationVault is IVault, IReservationFeeFinancer, Ownable {
    using SafeERC20 for IERC20;

    /// @notice Multiplier to convert satoshi to TBTC token units.
    uint256 public constant SATOSHI_MULTIPLIER = 10**10;

    /// @notice Basis points divisor for fee computations.
    uint256 public constant BASIS_POINTS = 10000;

    /// @notice Upper sanity bound for each fee parameter, in basis points.
    uint256 public constant MAX_FEE_BASIS_POINTS = 500;

    Bank public immutable bank;
    TBTCVault public immutable tbtcVault;
    TBTC public immutable tbtcToken;
    IReservationBridge public immutable bridge;

    /// @notice Initiation fee in basis points of the gross anchored amount,
    ///         charged when the acceptance credit is processed. Covers the
    ///         mint leg and the first custody term.
    uint16 public initiationFeeBps;
    /// @notice TBTC amount (18 decimals) of custody-fee revenue the vault
    ///         retains as the in-kind fee reserve. All protocol fees
    ///         accumulate in the vault; `sweepFees` can move only the
    ///         balance exceeding this target to the treasury. The reserve
    ///         finances the Bitcoin miner fees of re-anchor and dissolution
    ///         transactions — the settlements where no party surrenders
    ///         TBTC — keeping total supply matched to the Bitcoin backing.
    /// @dev Note that fee retention in TBTC token units may leave a
    ///      sub-satoshi remainder due to 18-decimal to satoshi truncation
    ///      when financing in-kind fees. Governance should account for this
    ///      satoshi-granularity floor when sizing the target.
    uint256 public feeReserveTarget;

    /// @notice Outstanding in-kind fee debt in satoshi: miner fees of
    ///         already-settled re-anchor/dissolution transactions the fee
    ///         reserve could not cover at settlement time. While non-zero,
    ///         total TBTC supply exceeds the Bitcoin backing by this
    ///         amount; `repayInKindFeeDebt` burns it down.
    uint64 public inKindFeeDebtSat;

    event ReservationCreditProcessed(
        address indexed owner,
        uint256 satAmount,
        uint256 feeTbtc
    );

    event FeesUpdated(uint16 initiationFeeBps);

    event InKindFeeFinanced(uint64 feeSat, uint64 shortfallSat);

    event InKindFeeDebtRepaid(address indexed payer, uint64 amountSat);

    event FeeReserveTargetUpdated(uint256 feeReserveTarget);
    event FeesSwept(address indexed recipient, uint256 amountTbtc);

    modifier onlyBank() {
        require(msg.sender == address(bank), "Caller is not the Bank");
        _;
    }

    constructor(
        Bank _bank,
        TBTCVault _tbtcVault,
        IReservationBridge _bridge
    ) {
        require(
            address(_bank) != address(0),
            "Bank can not be the zero address"
        );
        require(
            address(_tbtcVault) != address(0),
            "TBTCVault can not be the zero address"
        );
        require(
            address(_bridge) != address(0),
            "Bridge can not be the zero address"
        );

        bank = _bank;
        tbtcVault = _tbtcVault;
        tbtcToken = _tbtcVault.tbtcToken();
        bridge = _bridge;

        // Initiation fee of 40 bps on the gross anchored amount. Priced at
        // a premium over the pooled baseline (0 bps deposit treasury fee)
        // to cover the vault's per-position lifecycle costs; the minimum
        // reservation size is the governance dial that keeps this fee
        // covering those costs.
        initiationFeeBps = 40;
    }

    /// @notice Called by the Bank when the Bridge proves a reservation's
    ///         anchor transaction and credits the gross anchored amount to
    ///         this vault. Mints TBTC gross and forwards it to depositors
    ///         minus the initiation fee. The initiation fee is retained in the
    ///         vault as the in-kind fee reserve until `sweepFees` moves the
    ///         excess over `feeReserveTarget` to governance's recipient.
    /// @dev The gross amount is always minted so the total TBTC supply
    ///      created against the reservation equals the sats earmarked
    ///      on-chain; depositors receive gross minus fee.
    /// @dev KNOWN GAP (tracked, not fixed here): this function trusts every
    ///      Bank-routed credit unconditionally -- it has no reservationKey
    ///      parameter and cannot verify the credit corresponds to a
    ///      Bridge-proven reservation anchor. The deploy pipeline
    ///      (`97_set_reservation_parameters.ts`) marks this vault
    ///      `isVaultTrusted` only after it is wired into the Bridge on
    ///      non-local networks, so the scripted activation path cannot
    ///      trigger this gap. That ordering is enforced by the deploy
    ///      script, not by an on-chain check: governance retains the raw
    ///      ability to call `setVaultStatus(vault, true)` directly through
    ///      `BridgeGovernance`, bypassing the script's precondition. MUST
    ///      be resolved (a dedicated Bridge-only credit entry point, or an
    ///      ordinary-sweep guard in `DepositSweep`) before that direct-call
    ///      path is treated as acceptable risk.
    function receiveBalanceIncrease(
        address[] calldata depositors,
        uint256[] calldata depositedAmounts
    ) external override onlyBank {
        require(depositors.length != 0, "No depositors specified");
        require(
            depositors.length == depositedAmounts.length,
            "Arrays must have the same length"
        );
        uint256 totalSat = 0;
        for (uint256 i = 0; i < depositedAmounts.length; i++) {
            totalSat += depositedAmounts[i];
        }

        // Convert the whole Bank balance credited by the Bridge into TBTC
        // minted to this vault in a single mint, then distribute it.
        bank.approveBalance(address(tbtcVault), totalSat);
        tbtcVault.mint(totalSat * SATOSHI_MULTIPLIER);

        for (uint256 i = 0; i < depositors.length; i++) {
            uint256 grossTbtc = depositedAmounts[i] * SATOSHI_MULTIPLIER;
            uint256 fee = (grossTbtc * initiationFeeBps) / BASIS_POINTS;

            IERC20(tbtcToken).safeTransfer(depositors[i], grossTbtc - fee);

            // slither-disable-next-line reentrancy-events
            emit ReservationCreditProcessed(
                depositors[i],
                depositedAmounts[i],
                fee
            );
        }

        // The initiation fee stays in the vault: all custody-fee revenue
        // accumulates here as the in-kind fee reserve, and only the excess
        // over `feeReserveTarget` can be swept to the treasury.
    }

    /// @notice Finances an in-kind Bitcoin miner fee of a settled
    ///         re-anchor or dissolution transaction: burns TBTC equal to
    ///         the fee from the vault's entire current TBTC balance (not bounded
    ///         by feeReserveTarget, which only gates what sweepFees can remove)
    ///         together with the corresponding Bank balance, so total supply
    ///         shrinks in lockstep with the Bitcoin backing. Called by the
    ///         Bridge during settlement.
    /// @dev Requirements:
    ///      - The caller must be the Bridge.
    ///
    ///      If the reserve cannot cover the full amount, the shortfall is
    ///      recorded as `inKindFeeDebtSat` and the call still succeeds: a
    ///      confirmed Bitcoin spend must never fail to settle because of
    ///      the reserve level. While the debt is non-zero the system is
    ///      over-supplied by exactly that amount, publicly visible and
    ///      repayable by anyone via `repayInKindFeeDebt`.
    function financeInKindFee(uint64 feeSat) external override {
        require(msg.sender == address(bridge), "Caller is not the Bridge");

        if (feeSat == 0) {
            return;
        }

        uint64 coverableSat = _burnFromReserve(feeSat);

        uint64 shortfallSat = feeSat - coverableSat;
        if (shortfallSat > 0) {
            // The external calls above touch only trusted protocol
            // contracts (TBTC token, TBTC vault, Bank).
            // slither-disable-next-line reentrancy-benign
            inKindFeeDebtSat += shortfallSat;
        }

        // slither-disable-next-line reentrancy-events
        emit InKindFeeFinanced(feeSat, shortfallSat);
    }

    /// @notice Repays outstanding in-kind fee debt: pulls TBTC from the
    ///         caller, burns it together with the corresponding Bank
    ///         balance and reduces the recorded debt. Callable by anyone.
    /// @param amountSat The debt amount in satoshi to repay; capped at the
    ///        outstanding debt.
    function repayInKindFeeDebt(uint64 amountSat) external {
        require(inKindFeeDebtSat > 0, "No debt to repay");
        require(amountSat > 0, "Amount must not be zero");

        uint64 repaySat = uint64(
            Math.min(uint256(amountSat), uint256(inKindFeeDebtSat))
        );

        uint256 repayTbtc = uint256(repaySat) * SATOSHI_MULTIPLIER;
        IERC20(tbtcToken).safeTransferFrom(
            msg.sender,
            address(this),
            repayTbtc
        );
        IERC20(tbtcToken).safeIncreaseAllowance(address(tbtcVault), repayTbtc);
        tbtcVault.unmint(repayTbtc);
        bank.decreaseBalance(repaySat);

        // The external calls above touch only trusted protocol contracts
        // (TBTC token, TBTC vault, Bank).
        // slither-disable-next-line reentrancy-no-eth,reentrancy-benign
        inKindFeeDebtSat -= repaySat;

        // slither-disable-next-line reentrancy-events
        emit InKindFeeDebtRepaid(msg.sender, repaySat);
    }

    /// @notice Updates the TBTC amount of fee revenue the vault retains as
    ///         the in-kind fee reserve.
    /// @param _feeReserveTarget The new reserve target, in TBTC (18
    ///        decimals).
    /// @dev Requirements:
    ///      - The caller must be the vault owner (governance).
    ///
    ///      Note: Updates apply instantly for milestone 1, matching the
    ///      ReservationRouter parameter-update precedent, pending a possible
    ///      future governance delay extension.
    function updateFeeReserveTarget(uint256 _feeReserveTarget)
        external
        onlyOwner
    {
        feeReserveTarget = _feeReserveTarget;
        emit FeeReserveTargetUpdated(_feeReserveTarget);
    }

    /// @notice Sweeps fee revenue exceeding the reserve target to the
    ///         given recipient (normally the Bridge treasury). Any outstanding
    ///         in-kind fee debt is first repaid from the vault's current TBTC
    ///         balance before computing the sweepable excess.
    /// @param recipient The recipient of the swept fees.
    /// @dev Requirements:
    ///      - The caller must be the vault owner (governance).
    ///
    ///      If the balance (after satisfying outstanding debt) does not
    ///      exceed the reserve target, the call returns without reverting,
    ///      so a debt repayment performed above is still persisted.
    function sweepFees(address recipient) external onlyOwner {
        require(recipient != address(0), "Recipient must not be zero");

        if (inKindFeeDebtSat > 0) {
            uint64 repaidSat = _burnFromReserve(inKindFeeDebtSat);
            if (repaidSat > 0) {
                // slither-disable-next-line reentrancy-no-eth,reentrancy-benign
                inKindFeeDebtSat -= repaidSat;
                // slither-disable-next-line reentrancy-events
                emit InKindFeeDebtRepaid(address(this), repaidSat);
            }
        }

        uint256 balance = tbtcToken.balanceOf(address(this));
        if (balance <= feeReserveTarget) {
            return;
        }

        uint256 amount = balance - feeReserveTarget;
        IERC20(tbtcToken).safeTransfer(recipient, amount);
        // slither-disable-next-line reentrancy-events
        emit FeesSwept(recipient, amount);
    }

    /// @notice Updates the vault's initiation fee.
    /// @param _initiationFeeBps The new initiation fee, in basis points.
    /// @dev Requirements:
    ///      - The caller must be the vault owner (governance),
    ///      - The fee must not exceed `MAX_FEE_BASIS_POINTS`.
    ///
    ///      Note: Updates apply instantly for milestone 1, matching the
    ///      ReservationRouter parameter-update precedent, pending a possible
    ///      future governance delay extension.
    function updateInitiationFee(uint16 _initiationFeeBps) external onlyOwner {
        require(
            _initiationFeeBps <= MAX_FEE_BASIS_POINTS,
            "Fee exceeds the maximum"
        );

        initiationFeeBps = _initiationFeeBps;

        emit FeesUpdated(_initiationFeeBps);
    }

    /// @notice The reservation vault does not support the balance approval
    ///         flow.
    function receiveBalanceApproval(
        address,
        uint256,
        bytes calldata
    ) external pure override {
        revert("Balance approvals not supported");
    }

    /// @dev Burns up to `amountSat` of TBTC from the vault's current balance
    ///      and decreases the corresponding Bank balance. Returns the amount
    ///      of satoshi actually burned.
    function _burnFromReserve(uint64 amountSat)
        internal
        returns (uint64 burnedSat)
    {
        uint256 reserveTbtc = tbtcToken.balanceOf(address(this));
        burnedSat = uint64(
            Math.min(uint256(amountSat), reserveTbtc / SATOSHI_MULTIPLIER)
        );

        if (burnedSat > 0) {
            uint256 burnTbtc = uint256(burnedSat) * SATOSHI_MULTIPLIER;
            IERC20(tbtcToken).safeIncreaseAllowance(
                address(tbtcVault),
                burnTbtc
            );
            tbtcVault.unmint(burnTbtc);
            bank.decreaseBalance(burnedSat);
        }
    }
}
