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
    /// @notice Extension fee in basis points of the gross amount, charged
    ///         per custody term extension.
    /// @dev Unused in milestone 1; reserved for the sibling wiring PR.
    uint16 public extensionFeeBps;
    /// @notice Redemption fee in basis points of the gross amount, charged
    ///         when the in-kind redemption is requested. Priced at parity
    ///         with the pooled redemption fee; not re-charged on retries
    ///         after wallet-fault timeouts.
    /// @dev Unused in milestone 1; reserved for the sibling wiring PR.
    uint16 public redemptionFeeBps;

    /// @notice True while redemptions are paused. A fresh vault starts
    ///         paused; governance unpauses as part of activation. Pausing
    ///         only removes future redemption opportunities — it never
    ///         affects settlement, re-anchoring or dissolution.
    bool public redemptionsPaused;

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

    /// @notice Emitted when redemptions are paused.
    event ReservationRedemptionsPaused(address indexed caller);

    /// @notice Emitted when redemptions are unpaused.
    event ReservationRedemptionsUnpaused(address indexed caller);

    event ReservationCreditProcessed(
        address indexed owner,
        uint256 satAmount,
        uint256 feeTbtc
    );

    event FeesUpdated(
        uint16 initiationFeeBps,
        uint16 extensionFeeBps,
        uint16 redemptionFeeBps
    );

    event InKindFeeFinanced(uint64 feeSat, uint64 shortfallSat);

    event InKindFeeDebtRepaid(address indexed payer, uint64 amountSat);

    event FeeReserveTargetUpdated(uint256 feeReserveTarget);
    event FeesSwept(address indexed recipient, uint256 amountTbtc);


    modifier onlyBank() {
        require(msg.sender == address(bank), "Caller is not the Bank");
        _;
    }

    /// @notice Gates the redemption initiation entry points. A freshly
    ///         deployed vault starts paused, so this modifier rejects every
    ///         call. Governance is the only path that ever flips it.
    ///         Settlement-path functions must never include this check.
    ///         Currently gates nothing reachable in milestone 1 and exists to
    ///         fix the milestone 2 storage layout and governance surface.
    modifier whenRedemptionsNotPaused() {
        require(!redemptionsPaused, "Redemptions are paused");
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

        // Fee schedule: an initiation fee of 40 bps, an extension fee of
        // 20 bps/yr, and a redemption fee of 20 bps. Compared against the
        // pooled baseline (0 bps deposit treasury fee, 5 bps redemption
        // treasury fee), an N-year holding pays 40 + 20N bps: strictly
        // premium at every horizon. The minimum reservation size, not this
        // schedule, is the governance dial that keeps the carry fee covering
        // per-position lifecycle costs.
        initiationFeeBps = 40;
        extensionFeeBps = 20;
        redemptionFeeBps = 20;

        // A fresh vault starts with redemptions paused; governance unpauses
        // as part of the activation ceremony, after ownership has been
        // transferred out of the deployer's hands.
        redemptionsPaused = true;
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
    ///      Bridge-proven reservation anchor. This is unreachable today
    ///      because no deploy script yet marks this vault `isVaultTrusted`.
    ///      MUST be resolved (a dedicated Bridge-only credit entry point, or
    ///      an ordinary-sweep guard in `DepositSweep`) before the vault
    ///      activation PR calls `setVaultStatus(vault, true)`.
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
    ///      - The caller must be the vault owner (governance),
    ///      - The vault TBTC balance (after satisfying outstanding debt) must
    ///        exceed the reserve target.
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
        require(balance > feeReserveTarget, "Nothing above the reserve target");

        uint256 amount = balance - feeReserveTarget;
        IERC20(tbtcToken).safeTransfer(recipient, amount);
        // slither-disable-next-line reentrancy-events
        emit FeesSwept(recipient, amount);
    }

    /// @notice Updates the vault fee parameters.
    /// @dev Requirements:
    ///      - The caller must be the vault owner (governance),
    ///      - Each fee must not exceed `MAX_FEE_BASIS_POINTS`.
    ///
    ///      Note: Updates apply instantly for milestone 1, matching the
    ///      ReservationRouter parameter-update precedent, pending a possible
    ///      future governance delay extension.
    function updateFees(
        uint16 _initiationFeeBps,
        uint16 _extensionFeeBps,
        uint16 _redemptionFeeBps
    ) external onlyOwner {
        require(
            _initiationFeeBps <= MAX_FEE_BASIS_POINTS &&
                _extensionFeeBps <= MAX_FEE_BASIS_POINTS &&
                _redemptionFeeBps <= MAX_FEE_BASIS_POINTS,
            "Fee exceeds the maximum"
        );

        initiationFeeBps = _initiationFeeBps;
        extensionFeeBps = _extensionFeeBps;
        redemptionFeeBps = _redemptionFeeBps;

        emit FeesUpdated(
            _initiationFeeBps,
            _extensionFeeBps,
            _redemptionFeeBps
        );
    }

    /// @notice Initiates an in-kind redemption of `amountSat` of the
    ///         reservation's `mintedAmount`. Caller must be the
    ///         reservation owner.
    /// @param reservationKey The key of the reservation to redeem.
    /// @param amountSat The redemption amount in satoshi.
    /// @dev Reserved-redemption entry point. Milestone 1 unconditionally
    ///      reverts; milestone 2 will add the body that drives the
    ///      Bridge's `requestReservedRedemption` path. The amountSat parameter
    ///      is accepted for milestone 2 ABI stability and ignored in milestone 1.
    // solhint-disable-next-line no-unused-vars
    function redeemReservation(uint256 reservationKey, uint256 amountSat)
        external
    {
        require(
            msg.sender == bridge.reservations(reservationKey).owner,
            "Caller is not the reservation owner"
        );
        revert("Reserved redemption not enabled in milestone 1");
    }

    /// @notice Re-runs a redemption using the reservation's single-use
    ///         fee-free retry entitlement, granted when a prior
    ///         fee-paid redemption generation timed out through wallet
    ///         fault. Caller must be the reservation owner.
    /// @param reservationKey The key of the reservation to retry.
    /// @param amountSat The redemption amount in satoshi.
    /// @dev See `redeemReservation` for the same M1/M2 rationale. The
    ///      amountSat parameter is accepted for milestone 2 ABI stability
    ///      and ignored in milestone 1.
    // solhint-disable-next-line no-unused-vars
    function retryRedeemReservation(uint256 reservationKey, uint64 amountSat)
        external
    {
        require(
            msg.sender == bridge.reservations(reservationKey).owner,
            "Caller is not the reservation owner"
        );
        revert("Reserved redemption retry not enabled in milestone 1");
    }

    /// @notice Pauses all future redemptions. Restrictive and monotonic:
    ///         callable by the owner (governance), effective immediately.
    function pauseRedemptions() external onlyOwner {
        redemptionsPaused = true;
        emit ReservationRedemptionsPaused(msg.sender);
    }

    /// @notice Unpauses redemptions. Restorative: owner (governance) only.
    function unpauseRedemptions() external onlyOwner {
        redemptionsPaused = false;
        emit ReservationRedemptionsUnpaused(msg.sender);
    }

    /// @notice The reservation vault does not support the balance approval
    ///         flow; reserved redemptions are initiated via
    ///         `redeemReservation`.
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
