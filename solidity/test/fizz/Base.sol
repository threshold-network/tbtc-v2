// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import {Actor} from "./Actor.sol";
import {Clamp} from "./utils/Clamp.sol";
import {Deployer} from "./utils/Deployer.sol";
import {vm} from "./utils/Hevm.sol";
import {Logger} from "./utils/Logger.sol";
import {Math} from "./utils/Math.sol";
import {StringUtils} from "./utils/StringUtils.sol";
import {EnumerableSet} from "./utils/EnumerableSet.sol";
import {MockERC20} from "./utils/MockERC20.sol";
import {BtcBuilder} from "./utils/BtcBuilder.sol";
import {MockWalletRegistry} from "./mocks/MockWalletRegistry.sol";

import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ReimbursementPool} from "@keep-network/random-beacon/contracts/ReimbursementPool.sol";

import {Bank} from "../../contracts/bank/Bank.sol";
import {TBTC} from "../../contracts/token/TBTC.sol";
import {TBTCVault} from "../../contracts/vault/TBTCVault.sol";
import {ReservationVault} from "../../contracts/vault/ReservationVault.sol";
import {Bridge} from "../../contracts/bridge/Bridge.sol";
import {BitcoinTx} from "../../contracts/bridge/BitcoinTx.sol";
import {IReservationBridge} from "../../contracts/bridge/IReservationBridge.sol";
import {RebateStaking} from "../../contracts/bridge/RebateStaking.sol";
import {RedemptionWatchtower} from "../../contracts/bridge/RedemptionWatchtower.sol";
import {ReservationRouter} from "../../contracts/bridge/ReservationRouter.sol";
import {SystemTestRelay} from "../../contracts/test/SystemTestRelay.sol";

