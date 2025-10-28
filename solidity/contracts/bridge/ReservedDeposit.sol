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

pragma solidity ^0.8.17;

import "./BridgeState.sol";
import "./Deposit.sol";
import "./Wallets.sol";
import "../bank/Bank.sol";
import "../token/TBTC.sol";
import {BTCUtils} from "@keep-network/bitcoin-spv-sol/contracts/BTCUtils.sol";
import "./BitcoinTx.sol";

/// @title Reserved Deposit
/// @notice This library handles deposits with UTXO reservations for tax-efficient custody.
///         It allows depositors to reserve specific UTXOs and redeem the exact same BTC later.
library ReservedDeposit {
    using BTCUtils for bytes;

    // Events

    event ReservedDepositRevealed(
        bytes32 indexed utxoHash,
        address indexed depositor,
        uint64 amount,
        uint64 storageFee,
        uint256 expiryTimestamp,
        bytes20 indexed walletPubKeyHash,
        address vault
    );

    event ReservedDepositRedeemed(
        bytes32 indexed utxoHash,
        address indexed redeemer,
        uint64 amount,
        bytes redeemerOutputScript
    );

    event ReservedDepositLiquidated(
        bytes32 indexed utxoHash,
        address indexed originalDepositor,
        address indexed liquidator,
        uint64 liquidationBonus
    );

    // Fee parameters (in basis points)
    uint256 internal constant ANNUAL_FEE_BPS = 10; // 0.1% per year
    uint256 internal constant LIQUIDATION_FEE_SHARE_BPS = 1000; // 10% of storage fee

    // Deposit constraints (in satoshis)
    uint64 internal constant MIN_DEPOSIT_BTC = 0.1e8; // 0.1 BTC minimum
    uint64 internal constant MIN_FEE_BTC = 0.01e8; // 0.01 BTC minimum fee per year
    uint32 internal constant MAX_RESERVATION_DAYS = 1460; // 4 years maximum


    /// @notice Reveals a deposit with UTXO reservation for tax-efficient custody
    /// @param self Bridge state storage
    /// @param fundingTx Bitcoin funding transaction info
    /// @param reveal Deposit reveal info including vault
    /// @param depositor Address of the depositor
    /// @param reservationDays Number of days to reserve the UTXO
    /// @param btcRedemptionAddress Pre-committed BTC address for redemption
    /// @dev This function validates the deposit, creates a reservation, and mints tBTC
    function revealReservedDeposit(
        BridgeState.Storage storage self,
        BitcoinTx.Info calldata fundingTx,
        Deposit.DepositRevealInfo calldata reveal,
        address depositor,
        uint32 reservationDays,
        bytes calldata btcRedemptionAddress
    ) external {
        require(
            reservationDays > 0 && reservationDays <= MAX_RESERVATION_DAYS,
            "Bad period"
        );
        require(
            btcRedemptionAddress.length == 20 || btcRedemptionAddress.length == 32,
            "Bad addr"
        );

        require(
            self.registeredWallets[reveal.walletPubKeyHash].state == Wallets.WalletState.Live,
            "Wallet must be in Live state"
        );

        require(
            reveal.vault == address(0) || self.isVaultTrusted[reveal.vault],
            "Vault is not trusted"
        );

        // Register the deposit via the canonical flow and mark it as reserved.
        Deposit._revealDeposit(
            self,
            fundingTx,
            reveal,
            BridgeState.RESERVED_DEPOSIT_EXTRA_DATA
        );

        bytes32 utxoHash = keccak256(
            abi.encodePacked(
                _fundingTxHash(fundingTx),
                reveal.fundingOutputIndex
            )
        );

        Deposit.DepositRequest storage depositRequest = self.deposits[
            uint256(utxoHash)
        ];

        BridgeState.ReservationProcessingContext memory ctx;
        ctx.btcAmount = depositRequest.amount;
        require(ctx.btcAmount >= MIN_DEPOSIT_BTC, "Too small");

        ctx.totalFee = calculateStorageFee(ctx.btcAmount, reservationDays);
        require(ctx.btcAmount > ctx.totalFee, "Fee high");

        ctx.liquidationBonus = uint64(
            (uint256(ctx.totalFee) * LIQUIDATION_FEE_SHARE_BPS) / 10000
        );
        ctx.expiryTimestamp = block.timestamp +
            (uint256(reservationDays) * 1 days);

        _setupReservation(
            self,
            depositRequest,
            utxoHash,
            depositor,
            ctx,
            btcRedemptionAddress,
            reveal
        );

        self.depositorReservations[depositor].push(utxoHash);

        _emitReservedDepositRevealed(
            utxoHash,
            depositor,
            ctx.btcAmount,
            ctx.totalFee,
            ctx.expiryTimestamp,
            reveal.walletPubKeyHash,
            reveal.vault
        );
    }

    function redeemReservedDeposit(
        BridgeState.Storage storage self,
        bytes32 utxoHash,
        address redeemer
    ) external {
        BridgeState.ReservedDeposit storage r = self.reservedDeposits[utxoHash];
        require(r.isActive, "Not active");
        require(r.depositor == redeemer, "Not depositor");
        require(block.timestamp <= r.expiryTimestamp, "Expired");

        // Transfer tBTC from redeemer to Bridge and burn it
        self.bank.transferBalanceFrom(redeemer, address(this), r.tbtcMinted);
        self.bank.decreaseBalance(r.tbtcMinted);

        // Send the liquidation bonus held by the Bridge to the treasury
        uint64 liquidationBonus = r.liquidationBonus;
        if (liquidationBonus > 0) {
            self.bank.transferBalance(self.treasury, liquidationBonus);
        }

        r.isActive = false;
        _createReservedRedemption(self, r);
        r.liquidationBonus = 0;

        emit ReservedDepositRedeemed(
            utxoHash,
            redeemer,
            r.btcAmount,
            r.btcRedemptionAddress
        );
    }

    function liquidateExpiredReservation(
        BridgeState.Storage storage self,
        bytes32 utxoHash,
        address liquidator
    ) external {
        BridgeState.ReservedDeposit storage r = self.reservedDeposits[utxoHash];
        require(r.isActive, "Not active");
        require(block.timestamp > r.expiryTimestamp, "Not expired");

        // Transfer the liquidation bonus held by the Bridge to the liquidator
        uint64 liquidationBonus = r.liquidationBonus;
        if (liquidationBonus > 0) {
            self.bank.transferBalance(liquidator, liquidationBonus);
        }

        r.isActive = false;
        _moveToGeneralPool(self, r);
        r.liquidationBonus = 0;

        emit ReservedDepositLiquidated(
            utxoHash,
            r.depositor,
            liquidator,
            liquidationBonus
        );
    }

    // View Functions

    /// @notice Calculates the storage fee for a given deposit and duration
    /// @param btcAmount Amount of BTC to deposit (in satoshis)
    /// @param reservationDays Number of days to reserve
    /// @return storageFee The storage fee in satoshis
    function calculateStorageFee(uint64 btcAmount, uint32 reservationDays)
        public
        pure
        returns (uint64 storageFee)
    {
        require(
            reservationDays > 0 && reservationDays <= MAX_RESERVATION_DAYS,
            "Bad period"
        );

        // Calculate base fee (0.1% per year)
        storageFee = uint64(
            (uint256(btcAmount) * ANNUAL_FEE_BPS * reservationDays) / (10000 * 365)
        );

        // Calculate minimum fee based on years (0.01 BTC per year, stepped not prorated)
        uint32 yearsRoundedUp = (reservationDays + 364) / 365;
        uint64 minimumFee = MIN_FEE_BTC * yearsRoundedUp;

        // Ensure minimum fee
        if (storageFee < minimumFee) {
            storageFee = minimumFee;
        }
    }

    /// @notice Checks if a reservation has expired
    /// @param self Bridge state storage
    /// @param utxoHash Hash of the UTXO to check
    /// @return expired Whether the reservation has expired
    function isReservationExpired(
        BridgeState.Storage storage self,
        bytes32 utxoHash
    ) external view returns (bool expired) {
        BridgeState.ReservedDeposit storage reservation = self.reservedDeposits[utxoHash];
        return reservation.isActive && block.timestamp > reservation.expiryTimestamp;
    }

    /// @notice Gets all reservations for a depositor
    /// @param self Bridge state storage
    /// @param depositor Address of the depositor
    /// @return hashes Array of UTXO hashes for depositor's reservations
    function getDepositorReservations(
        BridgeState.Storage storage self,
        address depositor
    ) external view returns (bytes32[] memory hashes) {
        return self.depositorReservations[depositor];
    }

    // Internal Functions

    function _createReservedRedemption(
        BridgeState.Storage storage self,
        BridgeState.ReservedDeposit storage r
    ) internal {
        // Include utxoHash in the key to ensure uniqueness for each reserved redemption
        // This prevents collisions when multiple depositors use the same wallet and BTC address
        bytes32 key = keccak256(abi.encodePacked(r.utxoHash, r.walletPubKeyHash, r.btcRedemptionAddress));
        self.priorityRedemptions[key] = BridgeState.PriorityRedemption({
            utxoHash: r.utxoHash,
            walletPubKeyHash: r.walletPubKeyHash,
            redeemer: r.depositor,
            redeemerOutputScript: r.btcRedemptionAddress,
            requestedAmount: r.btcAmount,
            treasuryFee: 0,
            txMaxFee: r.treasuryFee + r.liquidationBonus,  // Total original fee
            requestedAt: block.timestamp,
            isPriority: true
        });
    }


    function _emitReservedDepositRevealed(
        bytes32 utxoHash,
        address depositor,
        uint64 btcAmount,
        uint64 storageFee,
        uint256 expiryTimestamp,
        bytes20 walletPubKeyHash,
        address vault
    ) private {
        emit ReservedDepositRevealed(
            utxoHash,
            depositor,
            btcAmount,
            storageFee,
            expiryTimestamp,
            walletPubKeyHash,
            vault
        );
    }

    function _setupReservation(
        BridgeState.Storage storage self,
        Deposit.DepositRequest storage depositRequest,
        bytes32 utxoHash,
        address depositor,
        BridgeState.ReservationProcessingContext memory ctx,
        bytes calldata btcRedemptionAddress,
        Deposit.DepositRevealInfo calldata reveal
    ) private {
        depositRequest.treasuryFee = 0;
        depositRequest.extraData = BridgeState.RESERVED_DEPOSIT_EXTRA_DATA;

        BridgeState.ReservedDeposit storage reservation = self
            .reservedDeposits[utxoHash];
        require(reservation.depositor == address(0), "Reserved");

        reservation.utxoHash = utxoHash;
        reservation.depositor = depositor;
        reservation.btcAmount = ctx.btcAmount;
        reservation.tbtcMinted = ctx.btcAmount - ctx.totalFee;
        reservation.treasuryFee = ctx.totalFee - ctx.liquidationBonus;
        reservation.liquidationBonus = ctx.liquidationBonus;
        reservation.depositTimestamp = block.timestamp;
        reservation.expiryTimestamp = ctx.expiryTimestamp;
        reservation.btcRedemptionAddress = btcRedemptionAddress;
        reservation.walletPubKeyHash = reveal.walletPubKeyHash;
        reservation.fundingOutputIndex = reveal.fundingOutputIndex;
        reservation.isActive = false;
    }


    function finalizeReservedDepositSweep(
        BridgeState.Storage storage self,
        bytes32 utxoHash,
        uint256 depositTxFee
    ) internal returns (BridgeState.ReservedSweepResult memory result) {
        BridgeState.ReservedDeposit storage reservation = self
            .reservedDeposits[utxoHash];

        require(reservation.depositor != address(0), "Not reserved");
        require(!reservation.isActive, "Reservation already active");

        uint256 mintBeforeFee = reservation.tbtcMinted;
        result.treasuryFee = reservation.treasuryFee;
        result.liquidationBonus = reservation.liquidationBonus;

        require(
            mintBeforeFee + result.treasuryFee + result.liquidationBonus ==
                reservation.btcAmount,
            "Reserved deposit invariant broken"
        );

        require(mintBeforeFee > depositTxFee, "Fees exceed mint amount");

        result.mintAmount = mintBeforeFee - depositTxFee;
        reservation.tbtcMinted = uint64(result.mintAmount);
        reservation.isActive = true;

        result.depositor = reservation.depositor;
    }


    function _moveToGeneralPool(
        BridgeState.Storage storage self,
        BridgeState.ReservedDeposit storage r
    ) internal {
        // Use the utxoHash directly as the key - it's already keccak256(fundingTxHash, fundingOutputIndex)
        // This ensures the deposit uses the same key format as regular deposits
        uint256 key = uint256(r.utxoHash);

        // CRITICAL: Mark as already swept to prevent double-minting
        // The tBTC was already minted when the reserved deposit was swept
        // We cannot allow it to be swept again after liquidation
        self.deposits[key] = Deposit.DepositRequest({
            depositor: address(0),  // Zero out depositor to prevent any minting
            amount: r.btcAmount,
            revealedAt: uint32(r.depositTimestamp),
            vault: address(0),
            treasuryFee: 0,
            sweptAt: uint32(block.timestamp),  // Mark as already swept
            extraData: bytes32(0)
        });
    }

    function _fundingTxHash(
        BitcoinTx.Info calldata fundingTx
    ) internal view returns (bytes32) {
        return abi
            .encodePacked(
                fundingTx.version,
                fundingTx.inputVector,
                fundingTx.outputVector,
                fundingTx.locktime
            )
            .hash256View();
    }
}
