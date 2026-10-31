// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import {Test} from "forge-std/Test.sol";

import {Bank} from "../../contracts/bank/Bank.sol";
import {TBTC as TBTCToken} from "../../contracts/token/TBTC.sol";
import {TBTCVault as TBTCVaultType} from "../../contracts/vault/TBTCVault.sol";
import {ReservationVault as ReservationVaultType} from "../../contracts/vault/ReservationVault.sol";
import {Deposit} from "../../contracts/bridge/Deposit.sol";
import {Reservation} from "../../contracts/bridge/Reservation.sol";
import {IReservationBridge} from "../../contracts/bridge/IReservationBridge.sol";
import {Bridge} from "../../contracts/bridge/Bridge.sol";
import {ReservationProofs} from "../../contracts/bridge/ReservationProofs.sol";
import {ReservationRouter} from "../../contracts/bridge/ReservationRouter.sol";
import {Wallets} from "../../contracts/bridge/Wallets.sol";
import {BTCUtils} from "@keep-network/bitcoin-spv-sol/contracts/BTCUtils.sol";
import {BitcoinTx} from "../../contracts/bridge/BitcoinTx.sol";
import {BridgeState} from "../../contracts/bridge/BridgeState.sol";

/// @notice In-file harness for TM-11: a self-contained production stack
///         (Bank, TBTC, TBTCVault, ReservationVault) where the harness
///         is the Bank's bridge and holds the BridgeState.Storage so the
///         isVaultTrusted flag and reservation accounting are visible.
///         Mirrors the wiring of ReservationStackHarness without the router
///         fallback and governance layers, so all Bank-routed credits are
///         driven explicitly and can be observed directly.
contract Tm11Harness {
    using BTCUtils for bytes;
    using BitcoinTx for BridgeState.Storage;
    using Reservation for BridgeState.Storage;
    using ReservationProofs for BridgeState.Storage;

    BridgeState.Storage internal self;

    Bank public immutable bank;
    TBTCToken public immutable tbtcToken;
    TBTCVaultType public immutable tbtcVault;
    ReservationVaultType public immutable reservationVault;

    // Funding tx hash storage for acceptance proofs
    mapping(uint256 => bytes32) internal depositFundingTxHash;

    uint256 internal constant SATOSHI_MULTIPLIER = 1e10;
    uint16 internal constant INITIATION_FEE_BPS = 40;

    constructor() {
        Bank newBank = new Bank();
        newBank.updateBridge(address(this));
        bank = newBank;

        TBTCToken tbtcToken_ = new TBTCToken();
        tbtcToken = tbtcToken_;
        TBTCVaultType tbtcVault_ = new TBTCVaultType(
            newBank,
            tbtcToken_,
            Bridge(address(this))
        );
        tbtcVault = tbtcVault_;
        tbtcToken_.transferOwnership(address(tbtcVault_));

        ReservationVaultType reservationVault_ = new ReservationVaultType(
            newBank,
            tbtcVault_,
            IReservationBridge(address(this))
        );
        reservationVault = reservationVault_;

        // Wire the bridge state exactly like the production Bridge:
        // the harness is the bridge, the vault is the reservation vault and is trusted.
        self.bank = newBank;
        self.reservationVault = address(reservationVault);
        self.isVaultTrusted[address(reservationVault)] = true;
        self.treasury = address(this);
        self.depositDustThreshold = 10_000;
        self.depositTreasuryFeeDivisor = 2_000;
        self.depositTxMaxFee = 1_000;
        self.depositRevealAheadPeriod = 1 days;

        // Reservation parameters for the acceptance path (mirror handler defaults).
        self.reservationTermSeconds = 90 days;
        self.reservationDissolutionDelay = 7 days;
        self.reservationMaxSingleAmount = 2_000_000;
        self.maxReservationsAmountPerWallet = 30_000_000;
        self.maxReservationsPerWallet = 2;
        self.maxActiveReservations = 4;
        self.maxThirdPartyReanchorHoldsPerWallet = 1;
        self.reservationActionTimeout = 6 hours;
        self.reservationRenewalWindowSeconds = 7 days;
        self.reservationMinAmount = 100_000;
        self.reservationTxMaxFee = 10_000;
        self.handoffReserveWallets = 0;
    }

    // ---------------------------------------------------------------------
    // Production-reachable credit paths (the Bridge's two Bank-routed branches)
    // ---------------------------------------------------------------------

    /// @dev The trusted-vault branch of DepositSweep / ReservationProofs:
    ///      `bank.increaseBalanceAndCall(vault, depositors, amounts)` where
    ///      vault is a trusted vault. For TM-11 we route it specifically to
    ///      the reservation vault with NO reservation provenance (no key,
    ///      no pending reserved deposit, no acceptance proof).
    function creditTrustedReservationVault(
        address depositor,
        uint64 amountSat
    ) external {
        address[] memory depositors = new address[](1);
        depositors[0] = depositor;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amountSat;
        bank.increaseBalanceAndCall(
            address(reservationVault),
            depositors,
            amounts
        );
    }

    /// @dev The pooled branch: `bank.increaseBalances(depositors, amounts)`.
    ///      The depositor receives a Bank balance; no TBTC is minted.
    function creditPooled(address depositor, uint64 amountSat) external {
        address[] memory depositors = new address[](1);
        depositors[0] = depositor;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amountSat;
        bank.increaseBalances(depositors, amounts);
    }

    // ---------------------------------------------------------------------
    // Reservation acceptance path (for positive control: real reservation
    // credit that mints with the same fee treatment but creates a record)
    // ---------------------------------------------------------------------

    function revealReservedDeposit(
        address depositor,
        bytes20 walletPubKeyHash,
        bytes8 blindingFactor,
        bytes20 refundPubKeyHash,
        uint32 refundLocktime,
        uint64 amount,
        uint32 refundDeadline
    ) external returns (uint256 depositKey) {
        BitcoinTx.Info memory fundingTx = buildFundingTx(
            depositor,
            walletPubKeyHash,
            refundPubKeyHash,
            refundLocktime,
            blindingFactor,
            amount
        );
        bytes32 fundingTxHash = abi
            .encodePacked(
                fundingTx.version,
                fundingTx.inputVector,
                fundingTx.outputVector,
                fundingTx.locktime
            )
            .hash256View();

        depositKey = uint256(
            keccak256(abi.encodePacked(fundingTxHash, uint32(0)))
        );
        require(
            self.deposits[depositKey].revealedAt == 0,
            "Deposit already revealed"
        );

        self.deposits[depositKey] = Deposit.DepositRequest({
            depositor: depositor,
            amount: amount,
            /* solhint-disable-next-line not-rely-on-time */
            revealedAt: uint32(block.timestamp),
            vault: address(reservationVault),
            treasuryFee: 0,
            sweptAt: 0,
            extraData: bytes32(0)
        });
        self.pendingReservedDeposit[depositKey] = BridgeState
            .PendingReservedDeposit({
                isReserved: true,
                walletPubKeyHash: walletPubKeyHash,
                refundDeadline: refundDeadline,
                refundDeadlineValidated: true
            });
        self.pendingReservedDeposits += 1;
        self.reservations[depositKey].owner = depositor;

        // Store the funding tx hash for acceptance proofs
        depositFundingTxHash[depositKey] = fundingTxHash;
    }

    function registerLiveWallet(bytes20 walletPubKeyHash) external {
        self.registeredWallets[walletPubKeyHash].state = Wallets
            .WalletState
            .Live;
        self.liveWalletsCount += 1;
    }

    function requestReservationAcceptance(
        uint256 reservationKey,
        bytes20 walletPubKeyHash
    ) external {
        Reservation.requestReservationAcceptance(
            self,
            reservationKey,
            walletPubKeyHash
        );
    }

    function proveAcceptance(
        uint256 reservationKey,
        uint64 requestNonce,
        bytes32 anchorTxHash,
        uint64 anchorAmount
    ) external returns (bool late) {
        Reservation.ReservationAction storage action;
        (action, late) = ReservationProofs.loadSettleableAction(
            self,
            reservationKey,
            requestNonce,
            Reservation.ActionType.Acceptance
        );
        require(
            self.reservations[reservationKey].state ==
                Reservation.ReservationState.Unknown,
            "Reservation already exists"
        );
        require(
            self.pendingReservedDeposit[reservationKey].isReserved,
            "Deposit was not revealed as reserved"
        );

        ReservationProofs.consumeAcceptedDeposit(
            self,
            singleInputVector(depositFundingTxHash[reservationKey], 0),
            reservationKey
        );
        uint64 provenAmount = ReservationProofs.validateAnchorOutput(
            self,
            singleP2WPKHOutputVector(
                anchorAmount,
                action.targetWalletPubKeyHash
            ),
            action
        );
        ReservationProofs.settleAcceptance(
            self,
            reservationKey,
            requestNonce,
            action,
            late,
            anchorTxHash,
            provenAmount
        );
    }

    // ---------------------------------------------------------------------
    // Probes / helpers
    // ---------------------------------------------------------------------

    function isVaultTrusted(address vault) external view returns (bool) {
        return self.isVaultTrusted[vault];
    }

    function reservationVaultAddress() external view returns (address) {
        return address(reservationVault);
    }

    function tbtcVaultAddress() external view returns (address) {
        return address(tbtcVault);
    }

    function pendingReservedDepositsProbe() external view returns (uint64) {
        return self.pendingReservedDeposits;
    }

    function activeReservationsCountProbe() external view returns (uint32) {
        return self.activeReservationsCount;
    }

    function reservationRecord(
        uint256 key
    ) external view returns (Reservation.ReservationRequest memory) {
        return self.reservations[key];
    }

    function pendingReservedDepositProbe(
        uint256 key
    ) external view returns (BridgeState.PendingReservedDeposit memory) {
        return self.pendingReservedDeposit[key];
    }

    function isReservedDepositProbe(uint256 key) external view returns (bool) {
        return self.pendingReservedDeposit[key].isReserved;
    }

    function bankBalance(address owner) external view returns (uint256) {
        return bank.balanceOf(owner);
    }

    // ---------------------------------------------------------------------
    // Internal: single input/output vector builders (copied from handler)
    // ---------------------------------------------------------------------

    function singleInputVector(
        bytes32 txHash,
        uint32 outputIndex
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                uint8(1),
                txHash,
                BTCUtils.reverseUint32(outputIndex),
                uint8(0),
                uint32(0xffffffff)
            );
    }

    function singleP2WPKHOutputVector(
        uint64 value,
        bytes20 walletPubKeyHash
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                uint8(1),
                reverseUint64(value),
                hex"160014",
                walletPubKeyHash
            );
    }

    function reverseUint64(uint64 value) internal pure returns (uint64 r) {
        for (uint256 i = 0; i < 8; i++) {
            r = (r << 8) | (value & 0xff);
            value >>= 8;
        }
    }

    // Build the funding transaction for a reserved deposit, matching
    // ReservationStackHarness.buildFundingTx exactly.
    function buildFundingTx(
        address depositor,
        bytes20 walletPubKeyHash,
        bytes20 refundPubKeyHash,
        uint32 refundLocktime,
        bytes8 blindingFactor,
        uint64 amount
    ) internal view returns (BitcoinTx.Info memory fundingTx) {
        bytes memory script = expectedDepositScript(
            depositor,
            walletPubKeyHash,
            refundPubKeyHash,
            bytes4(BTCUtils.reverseUint32(refundLocktime)),
            blindingFactor
        );
        bytes memory outputVector = abi.encodePacked(
            uint8(1),
            reverseUint64(amount),
            hex"17a914",
            script.hash160View(),
            hex"87"
        );

        fundingTx.version = hex"01000000";
        fundingTx.inputVector = singleInputVector(
            keccak256(abi.encodePacked(depositor, walletPubKeyHash)),
            0
        );
        fundingTx.outputVector = outputVector;
        fundingTx.locktime = hex"01000000";
    }

    // Expected deposit script (matches ReservationStackHarness.expectedDepositScript)
    function expectedDepositScript(
        address depositor,
        bytes20 walletPubKeyHash,
        bytes20 refundPubKeyHash,
        bytes4 refundLocktime,
        bytes8 blindingFactor
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                hex"14",
                depositor,
                hex"75", // OP_DROP
                hex"08", // push 8
                blindingFactor,
                hex"75", // OP_DROP
                hex"76", // OP_DUP
                hex"a9", // OP_HASH160
                hex"14", // push 20
                walletPubKeyHash,
                hex"87", // OP_EQUAL
                hex"63", // OP_IF
                hex"ac", // OP_CHECKLOCKTIMEVERIFY
                hex"67", // OP_DROP
                hex"76", // OP_DUP
                hex"a9", // OP_HASH160
                hex"14", // push 20
                refundPubKeyHash,
                hex"87", // OP_EQUAL
                hex"68" // OP_ENDIF
            );
    }
}