/// @notice Base contract with state variables and setup functions
abstract contract Base is StringUtils, Clamp, Deployer, Math {
    string[] internal ACTOR_LABELS = ["Alice", "Bob", "Charlie"];
    uint256 internal constant BLOCK_INTERVAL = 12 seconds;
    uint256 internal constant INITIAL_ETH_BALANCE = 1_000 ether;
    /// @dev Whole T tokens (18 decimals) seeded to each actor.
    uint256 internal constant INITIAL_TOKEN_BALANCE = 10_000;

    /// @dev Chain clock at the start of `setup()`. Foundry and Medusa start
    ///      near timestamp 1, where `RebateStaking.getRebateInRollingWindow`
    ///      (`block.timestamp - rollingWindow`) underflows; mainnet is at
    ///      ~1.7e9. Fits `uint32` (max ~4.29e9) with ~2.6e9 s of headroom for
    ///      the `uint32` timestamps the Bridge stores.
    uint256 internal constant SETUP_TIMESTAMP = 1_700_000_000;
    uint256 internal constant SETUP_BLOCK = 18_000_000;

    /// @dev uint32 timestamps in Bridge, Wallets, Fraud, Redemption and RebateStaking wrap in 2106. Every
    ///      handler that jumps the clock by a governance-controlled amount checks `clockHasRoom` first.
    uint256 internal constant FIZZ_CLOCK_CEILING = 4_000_000_000;

    /// @dev Converts satoshi to TBTC token units.
    uint256 internal constant SATOSHI_MULTIPLIER = 1e10;
    /// @dev Bank balance (satoshi) credited to each actor at setup, on top of
    ///      the part converted to TBTC. Credited through a setup-only prank as
    ///      the Bridge.
    uint256 internal constant ACTOR_BANK_BALANCE_SAT = 2_000_000_000; // 20 BTC
    /// @dev Part of the actor Bank balance converted to TBTC through
    ///      `TBTCVault.mint` at setup (TBTC supply stays fully backed by the
    ///      TBTCVault's Bank balance).
    uint256 internal constant ACTOR_TBTC_MINT_SAT = 1_000_000_000; // 10 BTC

    // ――――――――――――――――――――― Bridge parameters ――――――――――――――――――――――
    // Small, fuzz-friendly values. Every timeout is <= 7 days so that it is
    // reachable within Medusa's maximum timestamp delay (604800 s) of a few
    // calls, and every amount fits the seeded balances.

    // Deposits
    uint64 internal constant DEPOSIT_DUST_THRESHOLD = 10_000; // sat
    uint64 internal constant DEPOSIT_TREASURY_FEE_DIVISOR = 2000; // 5 bps
    uint64 internal constant DEPOSIT_TX_MAX_FEE = 1_000; // sat
    uint32 internal constant DEPOSIT_REVEAL_AHEAD_PERIOD = 1 days;

    // Redemptions
    uint64 internal constant REDEMPTION_DUST_THRESHOLD = 10_000; // sat
    uint64 internal constant REDEMPTION_TREASURY_FEE_DIVISOR = 2000; // 5 bps
    uint64 internal constant REDEMPTION_TX_MAX_FEE = 1_000; // sat
    uint64 internal constant REDEMPTION_TX_MAX_TOTAL_FEE = 5_000; // sat
    uint32 internal constant REDEMPTION_TIMEOUT = 1 days;
    uint96 internal constant REDEMPTION_TIMEOUT_SLASHING_AMOUNT = 100 ether; // 100 T
    uint32 internal constant REDEMPTION_TIMEOUT_NOTIFIER_REWARD_MULTIPLIER =
        100;

    // Moving funds / moved funds sweep
    uint64 internal constant MOVING_FUNDS_TX_MAX_TOTAL_FEE = 5_000; // sat
    uint64 internal constant MOVING_FUNDS_DUST_THRESHOLD = 5_000; // sat, < redemption dust
    uint32 internal constant MOVING_FUNDS_TIMEOUT_RESET_DELAY = 1 days;
    uint32 internal constant MOVING_FUNDS_TIMEOUT = 3 days; // > reset delay
    uint96 internal constant MOVING_FUNDS_TIMEOUT_SLASHING_AMOUNT = 100 ether;
    uint32 internal constant MOVING_FUNDS_TIMEOUT_NOTIFIER_REWARD_MULTIPLIER =
        100;
    uint16 internal constant MOVING_FUNDS_COMMITMENT_GAS_OFFSET = 15_000;
    uint64 internal constant MOVED_FUNDS_SWEEP_TX_MAX_TOTAL_FEE = 5_000; // sat
    uint32 internal constant MOVED_FUNDS_SWEEP_TIMEOUT = 3 days;
    uint96 internal constant MOVED_FUNDS_SWEEP_TIMEOUT_SLASHING_AMOUNT =
        100 ether;
    uint32
        internal
        constant MOVED_FUNDS_SWEEP_TIMEOUT_NOTIFIER_REWARD_MULTIPLIER = 100;

    // Wallets
    uint32 internal constant WALLET_CREATION_PERIOD = 1 days;
    uint64 internal constant WALLET_CREATION_MIN_BTC_BALANCE = 0; // sat
    uint64 internal constant WALLET_CREATION_MAX_BTC_BALANCE = 10_000_000; // 0.1 BTC
    uint64 internal constant WALLET_CLOSURE_MIN_BTC_BALANCE = 50_000; // sat
    uint32 internal constant WALLET_MAX_AGE = 14 days;
    uint64 internal constant WALLET_MAX_BTC_TRANSFER = 5_000_000; // sat
    uint32 internal constant WALLET_CLOSING_PERIOD = 2 days;

    // Fraud
    uint96 internal constant FRAUD_CHALLENGE_DEPOSIT_AMOUNT = 1 ether;
    uint32 internal constant FRAUD_CHALLENGE_DEFEAT_TIMEOUT = 1 days;
    uint96 internal constant FRAUD_SLASHING_AMOUNT = 100 ether; // 100 T
    uint32 internal constant FRAUD_NOTIFIER_REWARD_MULTIPLIER = 100;

    // Reservations (values of deploy/97_set_reservation_parameters.ts; caps
    // MUST be set before parameters, see docs/RESERVATION_CAPS_DEPLOYMENT.md)
    uint64 internal constant RESERVATION_MAX_AMOUNT_PER_WALLET = 1_000_000;
    uint64 internal constant RESERVATION_MAX_SINGLE_AMOUNT = 100_000;
    uint32 internal constant MAX_ACTIVE_RESERVATIONS = 100;
    uint64 internal constant RESERVATION_MIN_AMOUNT = 10_000;
    uint64 internal constant RESERVATION_TX_MAX_FEE = 1_000;
    uint32 internal constant RESERVATION_TERM_SECONDS = 90 days; // MIN_RESERVATION_TERM
    uint32 internal constant RESERVATION_DISSOLUTION_DELAY = 1 days;
    uint64 internal constant RESERVATION_MAX_TOTAL_AMOUNT = 10_000_000; // <= 100 * 100_000
    uint32 internal constant MAX_RESERVATIONS_PER_WALLET = 5;
    uint32 internal constant RESERVATION_ACTION_TIMEOUT = 1 days; // > 2h safety margin
    uint32 internal constant RESERVATION_RENEWAL_WINDOW_SECONDS = 1 days; // < term
    uint32 internal constant MAX_THIRD_PARTY_REANCHOR_HOLDS_PER_WALLET = 1;
    uint32 internal constant HANDOFF_RESERVE_WALLETS = 1;

    // Rebate staking
    uint256 internal constant REBATE_ROLLING_WINDOW = 7 days;
    uint256 internal constant REBATE_UNSTAKING_PERIOD = 1 days;
    /// @dev T wei per satoshi of rebate cap: 10_000 T staked => 1 BTC cap.
    uint256 internal constant REBATE_PER_TOKEN = 1e14;

    // Reimbursement pool (values of keep-network's mainnet pool)
    uint256 internal constant REIMBURSEMENT_STATIC_GAS = 40_800;
    uint256 internal constant REIMBURSEMENT_MAX_GAS_PRICE = 500 gwei;
    uint256 internal constant REIMBURSEMENT_POOL_FUNDING = 100 ether;

    // ―――――――――――――――――――――― Wallet signing keys ――――――――――――――――――――――
    // secp256k1 keypairs computed offline (`cast wallet public-key`).
    // Handlers sign fraud / heartbeat payloads with `vm.sign(privKey, digest)`.

    uint256 internal constant WALLET_PRIV_KEY_0 = 0xf1221;
    bytes32 internal constant WALLET_PUB_X_0 =
        0x74445e9cdc78ae5f299798d0208db846a5f31e5c3ff00b6aa1848c1dd5b28347;
    bytes32 internal constant WALLET_PUB_Y_0 =
        0x349359ae55322aa190340ade43f8875b5d43a8a53588814a5f9596b566d5bc6c;

    uint256 internal constant WALLET_PRIV_KEY_1 = 0xf1222;
    bytes32 internal constant WALLET_PUB_X_1 =
        0xc801e31bf5a3a983ee6239aee28d2ee2219a62837a3bc59dedb3e9c1ead639ef;
    bytes32 internal constant WALLET_PUB_Y_1 =
        0x890ce9accc395dc90c20dac109f379fd5987a6a1b66e1c35ae6d418b7498ba35;

    uint256 internal constant WALLET_PRIV_KEY_2 = 0xf1223;
    bytes32 internal constant WALLET_PUB_X_2 =
        0x23b48aabbb6425377b8df4f8ae8ad320c3367d50258c11c374566b284acffe05;
    bytes32 internal constant WALLET_PUB_Y_2 =
        0x2207cbdb3a359bfa221c12b039c84e8c0658d965d82c1f7a8bb2c18e89fa2626;

    uint256 internal constant WALLET_PRIV_KEY_3 = 0xf1224;
    bytes32 internal constant WALLET_PUB_X_3 =
        0x04263370fd59f1afe6d4bfcca1f2c76939034fdfe8c65fa09a4df8def79093c8;
    bytes32 internal constant WALLET_PUB_Y_3 =
        0xb1b14c42124ab2b87a4b190d8979bd762a4f503bccce5bf392a441e9c4f2f67e;

    uint256 internal constant WALLET_PRIV_KEY_4 = 0xf1225;
    bytes32 internal constant WALLET_PUB_X_4 =
        0xa2085ded148f0680a11cee41586f3011247a6050b2cbe757207b716bca64b66b;
    bytes32 internal constant WALLET_PUB_Y_4 =
        0x6ec3c037264d1d118e2a9d73c71e284764a66d24d98a00fb4ea8a65a4aab7e17;

    uint256 internal constant WALLET_PRIV_KEY_5 = 0xf1226;
    bytes32 internal constant WALLET_PUB_X_5 =
        0x526443e951e06587c795c79047ce821a08633684c927e3d66a5379dcdfd981ff;
    bytes32 internal constant WALLET_PUB_Y_5 =
        0x5ff3f1d5c4217d90716e8f4ce82383ae9e5aad049bd023d98546c311b7a532fa;

    /// @dev Wallet keypairs, filled by `_initWalletKeys` in `setup()`. Index i
    ///      of the three arrays belongs to the same keypair.
    uint256[] internal walletPrivKeys;
    bytes32[] internal walletPubX;
    bytes32[] internal walletPubY;
    /// @dev Wallet public key hash => index in the wallet key arrays. Only
    ///      meaningful for wallets in `harnessWallets` (index 0 is also the
    ///      default value for unknown hashes).
    mapping(bytes20 => uint256) internal walletKeyIndex;

    // ―――――――――――――――――――――――――― Ghosts ――――――――――――――――――――――――――

    using EnumerableSet for EnumerableSet.UintSet;

    /// @dev Hard cap for every harness-array loop and admission control.
    uint256 internal constant FIZZ_SCAN_CAP = 64;
    /// @dev Keys scanned per call by cursor-based shadow checks.
    uint256 internal constant FIZZ_CURSOR_STEP = 8;
    /// @dev Bank balance (sat) credited to the actors at setup
    ///      (`actors.length * ACTOR_BANK_BALANCE_SAT`); not Bitcoin-backed.
    uint256 internal constant INIT_BANK_SAT = 3 * ACTOR_BANK_BALANCE_SAT;

    /// @dev Handler ids for `ghosts.lastHandlerId`.
    uint8 internal constant HID_NONE = 0;
    uint8 internal constant HID_REVEAL_RESERVED = 1;
    uint8 internal constant HID_REQUEST_ACCEPTANCE = 2;
    uint8 internal constant HID_ACCEPTANCE_PROOF = 3;
    uint8 internal constant HID_ACCEPTANCE_TIMEOUT = 4;
    uint8 internal constant HID_REQUEST_REANCHOR = 5;
    uint8 internal constant HID_REANCHOR_PROOF = 6;
    uint8 internal constant HID_ACTION_TIMEOUT = 7;
    uint8 internal constant HID_STRAND = 8;
    uint8 internal constant HID_STALE = 9;
    uint8 internal constant HID_FORCE_STALE = 10;
    uint8 internal constant HID_REPAY = 11;
    uint8 internal constant HID_SWEEP_FEES = 12;

    struct LastAcceptance {
        address depositor;
        uint64 anchorAmount;
        uint256 key;
        bool trustedBefore;
        uint16 bpsBefore;
    }

    struct RebateGrant {
        address staker;
        uint32 timestamp;
        uint64 rebate;
        bool live;
    }

    /// @dev kind: 0 deposit, 1 anchor, 2 consumed anchor, 3 stranded anchor.
    struct HonestOutpoint {
        bytes32 txHash;
        uint32 index;
        uint8 kind;
    }

    /// @dev Ghosts are written ONLY by handlers (after the protocol call
    ///      succeeded); property calls run on throw-away state under Medusa.
    struct Ghosts {
        // Donations / untracked flows.
        uint256 bankDonatedToTbtcVaultSat;
        uint256 bankDonatedToRvSat;
        uint256 bankDonatedToBridgeSat;
        uint256 bankDonatedToWatchtowerSat;
        uint256 bankToUntrackedSat;
        uint256 tbtcDonatedToRvWei;
        uint256 tbtcToUntrackedWei;
        uint256 tbtcBurnedDirectWei;
        uint256 ethDonatedToBridgeWei;
        bool anyDonation;
        uint256 lastFuzzedAmount;
        // Bank / Bitcoin ledgers.
        uint256 bankIssuedSat;
        uint256 bankBurnedSat;
        uint256 btcCustodySat;
        int256 absorbedFeeSat;
        // Per-wallet Bitcoin fee the wallet paid beyond what it charged requests.
        mapping(bytes20 => uint256) walletFeeSlackSat;
        // forceStakeTransfer copies the history to the new staker; rebatePerToken changes re-base the bound.
        mapping(address => bool) rebateHistoryMoved;
        uint256 rebatePerTokenChangedAt;
        uint256 minerFeeSat;
        // ReservationVault ledgers.
        uint256 rvFeesRetainedWei;
        uint256 rvFeesSweptWei;
        uint256 rvFinanceBurnedSat;
        uint256 rvShortfallSat;
        uint256 rvDebtRepaidSat;
        uint256 rvSweepDebtBurnedSat;
        // Reservation shadows / images.
        mapping(uint256 => uint64) initialAnchor;
        mapping(uint256 => uint8) prevResState;
        mapping(uint256 => uint64) prevResAnchor;
        mapping(uint256 => uint64) prevResCumFee;
        mapping(uint256 => uint64) prevNonce;
        mapping(uint256 => mapping(uint64 => uint8)) prevActionState;
        mapping(uint256 => bytes32) acceptedImageHash;
        mapping(bytes32 => bytes32) actionImageHash;
        mapping(uint256 => bytes32) depositImageHash;
        mapping(uint256 => uint32) depositSweptAt;
        mapping(uint256 => uint32) refundDeadline;
        uint256[] reservedDepositKeys;
        uint256[] consumedAnchors;
        mapping(uint256 => bool) everSpent;
        uint256[] knownUtxoKeys;
        bool lateFlag;
        LastAcceptance lastAcceptance;
        mapping(uint256 => uint32) strandedAt;
        uint8 lastHandlerId;
        // Wallet shadows.
        mapping(bytes20 => uint8) prevWalletState;
        mapping(bytes20 => uint32) prevCreatedAt;
        mapping(bytes20 => uint32) prevMovingFundsRequestedAt;
        mapping(bytes20 => uint32) prevClosingStartedAt;
        mapping(bytes20 => bool) hadMainUtxoWhenMovingFunds;
        mapping(bytes20 => bool) hadProvenAnchorsWhenMovingFunds;
        mapping(uint256 => uint8) prevSweepState;
        uint256[] movedFundsKeys;
        bytes20[] lastMovedTargets;
        uint256[] challengeKeys;
        // Optimistic minting.
        uint256[] omFinalizedKeys;
        mapping(address => uint256) prevOptDebt;
        mapping(uint256 => uint64) prevOptRequestedAt;
        mapping(uint256 => uint64) prevOptFinalizedAt;
        // Redemptions / rebates / veto.
        EnumerableSet.UintSet pendingRedemptionKeys;
        mapping(uint256 => uint64) fullTreasuryFee;
        mapping(uint256 => uint64) rebateApplied;
        bool sameBlockSecondRebate;
        RebateGrant[] rebateGrants;
        mapping(address => uint256) prevRebateLen;
        mapping(address => uint256) prevRebateFeeSum;
        mapping(uint256 => uint8) prevVetoObjections;
        mapping(uint256 => uint32) prevVetoFinalizedAt;
        mapping(uint256 => uint64) prevVetoWithdrawable;
        mapping(address => bool) unbanned;
        mapping(uint256 => address) requesterOf;
        uint256[] vetoKeys;
        // Watchtower / governance flags.
        bool watchtowerParamsUpdated;
        uint256 maxWatchtowerLifetime;
        bool watchtowerDisabledSeen;
        bool vaultTrustRevoked;
        bool capsLoweredBelowOccupancy;
        // Settled moved-funds sweeps (proof or timeout), the
        // `optimize_movedFundsSweepDepth` objective.
        uint256 sweepsSettled;
        HonestOutpoint[] honestOutpoints;
    }

    Ghosts internal ghosts;

    // ――――――――――――――――――― Harness Bitcoin bookkeeping ――――――――――――――――――――
    // The Bridge stores only hashes of Bitcoin data; handlers need the
    // preimages to build valid SPV proofs, so the harness records them.

    struct HarnessDeposit {
        bytes32 fundingTxHash;
        uint32 outputIndex;
        uint64 amount;
        address depositor;
        address vault;
        bytes20 walletPkh;
        bool reserved;
        bool swept;
    }

    struct HarnessRedemption {
        bytes20 walletPkh;
        bytes redeemerOutputScript;
        address redeemer;
        uint64 amount;
        bool closed;
    }

    HarnessDeposit[] internal harnessDeposits;
    /// @dev Every wallet created via the registry callback.
    bytes20[] internal harnessWallets;
    /// @dev Spare Live wallet that satisfies the reservation hand-off reserve
    ///      gate. Not part of `harnessWallets`.
    bytes20 internal handoffSpareWallet;
    /// @dev Preimage of `wallet.mainUtxoHash` (txHash 0 means no main UTXO).
    mapping(bytes20 => BitcoinTx.UTXO) internal harnessMainUtxo;
    HarnessRedemption[] internal harnessRedemptions;
    /// @dev Exact funding transaction of every deposit revealed this
    /// session (R-01: an acceptance request must prove the funding tx on
    /// Bitcoin, so the harness keeps the `BitcoinTx.Info` the reveal used
    /// plus its output index): deposit key => funding, `info.inputVector`
    /// empty = not recorded here.
    struct HarnessFunding {
        BitcoinTx.Info info;
        uint32 outputIndex;
    }
    mapping(uint256 => HarnessFunding) internal harnessDepositFundings;
    uint256[] internal harnessReservationKeys;

    // ―――――――――――――――――――――――――― Actors ――――――――――――――――――――――――――

    address[] internal actors;
    address internal actor;
    address internal admin;

    // ―――――――――――――――――――――――――― Roles ―――――――――――――――――――――――――――
    // Distinct, code-less addresses; handlers impersonate them with
    // `vm.prank` / `vm.startPrank`.

    /// @dev Bridge governance and owner of Bank, TBTCVault, ReservationVault,
    ///      RebateStaking, RedemptionWatchtower and ReimbursementPool.
    address internal governance;
    address internal spvMaintainer;
    address internal treasury;
    address internal watchtowerManager;
    /// @dev Dedicated TransparentUpgradeableProxy admin; never used as a
    ///      caller of implementation functions.
    address internal proxyAdmin;
    /// @dev Redemption watchtower guardians, also TBTCVault guardians.
    address[] internal guardians;
    /// @dev TBTCVault optimistic minters.
    address[] internal minters;

    modifier asActor() virtual {
        vm.startPrank(actor);
        _;
        vm.stopPrank();
    }

    modifier asAdmin() virtual {
        vm.startPrank(admin);
        _;
        vm.stopPrank();
    }

    /// @dev Bridge governance and owner of Bank, TBTCVault, ReservationVault,
    ///      RebateStaking, RedemptionWatchtower and ReimbursementPool.
    modifier asGovernance() {
        vm.startPrank(governance);
        _;
        vm.stopPrank();
    }

    modifier asSpvMaintainer() {
        vm.startPrank(spvMaintainer);
        _;
        vm.stopPrank();
    }

    modifier asWatchtowerManager() {
        vm.startPrank(watchtowerManager);
        _;
        vm.stopPrank();
    }

    /// @dev Picks one of `guardians` (watchtower + TBTCVault guardians) from a fuzzed seed.
    modifier asGuardian(uint256 seed) {
        vm.startPrank(guardians[seed % guardians.length]);
        _;
        vm.stopPrank();
    }

    /// @dev Picks one of `minters` (TBTCVault optimistic minters) from a fuzzed seed.
    modifier asMinter(uint256 seed) {
        vm.startPrank(minters[seed % minters.length]);
        _;
        vm.stopPrank();
    }

    // ―――――――――――――――――――――――― Contracts ―――――――――――――――――――――――――

    Bank public bank;
    TBTC public tbtc;
    TBTCVault public tbtcVault;
    /// @dev Transparent proxy of the Bridge.
    Bridge public bridge;
    Bridge internal bridgeImpl;
    /// @dev The Bridge itself: router calls go through `Bridge.fallback`,
    ///      which delegatecalls `reservationRouterImpl`.
    ReservationRouter public reservationRouter;
    ReservationRouter public reservationRouterImpl;
    ReservationVault public reservationVault;
    /// @dev Transparent proxy of RebateStaking.
    RebateStaking public rebateStaking;
    RebateStaking internal rebateStakingImpl;
    /// @dev Transparent proxy of RedemptionWatchtower.
    RedemptionWatchtower public redemptionWatchtower;
    RedemptionWatchtower internal redemptionWatchtowerImpl;
    SystemTestRelay public relay;
    MockWalletRegistry public walletRegistry;
    ReimbursementPool public reimbursementPool;
    /// @dev Stand-in for the T token (staking token of RebateStaking).
    MockERC20 public tToken;

    // ―――――――――――――――――――――――――― Setup ―――――――――――――――――――――――――――

    function setup() internal {
        vm.warp(SETUP_TIMESTAMP);
        vm.roll(SETUP_BLOCK);

        admin = address(this);
        vm.label(admin, "Admin");

        _initRoles();
        _initWalletKeys();

        // External dependencies.
        tToken = new MockERC20(
            address(this),
            0,
            "Threshold Network Token",
            "T",
            18
        );
        vm.label(address(tToken), "T");

        relay = new SystemTestRelay();
        relay.setCurrentEpochDifficulty(BtcBuilder.RELAY_EPOCH_DIFFICULTY);
        relay.setPrevEpochDifficulty(BtcBuilder.RELAY_EPOCH_DIFFICULTY);
        vm.label(address(relay), "SystemTestRelay");

        reimbursementPool = new ReimbursementPool(
            REIMBURSEMENT_STATIC_GAS,
            REIMBURSEMENT_MAX_GAS_PRICE
        );
        (bool funded, ) = address(reimbursementPool).call{
            value: REIMBURSEMENT_POOL_FUNDING
        }("");
        require(funded, "Base: reimbursement pool funding failed");
        vm.label(address(reimbursementPool), "ReimbursementPool");

        walletRegistry = new MockWalletRegistry();
        vm.label(address(walletRegistry), "WalletRegistry");

        // Core: Bank, TBTC, Bridge (+ reservation router facet).
        bank = new Bank();
        vm.label(address(bank), "Bank");
        tbtc = new TBTC();
        vm.label(address(tbtc), "TBTC");

        // Bridge governance is the deployer (`initialize` calls
        // `_transferGovernance(msg.sender)` and `msg.sender` is this contract,
        // which creates the proxy); it is handed to `governance` at the end of
        // the setup. `initialize` is `initializer`-guarded and the
        // implementation constructor calls `_disableInitializers()`, hence the
        // proxy.
        bridgeImpl = new Bridge();
        vm.label(address(bridgeImpl), "BridgeImpl");
        bridge = Bridge(
            address(
                new TransparentUpgradeableProxy(
                    address(bridgeImpl),
                    proxyAdmin,
                    abi.encodeCall(
                        Bridge.initialize,
                        (
                            address(bank),
                            address(relay),
                            treasury,
                            address(walletRegistry),
                            payable(address(reimbursementPool)),
                            BtcBuilder.TX_PROOF_DIFFICULTY_FACTOR
                        )
                    )
                )
            )
        );
        vm.label(address(bridge), "Bridge");

        walletRegistry.setWalletOwner(address(bridge));
        reimbursementPool.authorize(address(bridge));
        bank.updateBridge(address(bridge));

        // `ReservationRouter` is a non-proxied facet: Bridge.fallback
        // delegatecalls it on the Bridge's own storage. `setReservationRouter`
        // is write-once and must precede every reservation setter.
        reservationRouterImpl = new ReservationRouter();
        vm.label(address(reservationRouterImpl), "ReservationRouterImpl");
        bridge.setReservationRouter(address(reservationRouterImpl));
        reservationRouter = ReservationRouter(address(bridge));

        // TBTCVault owns TBTC (it mints and burns) and is a trusted vault.
        tbtcVault = new TBTCVault(bank, tbtc, bridge);
        vm.label(address(tbtcVault), "TBTCVault");
        tbtc.transferOwnership(address(tbtcVault));
        bridge.setVaultStatus(address(tbtcVault), true);
        for (uint256 i; i < minters.length; i++) {
            tbtcVault.addMinter(minters[i]);
        }
        for (uint256 i; i < guardians.length; i++) {
            tbtcVault.addGuardian(guardians[i]);
        }

        bridge.setSpvMaintainerStatus(spvMaintainer, true);

        _setBridgeParameters();

        // ReservationVault: caps first, then parameters (which wire the vault
        // into the Bridge), then trust (deploy/95 + deploy/97).
        reservationVault = new ReservationVault(
            bank,
            tbtcVault,
            IReservationBridge(address(bridge))
        );
        vm.label(address(reservationVault), "ReservationVault");
        reservationRouter.updateReservationCaps(
            RESERVATION_MAX_AMOUNT_PER_WALLET,
            RESERVATION_MAX_SINGLE_AMOUNT,
            MAX_ACTIVE_RESERVATIONS,
            MAX_THIRD_PARTY_REANCHOR_HOLDS_PER_WALLET,
            HANDOFF_RESERVE_WALLETS
        );
        reservationRouter.updateReservationParameters(
            address(reservationVault),
            RESERVATION_MIN_AMOUNT,
            RESERVATION_TX_MAX_FEE,
            RESERVATION_TERM_SECONDS,
            RESERVATION_DISSOLUTION_DELAY,
            RESERVATION_MAX_TOTAL_AMOUNT,
            MAX_RESERVATIONS_PER_WALLET,
            RESERVATION_ACTION_TIMEOUT,
            RESERVATION_RENEWAL_WINDOW_SECONDS
        );
        bridge.setVaultStatus(address(reservationVault), true);

        // RebateStaking (proxy), wired once into the Bridge.
        rebateStakingImpl = new RebateStaking();
        vm.label(address(rebateStakingImpl), "RebateStakingImpl");
        rebateStaking = RebateStaking(
            address(
                new TransparentUpgradeableProxy(
                    address(rebateStakingImpl),
                    proxyAdmin,
                    abi.encodeCall(
                        RebateStaking.initialize,
                        (
                            address(bridge),
                            address(tToken),
                            REBATE_ROLLING_WINDOW,
                            REBATE_UNSTAKING_PERIOD,
                            REBATE_PER_TOKEN
                        )
                    )
                )
            )
        );
        vm.label(address(rebateStaking), "RebateStaking");
        bridge.setRebateStaking(address(rebateStaking));

        // RedemptionWatchtower (proxy). `initialize` reads the Bank from
        // `Bridge.contractReferences()`, so the Bridge must be initialized.
        redemptionWatchtowerImpl = new RedemptionWatchtower();
        vm.label(address(redemptionWatchtowerImpl), "RedemptionWatchtowerImpl");
        redemptionWatchtower = RedemptionWatchtower(
            address(
                new TransparentUpgradeableProxy(
                    address(redemptionWatchtowerImpl),
                    proxyAdmin,
                    abi.encodeCall(RedemptionWatchtower.initialize, (bridge))
                )
            )
        );
        vm.label(address(redemptionWatchtower), "RedemptionWatchtower");
        bridge.setRedemptionWatchtower(address(redemptionWatchtower));
        redemptionWatchtower.enableWatchtower(watchtowerManager, guardians);

        // The reservation acceptance gate holds back HANDOFF_RESERVE_WALLETS
        // Live wallets, so a one-wallet setup can never accept a reservation.
        // Keep one spare Live wallet that no test drives: it is deliberately
        // not recorded in `harnessWallets`, so wallet indices, selection
        // helpers and expectations stay as the tests wrote them. Created
        // before wallet 0 so that wallet 0 stays the active wallet.
        _registerHandoffSpareWallet();
        // A first live wallet (also the active wallet) from block 0.
        _registerWalletFromKey(0);

        // Hand every privileged role to `governance`.
        bridge.transferGovernance(governance);
        bank.transferOwnership(governance);
        tbtcVault.transferOwnership(governance);
        reservationVault.transferOwnership(governance);
        rebateStaking.transferOwnership(governance);
        redemptionWatchtower.transferOwnership(governance);
        reimbursementPool.transferOwnership(governance);

        setupActors();
    }

    function setupActors() internal {
        admin = address(this);
        vm.label(admin, "Admin");

        for (uint256 i; i < ACTOR_LABELS.length; i++) {
            address _actor = address(new Actor{value: INITIAL_ETH_BALANCE}());
            actors.push(_actor);
            if (ACTOR_LABELS.length > i) {
                vm.label(_actor, ACTOR_LABELS[i]);
            }

            // Bank balance, credited through a setup-only prank as the Bridge
            // (the only account allowed to call `Bank.increaseBalance`).
            vm.prank(address(bridge));
            bank.increaseBalance(_actor, ACTOR_BANK_BALANCE_SAT);

            // T tokens for rebate staking.
            tToken.deal(_actor, INITIAL_TOKEN_BALANCE * 1e18);

            vm.startPrank(_actor);
            // Bank balance allowances: TBTCVault (mint) and Bridge.
            bank.approveBalance(address(tbtcVault), type(uint256).max);
            bank.approveBalance(address(bridge), type(uint256).max);
            // Legitimate mint path: the minted TBTC is backed 1:1 by the Bank
            // balance moved to the TBTCVault.
            tbtcVault.mint(ACTOR_TBTC_MINT_SAT * SATOSHI_MULTIPLIER);
            // TBTC allowances: TBTCVault (unmint / unmintAndRedeem burn) and
            // ReservationVault (repayInKindFeeDebt pull).
            tbtc.approve(address(tbtcVault), type(uint256).max);
            tbtc.approve(address(reservationVault), type(uint256).max);
            // T allowance for RebateStaking.stake.
            tToken.approve(address(rebateStaking), type(uint256).max);
            vm.stopPrank();
        }
        actor = actors[0];
    }

    function _initRoles() private {
        governance = _role("fizz.governance");
        spvMaintainer = _role("fizz.spvMaintainer");
        treasury = _role("fizz.treasury");
        watchtowerManager = _role("fizz.watchtowerManager");
        proxyAdmin = _role("fizz.proxyAdmin");
        for (uint256 i; i < 3; i++) {
            guardians.push(_role(string.concat("fizz.guardian.", _digit(i))));
            minters.push(_role(string.concat("fizz.minter.", _digit(i))));
        }
        vm.label(governance, "Governance");
        vm.label(spvMaintainer, "SpvMaintainer");
        vm.label(treasury, "Treasury");
        vm.label(watchtowerManager, "WatchtowerManager");
        vm.label(proxyAdmin, "ProxyAdmin");
    }

    function _initWalletKeys() private {
        walletPrivKeys.push(WALLET_PRIV_KEY_0);
        walletPubX.push(WALLET_PUB_X_0);
        walletPubY.push(WALLET_PUB_Y_0);
        walletPrivKeys.push(WALLET_PRIV_KEY_1);
        walletPubX.push(WALLET_PUB_X_1);
        walletPubY.push(WALLET_PUB_Y_1);
        walletPrivKeys.push(WALLET_PRIV_KEY_2);
        walletPubX.push(WALLET_PUB_X_2);
        walletPubY.push(WALLET_PUB_Y_2);
        walletPrivKeys.push(WALLET_PRIV_KEY_3);
        walletPubX.push(WALLET_PUB_X_3);
        walletPubY.push(WALLET_PUB_Y_3);
        walletPrivKeys.push(WALLET_PRIV_KEY_4);
        walletPubX.push(WALLET_PUB_X_4);
        walletPubY.push(WALLET_PUB_Y_4);
        walletPrivKeys.push(WALLET_PRIV_KEY_5);
        walletPubX.push(WALLET_PUB_X_5);
        walletPubY.push(WALLET_PUB_Y_5);
    }

    /// @dev Called while this contract is still the Bridge governance.
    function _setBridgeParameters() private {
        bridge.updateDepositParameters(
            DEPOSIT_DUST_THRESHOLD,
            DEPOSIT_TREASURY_FEE_DIVISOR,
            DEPOSIT_TX_MAX_FEE,
            DEPOSIT_REVEAL_AHEAD_PERIOD
        );
        // The initial moving funds dust (200_000 sat) is above the new
        // redemption dust, and the Bridge requires moving funds dust <
        // redemption dust at each step, so the moving funds parameters (new
        // dust below the initial redemption dust) are lowered first.
        bridge.updateMovingFundsParameters(
            MOVING_FUNDS_TX_MAX_TOTAL_FEE,
            MOVING_FUNDS_DUST_THRESHOLD,
            MOVING_FUNDS_TIMEOUT_RESET_DELAY,
            MOVING_FUNDS_TIMEOUT,
            MOVING_FUNDS_TIMEOUT_SLASHING_AMOUNT,
            MOVING_FUNDS_TIMEOUT_NOTIFIER_REWARD_MULTIPLIER,
            MOVING_FUNDS_COMMITMENT_GAS_OFFSET,
            MOVED_FUNDS_SWEEP_TX_MAX_TOTAL_FEE,
            MOVED_FUNDS_SWEEP_TIMEOUT,
            MOVED_FUNDS_SWEEP_TIMEOUT_SLASHING_AMOUNT,
            MOVED_FUNDS_SWEEP_TIMEOUT_NOTIFIER_REWARD_MULTIPLIER
        );
        bridge.updateRedemptionParameters(
            REDEMPTION_DUST_THRESHOLD,
            REDEMPTION_TREASURY_FEE_DIVISOR,
            REDEMPTION_TX_MAX_FEE,
            REDEMPTION_TX_MAX_TOTAL_FEE,
            REDEMPTION_TIMEOUT,
            REDEMPTION_TIMEOUT_SLASHING_AMOUNT,
            REDEMPTION_TIMEOUT_NOTIFIER_REWARD_MULTIPLIER
        );
        bridge.updateWalletParameters(
            WALLET_CREATION_PERIOD,
            WALLET_CREATION_MIN_BTC_BALANCE,
            WALLET_CREATION_MAX_BTC_BALANCE,
            WALLET_CLOSURE_MIN_BTC_BALANCE,
            WALLET_MAX_AGE,
            WALLET_MAX_BTC_TRANSFER,
            WALLET_CLOSING_PERIOD
        );
        bridge.updateFraudParameters(
            FRAUD_CHALLENGE_DEPOSIT_AMOUNT,
            FRAUD_CHALLENGE_DEFEAT_TIMEOUT,
            FRAUD_SLASHING_AMOUNT,
            FRAUD_NOTIFIER_REWARD_MULTIPLIER
        );
    }

    function _role(string memory label) private pure returns (address) {
        return address(uint160(uint256(keccak256(bytes(label)))));
    }

    function _digit(uint256 i) private pure returns (string memory) {
        return string(abi.encodePacked(bytes1(uint8(48 + i))));
    }

    // ―――――――――――――――――――― Harness bookkeeping helpers ―――――――――――――――――――――

    /// @dev Registers the wallet owning key `keyIndex` through the registry
    ///      mock (which calls `Bridge.__ecdsaWalletCreatedCallback`) and
    ///      records it. Reverts (through the Bridge) if the wallet was already
    ///      registered.
    function _registerWalletFromKey(
        uint256 keyIndex
    ) internal returns (bytes20 walletPkh) {
        bytes32 x = walletPubX[keyIndex];
        bytes32 y = walletPubY[keyIndex];
        walletPkh = BtcBuilder.pubKeyHash(x, y);
        walletRegistry.createWallet(
            keccak256(abi.encodePacked("fizz.wallet", keyIndex)),
            x,
            y
        );
        walletKeyIndex[walletPkh] = keyIndex;
        _recordWallet(walletPkh);
    }

    /// @dev Registers the spare Live wallet the hand-off reserve gate needs,
    ///      without adding it to `harnessWallets`. Uses the last key of
    ///      `_initWalletKeys`, which no test registers.
    function _registerHandoffSpareWallet() private returns (bytes20 walletPkh) {
        uint256 keyIndex = walletPubX.length - 1;
        bytes32 x = walletPubX[keyIndex];
        bytes32 y = walletPubY[keyIndex];
        walletPkh = BtcBuilder.pubKeyHash(x, y);
        walletRegistry.createWallet(
            keccak256(abi.encodePacked("fizz.spare", keyIndex)),
            x,
            y
        );
        walletKeyIndex[walletPkh] = keyIndex;
        handoffSpareWallet = walletPkh;
    }

    function _recordDeposit(
        bytes32 fundingTxHash,
        uint32 outputIndex,
        uint64 amount,
        address depositor,
        address vault,
        bytes20 walletPkh,
        bool reserved
    ) internal returns (uint256 index) {
        index = harnessDeposits.length;
        harnessDeposits.push(
            HarnessDeposit({
                fundingTxHash: fundingTxHash,
                outputIndex: outputIndex,
                amount: amount,
                depositor: depositor,
                vault: vault,
                walletPkh: walletPkh,
                reserved: reserved,
                swept: false
            })
        );
    }

    function _recordWallet(bytes20 walletPkh) internal {
        harnessWallets.push(walletPkh);
    }

    function _setMainUtxo(
        bytes20 walletPkh,
        BitcoinTx.UTXO memory utxo
    ) internal {
        harnessMainUtxo[walletPkh] = utxo;
    }

    function _recordRedemption(
        bytes20 walletPkh,
        bytes memory redeemerOutputScript,
        address redeemer,
        uint64 amount
    ) internal returns (uint256 index) {
        index = harnessRedemptions.length;
        harnessRedemptions.push(
            HarnessRedemption({
                walletPkh: walletPkh,
                redeemerOutputScript: redeemerOutputScript,
                redeemer: redeemer,
                amount: amount,
                closed: false
            })
        );
    }

    function _recordReservation(uint256 reservationKey) internal {
        harnessReservationKeys.push(reservationKey);
    }

    // ――――――――――――――――――――――――― Helpers ――――――――――――――――――――――――――

    // Maps an arbitrary address to an actor address
    function toActor(address addy) internal view returns (address) {
        return actors[uint256(uint160(addy)) % actors.length];
    }

    // Maps an arbitrary address to an actor address that is different from the current actor
    function toActorNotCurrent(address addy) internal view returns (address) {
        address _actor = actors[uint256(uint160(addy)) % actors.length];
        if (_actor == actor) {
            _actor = actors[(uint256(uint160(addy)) + 1) % actors.length];
        }
        return _actor;
    }

    // Sums the native token balances of all actors
    function sumActorsBalances() internal view returns (uint256 sumOfBalances) {
        for (uint256 i; i < actors.length; i++) {
            sumOfBalances += actors[i].balance;
        }
    }

    // Sums the ERC-20 token balances of all actors for a given token
    function sumActorsERC20Balances(
        address _token
    ) internal view returns (uint256 sumOfBalances) {
        for (uint256 i; i < actors.length; i++) {
            bytes memory data = abi.encodeWithSignature(
                "balanceOf(address)",
                actors[i]
            );
            (bool success, bytes memory result) = _token.staticcall(data);
            require(success, "sumActorsERC20Balances: failed to get balance");
            sumOfBalances += abi.decode(result, (uint256));
        }
    }

    function skipBlocks(uint256 blocks) internal {
        vm.roll(block.number + blocks);
        vm.warp(block.timestamp + blocks * BLOCK_INTERVAL);
    }

    function skipTime(uint256 time) internal {
        uint256 blocks = (time + BLOCK_INTERVAL - 1) / BLOCK_INTERVAL;
        vm.roll(block.number + blocks);
        vm.warp(block.timestamp + time);
    }

    /// @dev True when `time + 1` more seconds keep the clock at or below FIZZ_CLOCK_CEILING (no overflow).
    function clockHasRoom(uint256 time) internal view returns (bool) {
        return
            block.timestamp < FIZZ_CLOCK_CEILING &&
            time < FIZZ_CLOCK_CEILING - block.timestamp;
    }
}
