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

import {BTCUtils} from "@keep-network/bitcoin-spv-sol/contracts/BTCUtils.sol";
import {EcdsaDkg} from "@keep-network/ecdsa/contracts/libraries/EcdsaDkg.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import "./BitcoinTx.sol";
import "./EcdsaLib.sol";
import "./BridgeState.sol";

/// @title Wallet library
/// @notice Library responsible for handling integration between Bridge
///         contract and ECDSA wallets.
library Wallets {
    using BTCUtils for bytes;

    /// @notice Represents wallet state:
    enum WalletState {
        /// @dev The wallet is unknown to the Bridge.
        Unknown,
        /// @dev The wallet can sweep deposits and accept redemption requests.
        Live,
        /// @dev The wallet was deemed unhealthy and is expected to move their
        ///      outstanding funds to another wallet. The wallet can still
        ///      fulfill their pending redemption requests although new
        ///      redemption requests and new deposit reveals are not accepted.
        MovingFunds,
        /// @dev The wallet moved or redeemed all their funds and is in the
        ///      closing period where it is still a subject of fraud challenges
        ///      and must defend against them. This state is needed to protect
        ///      against deposit frauds on deposits revealed but not swept.
        ///      The closing period must be greater that the deposit refund
        ///      time plus some time margin.
        Closing,
        /// @dev The wallet finalized the closing period successfully and
        ///      can no longer perform any action in the Bridge.
        Closed,
        /// @dev The wallet committed a fraud that was reported, did not move
        ///      funds to another wallet before a timeout, or did not sweep
        ///      funds moved to if from another wallet before a timeout. The
        ///      wallet is blocked and can not perform any actions in the Bridge.
        ///      Off-chain coordination with the wallet operators is needed to
        ///      recover funds.
        Terminated
    }

    /// @notice Holds information about a wallet.
    struct Wallet {
        // Identifier of a ECDSA Wallet registered in the ECDSA Wallet Registry.
        bytes32 ecdsaWalletID;
        // Latest wallet's main UTXO hash computed as
        // keccak256(txHash | txOutputIndex | txOutputValue). The `tx` prefix
        // refers to the transaction which created that main UTXO. The `txHash`
        // is `bytes32` (ordered as in Bitcoin internally), `txOutputIndex`
        // an `uint32`, and `txOutputValue` an `uint64` value.
        bytes32 mainUtxoHash;
        // The total redeemable value of pending redemption requests targeting
        // that wallet.
        uint64 pendingRedemptionsValue;
        // UNIX timestamp the wallet was created at.
        // XXX: Unsigned 32-bit int unix seconds, will break February 7th 2106.
        uint32 createdAt;
        // UNIX timestamp indicating the moment the wallet was requested to
        // move their funds.
        // XXX: Unsigned 32-bit int unix seconds, will break February 7th 2106.
        uint32 movingFundsRequestedAt;
        // UNIX timestamp indicating the moment the wallet's closing period
        // started.
        // XXX: Unsigned 32-bit int unix seconds, will break February 7th 2106.
        uint32 closingStartedAt;
        // Total count of pending moved funds sweep requests targeting this wallet.
        uint32 pendingMovedFundsSweepRequestsCount;
        // Current state of the wallet.
        WalletState state;
        // Moving funds target wallet commitment submitted by the wallet. It
        // is built by applying the keccak256 hash over the list of 20-byte
        // public key hashes of the target wallets.
        bytes32 movingFundsTargetWalletsCommitmentHash;
        // This struct doesn't contain `__gap` property as the structure is stored
        // in a mapping, mappings store values in different slots and they are
        // not contiguous with other values.
    }

    event NewWalletRequested();

    event NewWalletRegistered(
        bytes32 indexed ecdsaWalletID,
        bytes20 indexed walletPubKeyHash
    );

    event WalletMovingFunds(
        bytes32 indexed ecdsaWalletID,
        bytes20 indexed walletPubKeyHash
    );

    event WalletClosing(
        bytes32 indexed ecdsaWalletID,
        bytes20 indexed walletPubKeyHash
    );

    event WalletClosed(
        bytes32 indexed ecdsaWalletID,
        bytes20 indexed walletPubKeyHash
    );

    event WalletTerminated(
        bytes32 indexed ecdsaWalletID,
        bytes20 indexed walletPubKeyHash
    );

    /// @notice Requests creation of a new wallet. This function just
    ///         forms a request and the creation process is performed
    ///         asynchronously. Outcome of that process should be delivered
    ///         using `registerNewWallet` function.
    /// @param activeWalletMainUtxo Data of the active wallet's main UTXO, as
    ///        currently known on the Ethereum chain.
    /// @dev Requirements:
    ///      - `activeWalletMainUtxo` components must point to the recent main
    ///        UTXO of the given active wallet, as currently known on the
    ///        Ethereum chain. If there is no active wallet at the moment, or
    ///        the active wallet has no main UTXO, this parameter can be
    ///        empty as it is ignored,
    ///      - Wallet creation must not be in progress,
    ///      - If the active wallet is set, one of the following
    ///        conditions must be true:
    ///        - The active wallet BTC balance is above the minimum threshold
    ///          and the active wallet is old enough, i.e. the creation period
    ///           was elapsed since its creation time,
    ///        - The active wallet BTC balance is above the maximum threshold.
    function requestNewWallet(
        BridgeState.Storage storage self,
        BitcoinTx.UTXO calldata activeWalletMainUtxo
    ) external {
        require(
            self.ecdsaWalletRegistry.getWalletCreationState() ==
                EcdsaDkg.State.IDLE,
            "Wallet creation already in progress"
        );

        bytes20 activeWalletPubKeyHash = self.activeWalletPubKeyHash;

        // If the active wallet is set, fetch this wallet's details from
        // storage to perform conditions check. The `registerNewWallet`
        // function guarantees an active wallet is always one of the
        // registered ones.
        if (activeWalletPubKeyHash != bytes20(0)) {
            uint64 activeWalletBtcBalance = getWalletBtcBalance(
                self,
                activeWalletPubKeyHash,
                activeWalletMainUtxo
            );
            uint32 activeWalletCreatedAt = self
                .registeredWallets[activeWalletPubKeyHash]
                .createdAt;
            /* solhint-disable-next-line not-rely-on-time */
            bool activeWalletOldEnough = block.timestamp >=
                activeWalletCreatedAt + self.walletCreationPeriod;

            require(
                (activeWalletOldEnough &&
                    activeWalletBtcBalance >=
                    self.walletCreationMinBtcBalance) ||
                    activeWalletBtcBalance >= self.walletCreationMaxBtcBalance,
                "Wallet creation conditions are not met"
            );
        }

        emit NewWalletRequested();

        self.ecdsaWalletRegistry.requestNewWallet();
    }

    /// @notice Registers a new wallet. This function should be called
    ///         after the wallet creation process initiated using
    ///         `requestNewWallet` completes and brings the outcomes.
    /// @param ecdsaWalletID Wallet's unique identifier.
    /// @param publicKeyX Wallet's public key's X coordinate.
    /// @param publicKeyY Wallet's public key's Y coordinate.
    /// @dev Requirements:
    ///      - The only caller authorized to call this function is `registry`,
    ///      - Given wallet data must not belong to an already registered wallet.
    function registerNewWallet(
        BridgeState.Storage storage self,
        bytes32 ecdsaWalletID,
        bytes32 publicKeyX,
        bytes32 publicKeyY
    ) external {
        require(
            msg.sender == address(self.ecdsaWalletRegistry),
            "Caller is not the ECDSA Wallet Registry"
        );

        // Compress wallet's public key and calculate Bitcoin's hash160 of it.
        bytes20 walletPubKeyHash = bytes20(
            EcdsaLib.compressPublicKey(publicKeyX, publicKeyY).hash160View()
        );

        Wallet storage wallet = self.registeredWallets[walletPubKeyHash];
        require(
            wallet.state == WalletState.Unknown,
            "ECDSA wallet has been already registered"
        );
        wallet.ecdsaWalletID = ecdsaWalletID;
        wallet.state = WalletState.Live;
        /* solhint-disable-next-line not-rely-on-time */
        wallet.createdAt = uint32(block.timestamp);

        // Set the freshly created wallet as the new active wallet.
        self.activeWalletPubKeyHash = walletPubKeyHash;

        self.liveWalletsCount++;

        // Record the registration order so moving-funds target selection can be
        // reconstructed deterministically on-chain. This mirrors the ordering
        // of the `NewWalletRegistered` events consumed off-chain. Wallets are
        // registered at most once (the `Unknown` state guard above), so the
        // list never contains duplicates.
        self.walletRegistrationOrder.push(walletPubKeyHash);

        emit NewWalletRegistered(ecdsaWalletID, walletPubKeyHash);
    }

    /// @notice Backfills `walletRegistrationOrder` with the wallets that were
    ///         registered before the upgrade that introduced the on-chain
    ///         order, so the deterministic moving-funds target-wallet selection
    ///         can be reconstructed for them too.
    /// @param preUpgradeWallets Pre-upgrade wallet public key hashes, ordered
    ///        oldest registration first, matching the `NewWalletRegistered`
    ///        event history consumed off-chain.
    /// @dev Requirements:
    ///      - Callable only once (guarded by `walletRegistrationOrderSeeded`).
    ///      Access control is enforced by the calling Bridge function, which
    ///      restricts this to governance. After this runs the order is
    ///      authoritative and `submitMovingFundsCommitment` enforces the
    ///      deterministic selection with no fallback.
    ///
    ///      Wallet registration (`registerNewWallet`) is driven by
    ///      permissionless DKG completion and is not gated on this backfill, so
    ///      a wallet can register between the Bridge upgrade and this call. Any
    ///      wallets already present were therefore appended after the upgrade
    ///      (the order was empty at upgrade time) and are strictly newer than
    ///      every pre-upgrade wallet. Rather than requiring an empty order —
    ///      which a single in-window registration would make permanently
    ///      unsatisfiable, bricking the seed — this reconstructs the order with
    ///      the pre-upgrade wallets first (oldest) followed by the post-upgrade
    ///      ones (newer), preserving the global oldest-first registration order.
    ///      Any supplied wallet already captured in the on-chain snapshot (an
    ///      in-window registration that the off-chain event scan also picked
    ///      up) is recorded once, at its post-upgrade position, so the rebuilt
    ///      order stays duplicate-free and the deterministic target-wallet
    ///      selection stays matchable.
    function seedWalletRegistrationOrder(
        BridgeState.Storage storage self,
        bytes20[] calldata preUpgradeWallets
    ) external {
        _seedWalletRegistrationOrder(self, preUpgradeWallets);
    }

    /// @notice Internal body of `seedWalletRegistrationOrder`. Extracted so the
    ///         Stage-3 combined reinitializer path (`migrateV6Stage3Combined`)
    ///         can reuse the exact backfill logic without an external
    ///         self-delegatecall, and so the wallet-order backfill lives in a
    ///         single place.
    /// @param self Bridge storage.
    /// @param preUpgradeWallets Pre-upgrade wallet public key hashes, ordered
    ///        oldest registration first.
    function _seedWalletRegistrationOrder(
        BridgeState.Storage storage self,
        bytes20[] calldata preUpgradeWallets
    ) internal {
        require(
            !self.walletRegistrationOrderSeeded,
            "Wallet registration order already seeded"
        );

        // Snapshot any wallets that registered post-upgrade before this
        // backfill, then rebuild the order with the pre-upgrade wallets ahead
        // of them so the oldest-first ordering the reconstruction relies on is
        // preserved regardless of the upgrade-to-seed timing.
        //
        // A wallet that registers in the window between the upgrade and this
        // backfill is captured in the on-chain snapshot below. The off-chain
        // routine that builds `preUpgradeWallets` scans the registration event
        // history to the chain head, so that same wallet can also appear in the
        // supplied list. Skip any supplied entry already present in the snapshot
        // so it is recorded exactly once, at its true post-upgrade position.
        // Otherwise the order would hold a duplicate and the deterministic
        // target-wallet reconstruction would emit it twice, making the
        // strictly-ascending commitment permanently unmatchable and bricking
        // moving-funds commitments.
        bytes20[] memory postUpgradeWallets = self.walletRegistrationOrder;
        delete self.walletRegistrationOrder;

        for (uint256 i = 0; i < preUpgradeWallets.length; i++) {
            bytes20 preUpgradeWallet = preUpgradeWallets[i];

            bool alreadyTracked = false;
            for (uint256 k = 0; k < postUpgradeWallets.length; k++) {
                if (postUpgradeWallets[k] == preUpgradeWallet) {
                    alreadyTracked = true;
                    break;
                }
            }
            if (alreadyTracked) {
                continue;
            }

            self.walletRegistrationOrder.push(preUpgradeWallet);
        }
        for (uint256 j = 0; j < postUpgradeWallets.length; j++) {
            self.walletRegistrationOrder.push(postUpgradeWallets[j]);
        }

        self.walletRegistrationOrderSeeded = true;
    }

    /// @notice Validates and applies the storage migration for the
    ///         combined Sepolia Stage-3 Bridge upgrade, on behalf of
    ///         `Bridge.initializeV6_Stage3Combined`. Runs under delegatecall from
    ///         the Bridge's version-6 reinitializer, so `self`, `address(this)`
    ///         (the Bridge's ETH balance), and every storage field are the live
    ///         Bridge's. The heavy validation lives here rather than on the
    ///         Bridge only to keep the Bridge within the EIP-170 deployed-
    ///         bytecode limit — it removes none of the migration checks. The
    ///         covenant registry is validated AND assigned here, through the
    ///         shared `_setCovenantSpendAuthorization` helper; the
    ///         `CovenantSpendAuthorizationUpdated` event is redeclared in this
    ///         library identically, so under delegatecall it is still attributed
    ///         to the Bridge.
    /// @param self Bridge storage.
    /// @param expectedMintingController Controller the caller asserts already
    ///        occupies absolute slot 81 (the live account-control controller).
    ///        Asserted, never written.
    /// @param covenantRegistry Deployed `CovenantSpendAuthorization` registry.
    ///        Validated (nonzero, has code, not already set) and then assigned
    ///        here via the shared covenant setter helper.
    /// @param preUpgradeOpenFraudChallengeEscrow Sum of open fraud-challenge
    ///        deposits; must equal the Bridge's ETH balance.
    /// @param preUpgradeWallets Pre-upgrade wallet public key hashes, oldest
    ///        registration first; the last element must equal the active wallet.
    function migrateV6Stage3Combined(
        BridgeState.Storage storage self,
        address expectedMintingController,
        address covenantRegistry,
        uint256 preUpgradeOpenFraudChallengeEscrow,
        bytes20[] calldata preUpgradeWallets
    ) external {
        // The controller must already live at slot 81. This is an
        // assertion, not an assignment: it proves the reconstructed storage
        // layout kept `mintingController` at absolute slot 81 across the upgrade.
        require(
            expectedMintingController != address(0),
            "Expected minting controller is zero"
        );
        require(
            self.mintingController == expectedMintingController,
            "Minting controller slot mismatch"
        );

        // The covenant registry must be a real deployed contract; a
        // zero or codeless address would leave the covenant defeat path silently
        // disabled after an upgrade that is meant to enable it.
        require(covenantRegistry != address(0), "Covenant registry is zero");
        require(
            covenantRegistry.code.length > 0,
            "Covenant registry has no code"
        );

        // Direct detector for the raw-PR slot collision: had the
        // combined implementation reused relative slot 30 for
        // `migrationDebtVault`, the live controller value would be read here as a
        // nonzero migration-debt vault. At the correct layout this reads zero.
        require(
            self.migrationDebtVault == address(0),
            "Migration debt vault slot not clean"
        );

        // The migration targets must all be untouched; this
        // reinitializer is the single writer of these fields on Sepolia.
        require(self.openFraudChallengeEscrow == 0, "Fraud escrow already set");
        require(
            !self.fraudChallengeEscrowSeeded,
            "Fraud escrow already seeded"
        );
        require(
            !self.walletRegistrationOrderSeeded,
            "Wallet order already seeded"
        );
        require(
            self.covenantSpendAuthorization == address(0),
            "Covenant registry already set"
        );
        require(
            self.walletRegistrationOrder.length == 0,
            "Wallet order not empty"
        );

        // The Bridge holds ETH only as open fraud-challenge escrow.
        // Requiring the balance to equal the supplied escrow makes any
        // fraud-challenge submission or resolution that lands between the
        // off-chain scan and this upgrade revert the whole atomic cutover rather
        // than under- or over-seeding the escrow accounting. `address(this)` is
        // the Bridge under delegatecall.
        require(
            address(this).balance == preUpgradeOpenFraudChallengeEscrow,
            "Bridge balance != open escrow"
        );

        // Race guard on the event-derived wallet list: a wallet that
        // registers between the off-chain scan and this upgrade would change the
        // active wallet. Binding the list's tail to the current active wallet (or
        // requiring no active wallet for an empty list) forces a stale scan to
        // revert instead of seeding an incomplete registration order.
        if (preUpgradeWallets.length == 0) {
            require(
                self.activeWalletPubKeyHash == bytes20(0),
                "Active wallet without wallet list"
            );
        } else {
            require(
                preUpgradeWallets[preUpgradeWallets.length - 1] ==
                    self.activeWalletPubKeyHash,
                "Wallet list tail != active wallet"
            );
        }

        // Seed the fraud-challenge escrow accounting and mark it
        // seeded so `submitFraudChallenge` and `recoverETH` become usable.
        self.openFraudChallengeEscrow = preUpgradeOpenFraudChallengeEscrow;
        self.fraudChallengeEscrowSeeded = true;

        // Backfill the wallet registration order so moving-funds
        // target selection can reconstruct the pre-upgrade wallet set. This also
        // sets `walletRegistrationOrderSeeded`.
        _seedWalletRegistrationOrder(self, preUpgradeWallets);

        // Wire the covenant registry last, after every check
        // passed, through the shared helper. Emitting
        // `CovenantSpendAuthorizationUpdated` from this library (the event is
        // redeclared below, identical to the Bridge's, so it carries the same
        // topic and is attributed to the Bridge under delegatecall) lets the
        // Bridge reinitializer stay a single delegated call, keeping the Bridge
        // within EIP-170. The registry was validated (nonzero, deployed, not
        // already set) above.
        _setCovenantSpendAuthorization(self, covenantRegistry);
    }

    /// @notice Shared covenant-registry assignment helper (the
    ///         section-3.4 shared setter, hosted in this library so the Bridge
    ///         stays within EIP-170). Writes storage and emits the
    ///         Bridge-attributed update event. Called by both the Bridge's
    ///         governance-only `setCovenantSpendAuthorization` (via the external
    ///         wrapper below) and the Stage-3 reinitializer path
    ///         (`migrateV6Stage3Combined`), so the covenant write logic lives in
    ///         exactly one place.
    /// @param self Bridge storage.
    /// @param registry Registry address, or zero to disable the covenant path.
    function _setCovenantSpendAuthorization(
        BridgeState.Storage storage self,
        address registry
    ) internal {
        self.covenantSpendAuthorization = registry;
        emit CovenantSpendAuthorizationUpdated(registry);
    }

    /// @notice External entry point for the shared covenant-registry
    ///         assignment helper, delegated to by the Bridge's governance-only
    ///         `setCovenantSpendAuthorization`. Zero is permitted. The
    ///         governance guard stays on the Bridge stub; this function carries
    ///         no guard and is reachable only through that guarded stub (external
    ///         library functions cannot be invoked directly).
    /// @param self Bridge storage.
    /// @param registry Registry address, or zero to disable the covenant path.
    function setCovenantSpendAuthorization(
        BridgeState.Storage storage self,
        address registry
    ) external {
        _setCovenantSpendAuthorization(self, registry);
    }

    /// @notice Execution body for
    ///         `Bridge.setMintingController`. Sets the account-control minting
    ///         controller (zero permitted) and emits `MintingControllerSet` with
    ///         the new address only. The governance guard stays on the Bridge
    ///         stub; hosted here only to keep the Bridge within EIP-170.
    /// @param self Bridge storage.
    /// @param _mintingController New controller address.
    function setMintingController(
        BridgeState.Storage storage self,
        address _mintingController
    ) external {
        self.mintingController = _mintingController;
        emit MintingControllerSet(_mintingController);
    }

    // ===================================================================
    // Account-control minting-controller execution bodies.
    // -------------------------------------------------------------------
    // The Bridge exposes `controllerIncreaseBalance` (selector 0xa5f7eaf8) and
    // `controllerIncreaseBalances` (selector 0x5182a65f) with the exact
    // reconstructed live behavior; their bodies are hosted here, and the Bridge
    // forwards to them under delegatecall, ONLY so the Bridge stays within the
    // EIP-170 deployed-bytecode limit after also carrying the reviewed PR
    // covenant/migration surface. Delegatecall preserves `msg.sender` and
    // `address(this)`, so the controller authorization check and the
    // `Bank.increaseBalance(s)` call (whose `onlyBridge` guard sees the Bridge as
    // caller) behave exactly as an inline implementation would. The events are
    // redeclared here (identical to the Bridge's) so the emit topics match and
    // are attributed to the Bridge.
    // ===================================================================

    event MintingControllerSet(address mintingController);
    event ControllerBalanceIncreased(
        address indexed controller,
        address indexed recipient,
        uint256 amount
    );
    event ControllerBalancesIncreased(
        address indexed controller,
        address[] recipients,
        uint256[] amounts
    );
    // Redeclared identically to the Bridge so the covenant event emitted by
    // `migrateV6Stage3Combined` carries the Bridge's topic.
    event CovenantSpendAuthorizationUpdated(
        address indexed covenantSpendAuthorization
    );

    /// @notice Execution body for
    ///         `Bridge.controllerIncreaseBalance`. Only the configured
    ///         `mintingController` may call. The controller event is emitted
    ///         before the Bank call, matching the live bytecode; a Bank revert
    ///         rolls the log back. The amount is already a Bank amount — no
    ///         satoshi/decimal conversion happens here.
    function controllerIncreaseBalance(
        BridgeState.Storage storage self,
        address recipient,
        uint256 amount
    ) external {
        require(
            msg.sender == self.mintingController,
            "Caller is not the authorized controller"
        );
        emit ControllerBalanceIncreased(msg.sender, recipient, amount);
        self.bank.increaseBalance(recipient, amount);
    }

    /// @notice Execution body for
    ///         `Bridge.controllerIncreaseBalances`. Only the configured
    ///         `mintingController` may call. Array-length validation is delegated
    ///         to `Bank.increaseBalances` (its "Arrays must have the same length"
    ///         revert), matching the live bytecode. The batch event is emitted
    ///         before the Bank call.
    function controllerIncreaseBalances(
        BridgeState.Storage storage self,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external {
        require(
            msg.sender == self.mintingController,
            "Caller is not the authorized controller"
        );
        emit ControllerBalancesIncreased(msg.sender, recipients, amounts);
        self.bank.increaseBalances(recipients, amounts);
    }

    /// @notice Handles a notification about a wallet redemption timeout.
    ///         Triggers the wallet moving funds process only if the wallet is
    ///         still in the Live state. That means multiple action timeouts can
    ///         be reported for the same wallet but only the first report
    ///         requests the wallet to move their funds. Executes slashing if
    ///         the wallet is in Live or MovingFunds state. Allows to notify
    ///         redemption timeout also for a Terminated wallet in case the
    ///         redemption was requested before the wallet got terminated.
    /// @param walletPubKeyHash 20-byte public key hash of the wallet.
    /// @param walletMembersIDs Identifiers of the wallet signing group members.
    /// @dev Requirements:
    ///      - The wallet must be in the `Live`, `MovingFunds`,
    ///        or `Terminated` state.
    function notifyWalletRedemptionTimeout(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash,
        uint32[] calldata walletMembersIDs
    ) internal {
        Wallet storage wallet = self.registeredWallets[walletPubKeyHash];
        WalletState walletState = wallet.state;

        require(
            walletState == WalletState.Live ||
                walletState == WalletState.MovingFunds ||
                walletState == WalletState.Terminated,
            "Wallet must be in Live or MovingFunds or Terminated state"
        );

        if (
            walletState == Wallets.WalletState.Live ||
            walletState == Wallets.WalletState.MovingFunds
        ) {
            // Slash the wallet operators and reward the notifier
            self.ecdsaWalletRegistry.seize(
                self.redemptionTimeoutSlashingAmount,
                self.redemptionTimeoutNotifierRewardMultiplier,
                msg.sender,
                wallet.ecdsaWalletID,
                walletMembersIDs
            );
        }

        if (walletState == WalletState.Live) {
            moveFunds(self, walletPubKeyHash);
        }
    }

    /// @notice Handles a notification about a wallet heartbeat failure and
    ///         triggers the wallet moving funds process.
    /// @param publicKeyX Wallet's public key's X coordinate.
    /// @param publicKeyY Wallet's public key's Y coordinate.
    /// @dev Requirements:
    ///      - The only caller authorized to call this function is `registry`,
    ///      - Wallet must be in Live state.
    function notifyWalletHeartbeatFailed(
        BridgeState.Storage storage self,
        bytes32 publicKeyX,
        bytes32 publicKeyY
    ) external {
        require(
            msg.sender == address(self.ecdsaWalletRegistry),
            "Caller is not the ECDSA Wallet Registry"
        );

        // Compress wallet's public key and calculate Bitcoin's hash160 of it.
        bytes20 walletPubKeyHash = bytes20(
            EcdsaLib.compressPublicKey(publicKeyX, publicKeyY).hash160View()
        );

        require(
            self.registeredWallets[walletPubKeyHash].state == WalletState.Live,
            "Wallet must be in Live state"
        );

        moveFunds(self, walletPubKeyHash);
    }

    /// @notice Notifies that the wallet is either old enough or has too few
    ///         satoshis left and qualifies to be closed.
    /// @param walletPubKeyHash 20-byte public key hash of the wallet.
    /// @param walletMainUtxo Data of the wallet's main UTXO, as currently
    ///        known on the Ethereum chain.
    /// @dev Requirements:
    ///      - Wallet must not be set as the current active wallet,
    ///      - Wallet must exceed the wallet maximum age OR the wallet BTC
    ///        balance must be lesser than the minimum threshold. If the latter
    ///        case is true, the `walletMainUtxo` components must point to the
    ///        recent main UTXO of the given wallet, as currently known on the
    ///        Ethereum chain. If the wallet has no main UTXO, this parameter
    ///        can be empty as it is ignored since the wallet balance is
    ///        assumed to be zero,
    ///      - Wallet must be in Live state.
    function notifyWalletCloseable(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO calldata walletMainUtxo
    ) external {
        require(
            self.activeWalletPubKeyHash != walletPubKeyHash,
            "Active wallet cannot be considered closeable"
        );

        Wallet storage wallet = self.registeredWallets[walletPubKeyHash];
        require(
            wallet.state == WalletState.Live,
            "Wallet must be in Live state"
        );

        /* solhint-disable-next-line not-rely-on-time */
        bool walletOldEnough = block.timestamp >=
            wallet.createdAt + self.walletMaxAge;

        require(
            walletOldEnough ||
                getWalletBtcBalance(self, walletPubKeyHash, walletMainUtxo) <
                self.walletClosureMinBtcBalance,
            "Wallet needs to be old enough or have too few satoshis"
        );

        moveFunds(self, walletPubKeyHash);
    }

    /// @notice Notifies about the end of the closing period for the given wallet.
    ///         Closes the wallet ultimately and notifies the ECDSA registry
    ///         about this fact.
    /// @param walletPubKeyHash 20-byte public key hash of the wallet.
    /// @dev Requirements:
    ///      - The wallet must be in the Closing state,
    ///      - The wallet closing period must have elapsed.
    function notifyWalletClosingPeriodElapsed(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash
    ) internal {
        Wallet storage wallet = self.registeredWallets[walletPubKeyHash];

        require(
            wallet.state == WalletState.Closing,
            "Wallet must be in Closing state"
        );

        require(
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp >
                wallet.closingStartedAt + self.walletClosingPeriod,
            "Closing period has not elapsed yet"
        );

        finalizeWalletClosing(self, walletPubKeyHash);
    }

    /// @notice Notifies that the wallet completed the moving funds process
    ///         successfully. Checks if the funds were moved to the expected
    ///         target wallets. Closes the source wallet if everything went
    ///         good and reverts otherwise.
    /// @param walletPubKeyHash 20-byte public key hash of the wallet.
    /// @param targetWalletsHash 32-byte keccak256 hash over the list of
    ///        20-byte public key hashes of the target wallets actually used
    ///        within the moving funds transactions.
    /// @dev Requirements:
    ///      - The caller must make sure the moving funds transaction actually
    ///        happened on Bitcoin chain and fits the protocol requirements,
    ///      - The source wallet must be in the MovingFunds state,
    ///      - The target wallets commitment must be submitted by the source
    ///        wallet,
    ///      - The actual target wallets used in the moving funds transaction
    ///        must be exactly the same as the target wallets commitment.
    function notifyWalletFundsMoved(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash,
        bytes32 targetWalletsHash
    ) internal {
        Wallet storage wallet = self.registeredWallets[walletPubKeyHash];
        // Check that the wallet is in the MovingFunds state but don't check
        // if the moving funds timeout is exceeded. That should give a
        // possibility to move funds in case when timeout was hit but was
        // not reported yet.
        require(
            wallet.state == WalletState.MovingFunds,
            "Wallet must be in MovingFunds state"
        );

        bytes32 targetWalletsCommitmentHash = wallet
            .movingFundsTargetWalletsCommitmentHash;

        require(
            targetWalletsCommitmentHash != bytes32(0),
            "Target wallets commitment not submitted yet"
        );

        // Make sure that the target wallets where funds were moved to are
        // exactly the same as the ones the source wallet committed to.
        require(
            targetWalletsCommitmentHash == targetWalletsHash,
            "Target wallets don't correspond to the commitment"
        );

        // If funds were moved, the wallet has no longer a main UTXO.
        delete wallet.mainUtxoHash;

        beginWalletClosing(self, walletPubKeyHash);
    }

    /// @notice Called when a MovingFunds wallet has a balance below the dust
    ///         threshold. Begins the wallet closing.
    /// @param walletPubKeyHash 20-byte public key hash of the wallet.
    /// @dev Requirements:
    ///      - The wallet must be in the MovingFunds state.
    function notifyWalletMovingFundsBelowDust(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash
    ) internal {
        WalletState walletState = self
            .registeredWallets[walletPubKeyHash]
            .state;

        require(
            walletState == Wallets.WalletState.MovingFunds,
            "Wallet must be in MovingFunds state"
        );

        beginWalletClosing(self, walletPubKeyHash);
    }

    /// @notice Called when the timeout for MovingFunds for the wallet elapsed.
    ///         Slashes wallet members and terminates the wallet.
    /// @param walletPubKeyHash 20-byte public key hash of the wallet.
    /// @param walletMembersIDs Identifiers of the wallet signing group members.
    /// @dev Requirements:
    ///      - The wallet must be in the MovingFunds state.
    function notifyWalletMovingFundsTimeout(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash,
        uint32[] calldata walletMembersIDs
    ) internal {
        Wallets.Wallet storage wallet = self.registeredWallets[
            walletPubKeyHash
        ];

        require(
            wallet.state == Wallets.WalletState.MovingFunds,
            "Wallet must be in MovingFunds state"
        );

        self.ecdsaWalletRegistry.seize(
            self.movingFundsTimeoutSlashingAmount,
            self.movingFundsTimeoutNotifierRewardMultiplier,
            msg.sender,
            wallet.ecdsaWalletID,
            walletMembersIDs
        );

        terminateWallet(self, walletPubKeyHash);
    }

    /// @notice Called when a wallet which was asked to sweep funds moved from
    ///         another wallet did not provide a sweeping proof before a timeout.
    ///         Slashes and terminates the wallet who failed to provide a proof.
    /// @param walletPubKeyHash 20-byte public key hash of the wallet which was
    ///        supposed to sweep funds.
    /// @param walletMembersIDs Identifiers of the wallet signing group members.
    /// @dev Requirements:
    ///      - The wallet must be in the `Live`, `MovingFunds`, `Closing`,
    ///        `Closed`, or `Terminated` state.
    ///
    ///      A moved-funds sweep request is committed and registered against a
    ///      target wallet while that wallet is `Live`, but the target can move
    ///      to `Closing` or `Closed` before the sweep completes. Accepting
    ///      those states here lets the timeout clear the otherwise-stuck sweep
    ///      request instead of reverting. Only `Live` and `MovingFunds` wallets
    ///      can still submit the sweep proof (see
    ///      `MovingFunds.resolveMovedFundsSweepingWallet`), so only they are
    ///      slashed and terminated for missing it. A `Closing` wallet cannot
    ///      submit the proof — the transition to `Closing` is permissionless
    ///      (`notifyWalletCloseable`) and can be forced on a target before its
    ///      sweep window elapses — so slashing it would punish an action it
    ///      structurally cannot perform. Like `Closed` and `Terminated`, a
    ///      `Closing` wallet therefore has its request simply cleared by the
    ///      caller without slashing.
    function notifyWalletMovedFundsSweepTimeout(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash,
        uint32[] calldata walletMembersIDs
    ) internal {
        Wallet storage wallet = self.registeredWallets[walletPubKeyHash];
        WalletState walletState = wallet.state;

        require(
            walletState == WalletState.Live ||
                walletState == WalletState.MovingFunds ||
                walletState == WalletState.Closing ||
                walletState == WalletState.Closed ||
                walletState == WalletState.Terminated,
            "Wallet must be in Live or MovingFunds or Closing or Closed or Terminated state"
        );

        if (
            walletState == Wallets.WalletState.Live ||
            walletState == Wallets.WalletState.MovingFunds
        ) {
            self.ecdsaWalletRegistry.seize(
                self.movedFundsSweepTimeoutSlashingAmount,
                self.movedFundsSweepTimeoutNotifierRewardMultiplier,
                msg.sender,
                wallet.ecdsaWalletID,
                walletMembersIDs
            );

            terminateWallet(self, walletPubKeyHash);
        }
    }

    /// @notice Called when a wallet which was challenged for a fraud did not
    ///         defeat the challenge before the timeout. Slashes and terminates
    ///         the wallet who failed to defeat the challenge. If the wallet is
    ///         already terminated or closed, it does nothing beyond letting the
    ///         challenger recover their ETH deposit.
    /// @param walletPubKeyHash 20-byte public key hash of the wallet which was
    ///        supposed to sweep funds.
    /// @param walletMembersIDs Identifiers of the wallet signing group members.
    /// @param challenger Address of the party which submitted the fraud
    ///        challenge.
    /// @dev Requirements:
    ///      - The wallet must be in the `Live`, `MovingFunds`, `Closing`,
    ///        `Closed`, or `Terminated` state.
    ///
    ///      `Live`, `MovingFunds`, and `Closing` wallets still hold their ECDSA
    ///      registry metadata, so they are slashed and terminated. `Terminated`
    ///      and `Closed` wallets have already had that registry entry deleted
    ///      (by `terminateWallet` and `finalizeWalletClosing` respectively), so
    ///      seizing is impossible; the timeout still resolves the challenge and
    ///      refunds the challenger without slashing.
    ///
    ///      Accepting `Closed` is the backstop for fraud challenges opened
    ///      before `submitFraudChallenge` began counting them per wallet. An
    ///      uncounted challenge leaves `walletPendingFraudChallenges` at zero,
    ///      so `finalizeWalletClosing` cannot see it and the wallet can reach
    ///      `Closed` while the challenge is still maturing. Counted
    ///      (post-upgrade) challenges keep the wallet in `Closing`, where
    ///      slashing still applies, so this branch only runs for those
    ///      uncounted pre-upgrade challenges.
    function notifyWalletFraudChallengeDefeatTimeout(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash,
        uint32[] calldata walletMembersIDs,
        address challenger
    ) internal {
        Wallet storage wallet = self.registeredWallets[walletPubKeyHash];
        WalletState walletState = wallet.state;

        if (
            walletState == Wallets.WalletState.Live ||
            walletState == Wallets.WalletState.MovingFunds ||
            walletState == Wallets.WalletState.Closing
        ) {
            self.ecdsaWalletRegistry.seize(
                self.fraudSlashingAmount,
                self.fraudNotifierRewardMultiplier,
                challenger,
                wallet.ecdsaWalletID,
                walletMembersIDs
            );

            terminateWallet(self, walletPubKeyHash);
        } else if (
            walletState == Wallets.WalletState.Terminated ||
            walletState == Wallets.WalletState.Closed
        ) {
            // The wallet was already terminated (due to a previous deliberate
            // protocol violation) or closed (its closing period elapsed with no
            // counted fraud challenges). Its ECDSA registry entry is already
            // gone, so it cannot be seized here. This function must still be
            // callable so the challenger can unlock its ETH deposit back; the
            // wallet termination logic is not called and the challenger is not
            // rewarded.
        } else {
            revert(
                "Wallet must be in Live or MovingFunds or Closing or Closed or Terminated state"
            );
        }
    }

    /// @notice Requests a wallet to move their funds. If the wallet balance
    ///         is zero, the wallet closing begins immediately. If the move
    ///         funds request refers to the current active wallet, such a wallet
    ///         is no longer considered active and the active wallet slot
    ///         is unset allowing to trigger a new wallet creation immediately.
    /// @param walletPubKeyHash 20-byte public key hash of the wallet.
    /// @dev Requirements:
    ///      - The caller must make sure that the wallet is in the Live state.
    function moveFunds(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash
    ) internal {
        Wallet storage wallet = self.registeredWallets[walletPubKeyHash];

        if (wallet.mainUtxoHash == bytes32(0)) {
            // If the wallet has no main UTXO, that means its BTC balance
            // is zero and the wallet closing should begin immediately.
            beginWalletClosing(self, walletPubKeyHash);
        } else {
            // Otherwise, initialize the moving funds process.
            wallet.state = WalletState.MovingFunds;
            /* solhint-disable-next-line not-rely-on-time */
            wallet.movingFundsRequestedAt = uint32(block.timestamp);

            // slither-disable-next-line reentrancy-events
            emit WalletMovingFunds(wallet.ecdsaWalletID, walletPubKeyHash);
        }

        if (self.activeWalletPubKeyHash == walletPubKeyHash) {
            // If the move funds request refers to the current active wallet,
            // unset the active wallet and make the wallet creation process
            // possible in order to get a new healthy active wallet.
            delete self.activeWalletPubKeyHash;
        }

        self.liveWalletsCount--;
    }

    /// @notice Begins the closing period of the given wallet.
    /// @param walletPubKeyHash 20-byte public key hash of the wallet.
    /// @dev Requirements:
    ///      - The caller must make sure that the wallet is in the
    ///        MovingFunds state.
    function beginWalletClosing(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash
    ) internal {
        Wallet storage wallet = self.registeredWallets[walletPubKeyHash];
        // Initialize the closing period.
        wallet.state = WalletState.Closing;
        /* solhint-disable-next-line not-rely-on-time */
        wallet.closingStartedAt = uint32(block.timestamp);

        // slither-disable-next-line reentrancy-events
        emit WalletClosing(wallet.ecdsaWalletID, walletPubKeyHash);
    }

    /// @notice Finalizes the closing period of the given wallet and notifies
    ///         the ECDSA registry about this fact.
    /// @param walletPubKeyHash 20-byte public key hash of the wallet.
    /// @dev Requirements:
    ///      - The caller must make sure that the wallet is in the Closing state.
    function finalizeWalletClosing(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash
    ) internal {
        Wallet storage wallet = self.registeredWallets[walletPubKeyHash];

        // Do not close a wallet while a counted fraud challenge against it can
        // still mature. Keeping the wallet in `Closing` preserves the ECDSA
        // registry metadata that `notifyWalletFraudChallengeDefeatTimeout`
        // needs to slash the operators; once the wallet is `Closed` that
        // metadata is gone and the timeout path can only refund the challenger.
        // The wallet stays in `Closing` until every counted challenge is
        // defeated or timed out, both reachable in the `Closing` state.
        //
        // This counter only covers challenges opened after `submitFraudChallenge`
        // began tracking them per wallet. Fraud challenges opened before that
        // are not counted, so they cannot block closing here; the fraud-challenge
        // timeout path accepts `Closed` wallets as a refund-only backstop for
        // exactly that pre-upgrade case.
        require(
            self.walletPendingFraudChallenges[walletPubKeyHash] == 0,
            "Wallet has unresolved fraud challenges"
        );

        wallet.state = WalletState.Closed;

        emit WalletClosed(wallet.ecdsaWalletID, walletPubKeyHash);

        self.ecdsaWalletRegistry.closeWallet(wallet.ecdsaWalletID);
    }

    /// @notice Terminates the given wallet and notifies the ECDSA registry
    ///         about this fact. If the wallet termination refers to the current
    ///         active wallet, such a wallet is no longer considered active and
    ///         the active wallet slot is unset allowing to trigger a new wallet
    ///         creation immediately.
    /// @param walletPubKeyHash 20-byte public key hash of the wallet.
    /// @dev Requirements:
    ///      - The caller must make sure that the wallet is in the
    ///        Live or MovingFunds or Closing state.
    function terminateWallet(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash
    ) internal {
        Wallet storage wallet = self.registeredWallets[walletPubKeyHash];

        if (wallet.state == WalletState.Live) {
            self.liveWalletsCount--;
        }

        wallet.state = WalletState.Terminated;

        // slither-disable-next-line reentrancy-events
        emit WalletTerminated(wallet.ecdsaWalletID, walletPubKeyHash);

        if (self.activeWalletPubKeyHash == walletPubKeyHash) {
            // If termination refers to the current active wallet,
            // unset the active wallet and make the wallet creation process
            // possible in order to get a new healthy active wallet.
            delete self.activeWalletPubKeyHash;
        }

        self.ecdsaWalletRegistry.closeWallet(wallet.ecdsaWalletID);
    }

    /// @notice Gets BTC balance for given the wallet.
    /// @param walletPubKeyHash 20-byte public key hash of the wallet.
    /// @param walletMainUtxo Data of the wallet's main UTXO, as currently
    ///        known on the Ethereum chain.
    /// @return walletBtcBalance Current BTC balance for the given wallet.
    /// @dev Requirements:
    ///      - `walletMainUtxo` components must point to the recent main UTXO
    ///        of the given wallet, as currently known on the Ethereum chain.
    ///        If the wallet has no main UTXO, this parameter can be empty as it
    ///        is ignored.
    function getWalletBtcBalance(
        BridgeState.Storage storage self,
        bytes20 walletPubKeyHash,
        BitcoinTx.UTXO calldata walletMainUtxo
    ) internal view returns (uint64 walletBtcBalance) {
        bytes32 walletMainUtxoHash = self
            .registeredWallets[walletPubKeyHash]
            .mainUtxoHash;

        // If the wallet has a main UTXO hash set, cross-check it with the
        // provided plain-text parameter and get the transaction output value
        // as BTC balance. Otherwise, the BTC balance is just zero.
        if (walletMainUtxoHash != bytes32(0)) {
            require(
                keccak256(
                    abi.encodePacked(
                        walletMainUtxo.txHash,
                        walletMainUtxo.txOutputIndex,
                        walletMainUtxo.txOutputValue
                    )
                ) == walletMainUtxoHash,
                "Invalid wallet main UTXO data"
            );

            walletBtcBalance = walletMainUtxo.txOutputValue;
        }

        return walletBtcBalance;
    }
}