/// @notice TM-11: A non-reservation credit through the Bank into a trusted
///         reservation vault mints gross and applies the initiation fee
///         with no reservation provenance.
contract ReservationNonReservationCreditTest is Test {
    uint256 internal constant SATOSHI_MULTIPLIER = 1e10;
    uint16 internal constant INITIATION_FEE_BPS = 40;
    uint256 internal constant BASIS_POINTS = 10000;

    address internal constant DEPOSITOR = address(0xA11CE);
    bytes20 internal constant WALLET = bytes20(uint160(0x5000));
    bytes8 internal constant BLINDING = bytes8(uint64(0xB1000000));
    bytes20 internal constant REFUND_KEY = bytes20(uint160(0xBEEF00));
    uint32 internal constant REFUND_LOCKTIME = uint32(0xFFFFFFFF);
    uint64 internal constant AMOUNT_SAT = 1_100_000;

    Tm11Harness internal h;

    function setUp() public {
        h = new Tm11Harness();
        h.registerLiveWallet(WALLET);
    }

    // ---------------------------------------------------------------------
    // TM-11 Main Test: non-reservation credit into the trusted reservation
    // vault mints gross, applies initiation fee, no reservation provenance
    // ---------------------------------------------------------------------

    function test_nonReservationBankCreditIntoTrustedReservationVaultMintsGrossAndChargesInitiationFee()
        public
    {
        // --- Establish the trusted reservation vault ---
        assertTrue(
            h.isVaultTrusted(h.reservationVaultAddress()),
            "vault not trusted"
        );
        assertEq(h.reservationVaultAddress(), h.reservationVaultAddress());

        // --- Record pre-credit state ---
        uint256 supplyBefore = h.tbtcToken().totalSupply();
        uint256 vaultTbtcBefore = h.tbtcToken().balanceOf(
            h.reservationVaultAddress()
        );
        uint256 depositorTbtcBefore = h.tbtcToken().balanceOf(DEPOSITOR);
        uint256 vaultBankBefore = h.bankBalance(h.reservationVaultAddress());
        uint256 tbtcVaultBankBefore = h.bankBalance(h.tbtcVaultAddress());
        uint64 pendingBefore = h.pendingReservedDepositsProbe();
        uint32 activeBefore = h.activeReservationsCountProbe();

        // --- Drive the non-reservation credit through the Bank ---
        // This is a genuine Bank-routed credit (Bank.increaseBalanceAndCall)
        // into the trusted reservation vault with NO reservation acceptance
        // proof, no reservation key, no pending reserved deposit.
        h.creditTrustedReservationVault(DEPOSITOR, AMOUNT_SAT);

        // --- Expected values ---
        uint256 grossTbtc = uint256(AMOUNT_SAT) * SATOSHI_MULTIPLIER;
        uint256 feeTbtc = (grossTbtc * INITIATION_FEE_BPS) / BASIS_POINTS;
        uint256 netTbtc = grossTbtc - feeTbtc;

        // --- Assertions: the vault mints gross, depositor receives net, fee retained ---
        assertEq(
            h.tbtcToken().totalSupply(),
            supplyBefore + grossTbtc,
            "total TBTC supply grew by gross amount"
        );
        assertEq(
            h.tbtcToken().balanceOf(DEPOSITOR),
            depositorTbtcBefore + netTbtc,
            "depositor receives gross minus initiation fee"
        );
        assertEq(
            h.tbtcToken().balanceOf(h.reservationVaultAddress()),
            vaultTbtcBefore + feeTbtc,
            "vault retains the initiation fee"
        );

        // --- Bank balances: the credit moved totalSat satoshi from the vault's
        //     Bank balance to the TBTCVault's Bank balance (the mint consumed it) ---
        assertEq(
            h.bankBalance(h.reservationVaultAddress()),
            vaultBankBefore,
            "vault's Bank balance is unchanged (credit was fully converted)"
        );
        assertEq(
            h.bankBalance(h.tbtcVaultAddress()),
            tbtcVaultBankBefore + AMOUNT_SAT,
            "TBTCVault's Bank balance grew by the credited satoshi"
        );
        assertEq(
            h.bankBalance(DEPOSITOR),
            0,
            "depositor received no Bank balance (pooled path did not fire)"
        );

        // --- No reservation provenance was created ---
        assertEq(
            h.activeReservationsCountProbe(),
            activeBefore,
            "activeReservationsCount unchanged"
        );
        assertEq(
            h.pendingReservedDepositsProbe(),
            pendingBefore,
            "pendingReservedDeposits unchanged"
        );

        // No reservation record exists for this credit: the vault's credit
        // carries no reservation key. The Bridge's reservation records are
        // untouched. We can probe a representative key (0) to show the
        // reservation mapping is untouched.
        Reservation.ReservationRequest memory rec = h.reservationRecord(0);
        assertEq(
            uint8(rec.state),
            0,
            "no reservation record at key 0 (Unknown)"
        );
        assertEq(rec.owner, address(0), "no owner set on empty key");
        assertEq(rec.mintedAmount, 0, "no mintedAmount recorded");
    }

    // ---------------------------------------------------------------------
    // Positive Control 1: The pooled path does NOT mint TBTC and charges
    // no fee. The depositor only receives a Bank balance. This shows the
    // two paths are distinguishable: vault path mints with fee; pooled
    // path mints nothing.
    // ---------------------------------------------------------------------

    function test_pooledBankCreditDoesNotMintTbtcAndChargesNoFee() public {
        assertTrue(
            h.isVaultTrusted(h.reservationVaultAddress()),
            "vault trusted"
        );

        uint256 supplyBefore = h.tbtcToken().totalSupply();
        uint256 depositorTbtcBefore = h.tbtcToken().balanceOf(DEPOSITOR);
        uint256 vaultBankBefore = h.bankBalance(h.reservationVaultAddress());
        uint256 depositorBankBefore = h.bankBalance(DEPOSITOR);
        uint256 vaultTbtcBefore = h.tbtcToken().balanceOf(
            h.reservationVaultAddress()
        );

        // Pooled path: bank.increaseBalances (the else branch of the Bridge
        // routing decision). The harness IS the Bank's bridge so it can call
        // this directly.
        h.creditPooled(DEPOSITOR, AMOUNT_SAT);

        // No TBTC minted at all
        assertEq(
            h.tbtcToken().totalSupply(),
            supplyBefore,
            "pooled path mints no TBTC"
        );
        assertEq(
            h.tbtcToken().balanceOf(DEPOSITOR),
            depositorTbtcBefore,
            "depositor receives no TBTC"
        );
        assertEq(
            h.tbtcToken().balanceOf(h.reservationVaultAddress()),
            vaultTbtcBefore,
            "vault receives no TBTC"
        );

        // Bank balance moved to the depositor
        assertEq(
            h.bankBalance(DEPOSITOR),
            depositorBankBefore + AMOUNT_SAT,
            "depositor's Bank balance grew by the credited satoshi"
        );

        // Reservation vault's Bank balance untouched
        assertEq(
            h.bankBalance(h.reservationVaultAddress()),
            vaultBankBefore,
            "vault's Bank balance unchanged"
        );

        // No fee retained
        assertEq(
            h.tbtcToken().balanceOf(h.reservationVaultAddress()),
            vaultTbtcBefore,
            "no fee retained"
        );
    }

    // ---------------------------------------------------------------------
    // Positive Control 2: A REAL reservation acceptance credit routes
    // through the SAME vault path (Bank.increaseBalanceAndCall into the
    // trusted reservation vault), mints gross minus the SAME initiation fee,
    // and the vault retains the fee — EXACTLY the same fee treatment.
    // The difference is that a RESERVATION RECORD is created.
    // This proves the ordinary-credit path mints with the SAME reservation-
    // specific fee treatment as the reservation path.
    // ---------------------------------------------------------------------

    function test_reservationAcceptanceCreditHasIdenticalFeeTreatmentButCreatesProvenance()
        public
    {
        // --- Setup the reservation machinery ---
        bytes20 wallet = WALLET;
        uint32 refundDeadline = uint32(block.timestamp + 60 days);
        uint64 amount = AMOUNT_SAT;

        // Reveal a reserved deposit (the depositor is this contract so we can
        // request acceptance).
        uint256 depositKey = h.revealReservedDeposit(
            address(this),
            WALLET,
            BLINDING,
            REFUND_KEY,
            REFUND_LOCKTIME,
            AMOUNT_SAT,
            uint32(block.timestamp + 60 days)
        );

        // Verify it's a reserved deposit and no reservation yet
        assertTrue(
            h.isReservedDepositProbe(depositKey),
            "deposit marked reserved"
        );
        Reservation.ReservationRequest memory beforeRec = h.reservationRecord(
            depositKey
        );
        assertEq(uint8(beforeRec.state), 0, "state Unknown before acceptance");
        assertEq(
            beforeRec.mintedAmount,
            0,
            "no mintedAmount before acceptance"
        );
        uint64 pendingBefore = h.pendingReservedDepositsProbe();
        uint32 activeBefore = h.activeReservationsCountProbe();
        assertEq(pendingBefore, 1, "one pending reserved deposit");
        assertEq(activeBefore, 0, "no active reservations yet");

        // Request acceptance (depositor = this contract = msg.sender)
        h.requestReservationAcceptance(depositKey, WALLET);

        // Prove acceptance: on-time, anchor amount = amount - fee
        uint64 anchorAmount = AMOUNT_SAT - 10_000; // fee within txMaxFee
        bytes32 anchorTxHash = keccak256(
            abi.encode("surfaceAnchor", depositKey)
        );
        uint64 nonce = h.reservationRecord(depositKey).requestNonce;
        h.proveAcceptance(depositKey, nonce, anchorTxHash, anchorAmount);

        // --- Assertions: SAME fee treatment as the non-reservation credit ---
        uint256 grossTbtc = uint256(anchorAmount) * SATOSHI_MULTIPLIER;
        uint256 feeTbtc = (grossTbtc * INITIATION_FEE_BPS) / BASIS_POINTS;
        uint256 netTbtc = grossTbtc - feeTbtc;

        // The acceptance credit went to THIS contract (the depositor of the
        // reserved deposit), so our TBTC balance grew by netTbtc.
        assertEq(
            h.tbtcToken().balanceOf(address(this)),
            netTbtc,
            "depositor receives gross minus SAME initiation fee"
        );
        assertEq(
            h.tbtcToken().balanceOf(h.reservationVaultAddress()),
            feeTbtc,
            "vault retains SAME fee"
        );
        assertEq(
            h.tbtcToken().totalSupply(),
            grossTbtc,
            "total supply grew by gross"
        );

        // BUT provenance WAS created: activeReservationsCount incremented,
        // pendingReservedDeposits cleared, reservation record is Active.
        assertEq(
            h.activeReservationsCountProbe(),
            1,
            "activeReservationsCount incremented"
        );
        assertEq(
            h.pendingReservedDepositsProbe(),
            0,
            "pendingReservedDeposits cleared on acceptance"
        );
        Reservation.ReservationRequest memory afterRec = h.reservationRecord(
            depositKey
        );
        assertEq(uint8(afterRec.state), 1, "state Active after acceptance");
        assertEq(afterRec.mintedAmount, anchorAmount, "mintedAmount recorded");
        assertEq(afterRec.owner, address(this), "owner recorded");
        assertGt(afterRec.acceptedAt, 0, "acceptedAt timestamp set");
    }

    // ---------------------------------------------------------------------
    // NEGATIVE CONTROL: break the vault's fee treatment and show the test
    // would fail (documented here; executed manually by changing
    // ReservationVault.SATOSHI_MULTIPLIER to 10**9 and running the test).
    // ---------------------------------------------------------------------
    // Negative control is documented; actual execution done in the lab and
    // recorded in the report. The break tested: change
    // `ReservationVault.SATOSHI_MULTIPLIER = 10 ** 10` to `10 ** 9`
    // (under-mints by 10x). The test's grossTbtc assertions fail.
    // Restore with: git checkout -- solidity/contracts/vault/ReservationVault.sol
}
