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

pragma solidity 0.8.17;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./IVault.sol";
import "./TBTCVault.sol";
import "../bank/Bank.sol";
import "../bridge/Reservation.sol";
import "../token/TBTC.sol";

/// @notice Minimal interface of the Bridge functions the reservation vault
///         interacts with.
interface IReservationBridge {
    function reservations(uint256 reservationKey)
        external
        view
        returns (Reservation.ReservationRequest memory);

    function requestReservedRedemption(
        uint256 reservationKey,
        address redeemer,
        bytes calldata redeemerOutputScript
    ) external;

    function extendReservation(uint256 reservationKey) external;

    function treasury() external view returns (address);
}

/// @title Reservation vault
/// @notice The reservation vault is the liability-side companion of the
///         Bridge's `Reservation` library. Deposits revealed with this vault
///         address are treated as UTXO reservations: instead of being swept
///         into the pooled supply, they are anchored by the wallet and
///         redeemable in-kind. When the Bridge proves a reservation's anchor
///         transaction, it credits the gross anchored amount to this vault,
///         which mints TBTC gross to the reservation owner and collects all
///         protocol fees as explicit TBTC transfers -- reservation claims
///         are never netted, so the claim surrendered at redemption always
///         equals the sats earmarked on-chain.
///
///         Fee schedule (basis points of the gross amount, all governable):
///         - initiation: charged when the acceptance credit is processed;
///           covers the mint leg and the first custody term,
///         - extension: charged per custody term extension,
///         - redemption: charged when the in-kind redemption is requested;
///           priced at parity with the pooled redemption fee. Not re-charged
///           on retries after wallet-fault timeouts.
///
///         Wiring requirements: governance must mark this vault as trusted
///         in the Bridge (`setVaultStatus`) so deposits can be revealed with
///         it, and must set it as the Bridge's reservation vault via
///         `updateReservationParameters`.
/// @dev The vault deliberately keeps no claim registry of its own -- the
///      Bridge's reservation records are the single source of truth and are
///      consulted for ownership checks. A reservation's `owner` is set once
///      at acceptance and has no reassignment path anywhere in the Bridge
///      or this vault: reservation positions are deliberately
///      non-transferable, even though the TBTC minted against a reservation
///      is freely transferable. Key rotation or entity restructuring on the
///      owner side therefore requires redeeming and re-establishing the
///      reservation rather than transferring it directly.
contract ReservationVault is IVault, Ownable {
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
    uint16 public extensionFeeBps;
    /// @notice Redemption fee in basis points of the gross amount, charged
    ///         when the in-kind redemption is requested. Priced at parity
    ///         with the pooled redemption fee; not re-charged on retries
    ///         after wallet-fault timeouts.
    uint16 public redemptionFeeBps;

    event ReservationCreditProcessed(
        address indexed owner,
        uint256 satAmount,
        uint256 feeTbtc
    );

    event CustodyExtended(
        uint256 indexed reservationKey,
        address indexed owner,
        uint256 feeTbtc
    );

    event ReservedRedemptionInitiated(
        uint256 indexed reservationKey,
        address indexed owner,
        uint256 grossTbtc,
        uint256 feeTbtc
    );

    event FeesUpdated(
        uint16 initiationFeeBps,
        uint16 extensionFeeBps,
        uint16 redemptionFeeBps
    );

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

        // Fee schedule (see the UTXO reservation design): the endpoints
        // are priced at parity with the pooled path -- a 20 bps mint leg
        // inside the 40 bps initiation fee and a 20 bps redemption fee --
        // so the only premium being purchased is the 20 bps/yr custody fee
        // (the remainder of the initiation fee prepays the first year). An
        // N-year holding pays 40 + 20N bps against the pooled 40 bps round
        // trip: strictly premium at every horizon. The minimum reservation
        // size, not this schedule, is the governance dial that keeps the
        // carry fee covering per-position lifecycle costs.
        initiationFeeBps = 40;
        extensionFeeBps = 20;
        redemptionFeeBps = 20;
    }

    /// @notice Called by the Bank when the Bridge proves a reservation's
    ///         anchor transaction and credits the gross anchored amount to
    ///         this vault. Mints TBTC gross and forwards it to the
    ///         reservation owner minus the initiation fee, which is
    ///         transferred to the Bridge treasury.
    /// @dev The gross amount is always minted so the total TBTC supply
    ///      created against the reservation equals the sats earmarked
    ///      on-chain; the fee is an explicit transfer, never a netted
    ///      credit.
    ///
    ///      Known limitation: this function cannot distinguish an
    ///      acceptance credit from an ordinary pooled sweep credit. A
    ///      deposit revealed to this vault's address before a vault swap,
    ///      or after this vault is de-designated but still trusted by the
    ///      Bridge, lands here as an ordinary multi-depositor credit and
    ///      is charged the initiation fee for what is really a pooled
    ///      deposit with no reservation record. This is accepted current
    ///      behavior (see the reveal-time classification tests) -- fixing
    ///      it properly requires the Bridge to pass an explicit
    ///      discriminator through the shared `IVault.receiveBalanceIncrease`
    ///      interface, a change affecting every vault, not just this one.
    function receiveBalanceIncrease(
        address[] calldata depositors,
        uint256[] calldata depositedAmounts
    ) external override onlyBank {
        require(depositors.length != 0, "No depositors specified");

        uint256 totalSat = 0;
        for (uint256 i = 0; i < depositedAmounts.length; i++) {
            totalSat += depositedAmounts[i];
        }

        // Convert the whole Bank balance credited by the Bridge into TBTC
        // minted to this vault in a single mint, then distribute it.
        bank.approveBalance(address(tbtcVault), totalSat);
        tbtcVault.mint(totalSat * SATOSHI_MULTIPLIER);

        uint256 totalFee = 0;

        for (uint256 i = 0; i < depositors.length; i++) {
            uint256 grossTbtc = depositedAmounts[i] * SATOSHI_MULTIPLIER;
            uint256 fee = (grossTbtc * initiationFeeBps) / BASIS_POINTS;
            totalFee += fee;

            IERC20(tbtcToken).safeTransfer(depositors[i], grossTbtc - fee);

            // slither-disable-next-line reentrancy-events
            emit ReservationCreditProcessed(
                depositors[i],
                depositedAmounts[i],
                fee
            );
        }

        if (totalFee > 0) {
            IERC20(tbtcToken).safeTransfer(bridge.treasury(), totalFee);
        }
    }

    /// @notice Fetches a reservation and validates the caller owns it.
    /// @param reservationKey The key of the reservation.
    /// @return reservation The validated reservation struct.
    /// @dev Requirements:
    ///      - The caller must be the reservation owner.
    function _ownedReservation(uint256 reservationKey)
        internal
        view
        returns (Reservation.ReservationRequest memory reservation)
    {
        reservation = bridge.reservations(reservationKey);
        require(
            reservation.owner == msg.sender,
            "Caller is not the reservation owner"
        );
    }

    /// @notice Requests an in-kind redemption of the caller's reservation.
    ///         The caller surrenders the gross minted TBTC amount plus the
    ///         redemption fee; the vault unmints the gross amount and asks
    ///         the Bridge to have the wallet spend exactly the reservation's
    ///         anchor outpoint to the given redeemer script.
    /// @param reservationKey The key of the reservation to redeem.
    /// @param redeemerOutputScript The redeemer's length-prefixed output
    ///        script (P2PKH, P2WPKH, P2SH or P2WSH).
    /// @param maxFeeTbtc Upper bound on the TBTC fee the caller accepts;
    ///        an unexpected fee update reverts instead of overcharging.
    /// @dev Requirements:
    ///      - The caller must be the reservation owner,
    ///      - The fee must not exceed `maxFeeTbtc`,
    ///      - The caller must have approved this vault for
    ///        `mintedAmount * SATOSHI_MULTIPLIER * (1 + redemptionFeeBps/10000)`
    ///        TBTC.
    ///
    ///      Should the redemption time out, the Bridge returns the
    ///      surrendered gross amount to the caller as Bank balance; the
    ///      caller can re-mint TBTC via the TBTC vault and request the
    ///      redemption again.
    function redeemReservation(
        uint256 reservationKey,
        bytes calldata redeemerOutputScript,
        uint256 maxFeeTbtc
    ) external {
        Reservation.ReservationRequest memory reservation = _ownedReservation(
            reservationKey
        );

        uint256 grossTbtc = uint256(reservation.mintedAmount) *
            SATOSHI_MULTIPLIER;
        uint256 fee = (grossTbtc * redemptionFeeBps) / BASIS_POINTS;
        require(fee <= maxFeeTbtc, "Fee exceeds the caller's bound");

        IERC20(tbtcToken).safeTransferFrom(
            msg.sender,
            address(this),
            grossTbtc + fee
        );
        if (fee > 0) {
            IERC20(tbtcToken).safeTransfer(bridge.treasury(), fee);
        }

        // Unmint the gross TBTC back into Bank balance and let the Bridge
        // take it when registering the reserved redemption request.
        IERC20(tbtcToken).safeIncreaseAllowance(address(tbtcVault), grossTbtc);
        tbtcVault.unmint(grossTbtc);
        bank.approveBalance(address(bridge), reservation.mintedAmount);

        // slither-disable-next-line reentrancy-events
        emit ReservedRedemptionInitiated(
            reservationKey,
            msg.sender,
            grossTbtc,
            fee
        );

        bridge.requestReservedRedemption(
            reservationKey,
            msg.sender,
            redeemerOutputScript
        );
    }

    /// @notice Extends the custody term of the caller's reservation by one
    ///         term length, charging the extension fee in TBTC.
    /// @param reservationKey The key of the reservation to extend.
    /// @param maxFeeTbtc Upper bound on the TBTC fee the caller accepts; an
    ///        unexpected fee update reverts instead of overcharging.
    /// @dev Requirements:
    ///      - The caller must be the reservation owner,
    ///      - The fee must not exceed `maxFeeTbtc`,
    ///      - The caller must have approved this vault for the extension
    ///        fee in TBTC.
    function extendCustody(uint256 reservationKey, uint256 maxFeeTbtc)
        external
    {
        Reservation.ReservationRequest memory reservation = _ownedReservation(
            reservationKey
        );

        uint256 fee = (uint256(reservation.mintedAmount) *
            SATOSHI_MULTIPLIER *
            extensionFeeBps) / BASIS_POINTS;
        require(fee <= maxFeeTbtc, "Fee exceeds the caller's bound");
        if (fee > 0) {
            IERC20(tbtcToken).safeTransferFrom(
                msg.sender,
                bridge.treasury(),
                fee
            );
        }

        // slither-disable-next-line reentrancy-events
        emit CustodyExtended(reservationKey, msg.sender, fee);

        bridge.extendReservation(reservationKey);
    }

    /// @notice Re-requests an in-kind redemption using the caller's Bank
    ///         balance -- the state a timed-out reserved redemption leaves
    ///         the owner in (the Bridge refunds the surrendered amount as
    ///         Bank balance). The caller surrenders the gross minted amount
    ///         as Bank balance and pays the redemption fee in TBTC.
    /// @param reservationKey The key of the reservation to redeem.
    /// @param redeemerOutputScript The redeemer's length-prefixed output
    ///        script (P2PKH, P2WPKH, P2SH or P2WSH).
    /// @dev Requirements:
    ///      - The caller must be the reservation owner,
    ///      - The reservation's most recent reserved redemption timeout
    ///        must specifically have been caused by wallet fault (the
    ///        Bridge's `lastTimeoutWasWalletFault` marker) -- otherwise
    ///        this path would let an owner use it as an ordinary
    ///        fee-free first redemption, or grief wallet operators for
    ///        free by repeatedly requesting, waiting out the timeout
    ///        (slashing the wallet), and retrying,
    ///      - The caller must have approved this vault in the Bank for the
    ///        gross minted amount (`Bank.approveBalance`).
    ///
    ///      The redemption fee is not re-charged: it was collected by the
    ///      original `redeemReservation` call and the retry only exists
    ///      because the previous request timed out through the wallet's
    ///      fault.
    function retryRedeemReservation(
        uint256 reservationKey,
        bytes calldata redeemerOutputScript
    ) external {
        Reservation.ReservationRequest memory reservation = _ownedReservation(
            reservationKey
        );
        require(
            reservation.lastTimeoutWasWalletFault,
            "Previous request did not time out through wallet fault"
        );

        uint256 grossTbtc = uint256(reservation.mintedAmount) *
            SATOSHI_MULTIPLIER;

        // The redemption fee was already collected by the original
        // redeemReservation call; a retry only exists because the previous
        // request timed out through the wallet's fault, so it is not
        // re-charged.

        bank.transferBalanceFrom(
            msg.sender,
            address(this),
            reservation.mintedAmount
        );
        bank.approveBalance(address(bridge), reservation.mintedAmount);

        // slither-disable-next-line reentrancy-events
        emit ReservedRedemptionInitiated(
            reservationKey,
            msg.sender,
            grossTbtc,
            0
        );

        bridge.requestReservedRedemption(
            reservationKey,
            msg.sender,
            redeemerOutputScript
        );
    }


    /// @notice Updates the vault fee parameters.
    /// @dev Requirements:
    ///      - The caller must be the vault owner (governance),
    ///      - Each fee must not exceed `MAX_FEE_BASIS_POINTS`.
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
}
