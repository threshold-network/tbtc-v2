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
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import "./BitcoinTx.sol";
import "./EcdsaLib.sol";
import "./BridgeState.sol";
import "./IBridgeLifecycleRouter.sol";

/// @notice Minimal interface for the FROST wallet registry's wallet
///         creation entry point and lifecycle-owner handshake. The
///         `requestNewWallet()` entry mirrors the ECDSA registry so
///         Bridge can dispatch without argument-shape branching.
///         `lifecycleOwner()` is load-bearing ABI: Bridge checks it
///         against `Bridge.lifecycleRouter` before starting or
///         completing FROST wallet creation so a wallet cannot be
///         registered with an unauthorized lifecycle dispatcher.
///         Implementation lives on the B-1 / B-2 FROST wallet
///         registry contract.
interface IFrostWalletRegistryRequest {
    function requestNewWallet() external;

    function lifecycleOwner() external view returns (address);
}

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

    event NewWalletRegisteredV2(
        bytes32 indexed walletID,
        bytes32 indexed ecdsaWalletID,
        bytes20 indexed walletPubKeyHash
    );

    /// @notice Emitted when a FROST/Schnorr-keyed wallet is registered via
    ///         the FROST wallet registration entry point. Distinct from
    ///         `NewWalletRegistered` and `NewWalletRegisteredV2` so that
    ///         downstream consumers (subgraph, v3-indexer, relayer) can
    ///         subscribe to FROST-specific lifecycle without having to
    ///         infer scheme from `ecdsaWalletID == bytes32(0)` in the V2
    ///         event. Bridge.sol mirrors this declaration so the event
    ///         appears in the Bridge contract ABI.
    event NewFrostWalletRegistered(
        bytes32 indexed walletID,
        bytes20 indexed walletPubKeyHash,
        bytes32 indexed xOnlyOutputKey
    );

    // Custom errors for the FROST wallet registration path and the new
    // ECDSA-marker guard on `registerNewWallet`. Used instead of require
    // strings to keep the Bridge implementation bytecode under the
    // 24 KiB EIP-170 deploy limit.
    error EcdsaWalletIdIsZero();
    error FrostWalletRegistryNotSet();
    error CallerIsNotFrostWalletRegistry();
    error FrostWalletIdIsZero();
    error FrostWalletIdNotNative();
    error FrostWalletIdCollidesWithLegacy();
    error FrostWalletAlreadyRegistered();
    // The lifecycle router must be configured before any FROST wallet
    // is registered; otherwise a Live FROST wallet would exist with no
    // dispatcher to handle its closeWallet/seize/isWalletMember
    // operations. Caught at registration time, before the wallet enters
    // Live state.
    error LifecycleRouterNotSet();
    error LifecycleOwnerMismatch();
    // FROST wallet's canonical walletID lookup failed. Raised when the
    // scheme-aware lifecycle path is invoked for a wallet whose
    // ecdsaWalletID is zero but whose walletIDByWalletPubKeyHash entry
    // is also zero. Should not be possible under normal operation
    // because registerNewFrostWallet writes both atomically; treated
    // as a corrupted-state sentinel.
    error FrostWalletIdMissing();

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
        // The "wallet creation must not be in progress" guarantee is enforced
        // by the FROST registry: requestNewWallet() below calls dkg.lockState(),
        // which reverts ("Current state is not IDLE") unless the FROST DKG is
        // IDLE. The previous gate here read the now-retired ECDSA wallet
        // registry's creation state; with ECDSA wallet creation removed (its
        // created-callback is gone), a stuck ECDSA DKG must not be able to
        // permanently block FROST wallet creation.

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

        // D-2.2 slice 3: removed the scheme-enum dispatch
        // branch entirely. Pre-slice-3 the branch read
        // `self.currentNewWalletScheme` and revert-on-Ecdsa
        // (per PR #444 review). Post-slice-3 the only valid
        // dispatch is to the FROST registry — the scheme
        // field itself is preserved in storage for upgrade-
        // safety but no longer read by any code path. Slice 3
        // also drops the `setNewWalletScheme` external setters
        // on Bridge + BridgeGovernance; governance can no
        // longer flip the scheme. (See
        // `d2-2-followups-plan.md` §"Slice 3" for the
        // governance commit this slice is gated on.)
        address frostWalletRegistry = self.frostWalletRegistry;
        if (frostWalletRegistry == address(0)) {
            revert FrostWalletRegistryNotSet();
        }
        address lifecycleRouter = self.lifecycleRouter;
        if (lifecycleRouter == address(0)) {
            revert LifecycleRouterNotSet();
        }
        if (
            IFrostWalletRegistryRequest(frostWalletRegistry).lifecycleOwner() !=
            lifecycleRouter
        ) {
            revert LifecycleOwnerMismatch();
        }
        IFrostWalletRegistryRequest(frostWalletRegistry).requestNewWallet();
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
        // D-1 deliberately does NOT block the late-callback path
        // here even when `ecdsaRetired == true`. Reverting from
        // this callback would propagate up through
        // `EcdsaWalletRegistry.approveDkgResult`, preventing the
        // registry's own `dkg.complete()` transition and leaving
        // the ECDSA registry stuck in a non-IDLE state — which is
        // why this callback is never reverted.
        //
        // (A prior `Wallets.requestNewWallet` gate read
        // `ecdsaWalletRegistry.getWalletCreationState() == IDLE`, so a
        // stuck ECDSA registry would also have blocked every subsequent
        // FROST wallet creation. That gate has since been removed —
        // FROST wallet creation no longer reads the ECDSA registry's
        // state — so a stuck registry can no longer block FROST
        // creation, and not reverting here is retained only to avoid
        // breaking the ECDSA registry's own DKG completion.)
        //
        // The retirement contract relies on operational sequencing:
        // governance pauses Bridge, waits for any in-flight ECDSA DKG
        // to settle (callback fires, this function runs, registry
        // returns to IDLE), then sets `ecdsaRetired = true`, then
        // unpauses. Bridge no longer dispatches ECDSA wallet creation
        // at all: `requestNewWallet` dispatches only to the FROST
        // registry (the scheme branch and the `setNewWalletScheme`
        // setters were removed), so no subsequent ECDSA wallet can be
        // created.
        // Reserve `ecdsaWalletID == bytes32(0)` as the on-chain marker for
        // FROST-keyed wallets registered via `registerNewFrostWallet`. The
        // Bridge enforces this invariant at the registration boundary so
        // downstream paths that distinguish wallet schemes by inspecting
        // `wallet.ecdsaWalletID` can rely on the marker being correctly
        // set. The external ECDSA Wallet Registry must therefore never
        // pass a zero ECDSA wallet ID. Custom error keeps the Bridge
        // implementation bytecode under the 24 KiB EIP-170 deploy limit.
        if (ecdsaWalletID == bytes32(0)) {
            revert EcdsaWalletIdIsZero();
        }

        // Compress wallet's public key and calculate Bitcoin's hash160 of it.
        bytes20 walletPubKeyHash = bytes20(
            EcdsaLib.compressPublicKey(publicKeyX, publicKeyY).hash160View()
        );
        bytes32 walletID = deriveLegacyWalletID(walletPubKeyHash);

        Wallet storage wallet = self.registeredWallets[walletPubKeyHash];
        require(
            wallet.state == WalletState.Unknown,
            "ECDSA wallet has been already registered"
        );
        wallet.ecdsaWalletID = ecdsaWalletID;
        wallet.state = WalletState.Live;
        /* solhint-disable-next-line not-rely-on-time */
        wallet.createdAt = uint32(block.timestamp);

        // A callback for an ECDSA DKG started before the FROST upgrade may
        // arrive after a newer FROST wallet has already been registered. The
        // callback must still succeed so the legacy registry can complete its
        // DKG, but it must not route new deposits away from that FROST wallet.
        // Preserve the legacy replacement behavior when there is no active
        // wallet or the current active wallet is itself ECDSA-keyed.
        bytes20 activeWalletPubKeyHash = self.activeWalletPubKeyHash;
        if (
            activeWalletPubKeyHash == bytes20(0) ||
            self.registeredWallets[activeWalletPubKeyHash].ecdsaWalletID !=
            bytes32(0)
        ) {
            self.activeWalletPubKeyHash = walletPubKeyHash;
            self.activeWalletID = walletID;
        }
        self.walletPubKeyHashByWalletID[walletID] = walletPubKeyHash;

        self.liveWalletsCount++;
        // C-2.1: total-created counter for D-2 retirement
        // bookkeeping. Strictly monotonic; not decremented when
        // a wallet closes or terminates. D-2's
        // `finalizeEcdsaRetirement` verifies the
        // governance-supplied retired-wallet list covers exactly
        // this many wallets in a terminal state.
        self.ecdsaWalletCount += 1;

        emit NewWalletRegistered(ecdsaWalletID, walletPubKeyHash);
        emit NewWalletRegisteredV2(walletID, ecdsaWalletID, walletPubKeyHash);
    }

    /// @notice Registers a new FROST/Schnorr-keyed wallet given its 32-byte
    ///         x-only Taproot output key. The canonical 32-byte walletID is
    ///         the x-only output key itself; the 20-byte compatibility
    ///         pubKeyHash is `HASH160(0x02 || xOnlyOutputKey)`, derived via
    ///         `BitcoinTx.deriveWalletPubKeyHashFromXOnly`.
    /// @param xOnlyOutputKey The 32-byte x-only Taproot output key emitted
    ///        by the FROST DKG coordinator. Must be the post-tweak output
    ///        key (the key that actually appears in P2TR scripts), not an
    ///        untweaked internal aggregate key.
    /// @dev Requirements:
    ///      - The only caller authorized to call this function is the FROST
    ///        wallet registry configured via `setFrostWalletRegistry`,
    ///      - `xOnlyOutputKey` must be non-zero,
    ///      - `xOnlyOutputKey` must NOT be a left-padded legacy alias
    ///        (its high 12 bytes must not all be zero); the SDK fallback
    ///        and `walletPubKeyHashByWalletID` consumers treat left-padded
    ///        IDs as legacy walletIDs, so a native FROST walletID must
    ///        never share that shape,
    ///      - The derived canonical walletID must not collide with the
    ///        legacy walletID derivation for the same `walletPubKeyHash`
    ///        (defense in depth — preserves the assumption made by
    ///        the Fraud.sol legacy-ECDSA guard that FROST walletIDs are
    ///        structurally distinguishable from legacy ones),
    ///      - Given wallet data must not belong to an already registered
    ///        wallet (collision on `walletPubKeyHash`).
    ///
    ///      The new wallet is stored with `ecdsaWalletID = bytes32(0)` —
    ///      this is the on-chain marker that distinguishes FROST wallets
    ///      from ECDSA ones. The mainUtxoHash and other lifecycle fields
    ///      are initialised to zero/default so the wallet can cleanly
    ///      accept its first deposit sweep, mirroring `registerNewWallet`.
    ///
    ///      Both `NewFrostWalletRegistered` (FROST-specific) and
    ///      `NewWalletRegisteredV2` (compatibility) events fire. The
    ///      V1 `NewWalletRegistered(ecdsaWalletID, walletPubKeyHash)`
    ///      event is intentionally NOT emitted because its
    ///      `ecdsaWalletID` semantics would be misleading for a FROST
    ///      wallet; consumers that still subscribe only to V1 will not
    ///      see FROST wallets until they migrate to V2 or the new
    ///      FROST-specific event.
    function registerNewFrostWallet(
        BridgeState.Storage storage self,
        bytes32 xOnlyOutputKey
    ) external {
        address frostWalletRegistry = self.frostWalletRegistry;
        if (frostWalletRegistry == address(0)) {
            revert FrostWalletRegistryNotSet();
        }
        if (msg.sender != frostWalletRegistry) {
            revert CallerIsNotFrostWalletRegistry();
        }
        // Gate FROST wallet creation on both ends of the lifecycle
        // path being wired up. Without a lifecycle router, the
        // wallet's eventual closeWallet/seize/isWalletMember would
        // have no dispatcher and the wallet would be stuck. Caught
        // before the wallet enters Live state.
        address lifecycleRouter = self.lifecycleRouter;
        if (lifecycleRouter == address(0)) {
            revert LifecycleRouterNotSet();
        }
        if (
            IFrostWalletRegistryRequest(frostWalletRegistry).lifecycleOwner() !=
            lifecycleRouter
        ) {
            revert LifecycleOwnerMismatch();
        }
        if (xOnlyOutputKey == bytes32(0)) {
            revert FrostWalletIdIsZero();
        }
        if (bytes12(xOnlyOutputKey) == bytes12(0)) {
            revert FrostWalletIdNotNative();
        }

        bytes20 walletPubKeyHash = BitcoinTx.deriveWalletPubKeyHashFromXOnly(
            xOnlyOutputKey
        );
        bytes32 walletID = xOnlyOutputKey;

        if (walletID == deriveLegacyWalletID(walletPubKeyHash)) {
            revert FrostWalletIdCollidesWithLegacy();
        }

        Wallet storage wallet = self.registeredWallets[walletPubKeyHash];
        if (wallet.state != WalletState.Unknown) {
            revert FrostWalletAlreadyRegistered();
        }

        // Mirror `registerNewWallet` field-for-field so the wallet is in
        // an identical default state and can be consumed by every existing
        // lifecycle path. `ecdsaWalletID` is left as the default
        // `bytes32(0)` — that is the on-chain marker for FROST.
        wallet.state = WalletState.Live;
        /* solhint-disable-next-line not-rely-on-time */
        wallet.createdAt = uint32(block.timestamp);

        self.activeWalletPubKeyHash = walletPubKeyHash;
        self.activeWalletID = walletID;
        self.walletPubKeyHashByWalletID[walletID] = walletPubKeyHash;
        // Reverse mapping: lifecycle dispatcher (router) uses this to
        // recover the canonical walletID from the legacy 20-byte
        // compatibility alias passed by Bridge call sites. ECDSA
        // wallets do not need this mapping populated -- their
        // walletID is derivable on-chain via deriveLegacyWalletID.
        self.walletIDByWalletPubKeyHash[walletPubKeyHash] = walletID;

        self.liveWalletsCount++;

        emit NewFrostWalletRegistered(
            walletID,
            walletPubKeyHash,
            xOnlyOutputKey
        );
        emit NewWalletRegisteredV2(walletID, bytes32(0), walletPubKeyHash);
    }

    /// @notice Derives canonical wallet ID for legacy ECDSA wallets.
    /// @dev Legacy ID format is a left-padded 20-byte wallet public key hash.
    function deriveLegacyWalletID(bytes20 walletPubKeyHash)
        internal
        pure
        returns (bytes32 walletID)
    {
        return bytes32(uint256(uint160(walletPubKeyHash)));
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
            // Slash the wallet operators and reward the notifier.
            // Scheme-aware routing. For ECDSA wallets the registry `seize` is
            // economic token seizure — inert while no T is staked, so it is
            // gated behind `slashingActive`. For FROST wallets the router
            // `seize` is an event-only misbehavior report
            // (FrostAllowlist.reportMaliciousBehavior emits
            // `MaliciousBehaviorIdentified` for DAO-managed operator
            // enforcement) with no economic effect, so it must fire regardless
            // of `slashingActive`.
            if (wallet.ecdsaWalletID != bytes32(0)) {
                if (self.slashingActive) {
                    self.ecdsaWalletRegistry.seize(
                        self.redemptionTimeoutSlashingAmount,
                        self.redemptionTimeoutNotifierRewardMultiplier,
                        msg.sender,
                        wallet.ecdsaWalletID,
                        walletMembersIDs
                    );
                }
            } else {
                IBridgeLifecycleRouter(self.lifecycleRouter).seize(
                    walletPubKeyHash,
                    self.redemptionTimeoutSlashingAmount,
                    self.redemptionTimeoutNotifierRewardMultiplier,
                    msg.sender,
                    walletMembersIDs
                );
            }
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

        // Scheme-aware routing: ECDSA economic seize is gated behind
        // `slashingActive`; the FROST router `seize` is an event-only
        // misbehavior report and fires regardless (see
        // notifyWalletRedemptionTimeout).
        if (wallet.ecdsaWalletID != bytes32(0)) {
            if (self.slashingActive) {
                self.ecdsaWalletRegistry.seize(
                    self.movingFundsTimeoutSlashingAmount,
                    self.movingFundsTimeoutNotifierRewardMultiplier,
                    msg.sender,
                    wallet.ecdsaWalletID,
                    walletMembersIDs
                );
            }
        } else {
            IBridgeLifecycleRouter(self.lifecycleRouter).seize(
                walletPubKeyHash,
                self.movingFundsTimeoutSlashingAmount,
                self.movingFundsTimeoutNotifierRewardMultiplier,
                msg.sender,
                walletMembersIDs
            );
        }

        terminateWallet(self, walletPubKeyHash);
    }

    /// @notice Called when a wallet which was asked to sweep funds moved from
    ///         another wallet did not provide a sweeping proof before a timeout.
    ///         Slashes and terminates the wallet who failed to provide a proof.
    /// @param walletPubKeyHash 20-byte public key hash of the wallet which was
    ///        supposed to sweep funds.
    /// @param walletMembersIDs Identifiers of the wallet signing group members.
    /// @dev Requirements:
    ///      - The wallet must be in the `Live`, `MovingFunds`,
    ///        or `Terminated` state.
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
                walletState == WalletState.Terminated,
            "Wallet must be in Live or MovingFunds or Terminated state"
        );

        if (
            walletState == Wallets.WalletState.Live ||
            walletState == Wallets.WalletState.MovingFunds
        ) {
            // Scheme-aware routing: ECDSA economic seize is gated behind
            // `slashingActive`; the FROST router `seize` is an event-only
            // misbehavior report and fires regardless (see
            // notifyWalletRedemptionTimeout).
            if (wallet.ecdsaWalletID != bytes32(0)) {
                if (self.slashingActive) {
                    self.ecdsaWalletRegistry.seize(
                        self.movedFundsSweepTimeoutSlashingAmount,
                        self.movedFundsSweepTimeoutNotifierRewardMultiplier,
                        msg.sender,
                        wallet.ecdsaWalletID,
                        walletMembersIDs
                    );
                }
            } else {
                IBridgeLifecycleRouter(self.lifecycleRouter).seize(
                    walletPubKeyHash,
                    self.movedFundsSweepTimeoutSlashingAmount,
                    self.movedFundsSweepTimeoutNotifierRewardMultiplier,
                    msg.sender,
                    walletMembersIDs
                );
            }

            terminateWallet(self, walletPubKeyHash);
        }
    }

    /// @notice Called when a wallet which was challenged for a fraud did not
    ///         defeat the challenge before the timeout. Slashes and terminates
    ///         the wallet who failed to defeat the challenge. If the wallet is
    ///         already terminated or closed, it does nothing.
    /// @param walletPubKeyHash 20-byte public key hash of the wallet which was
    ///        supposed to sweep funds.
    /// @param walletMembersIDs Identifiers of the wallet signing group members.
    /// @param challenger Address of the party which submitted the fraud
    ///        challenge.
    /// @dev Requirements:
    ///      - The wallet must be in the `Live`, `MovingFunds`, `Closing`,
    ///        `Closed`, or `Terminated` state.
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
            // Scheme-aware routing: ECDSA economic seize is gated behind
            // `slashingActive`; the FROST router `seize` is an event-only
            // misbehavior report and fires regardless (see
            // notifyWalletRedemptionTimeout).
            if (wallet.ecdsaWalletID != bytes32(0)) {
                if (self.slashingActive) {
                    self.ecdsaWalletRegistry.seize(
                        self.fraudSlashingAmount,
                        self.fraudNotifierRewardMultiplier,
                        challenger,
                        wallet.ecdsaWalletID,
                        walletMembersIDs
                    );
                }
            } else {
                IBridgeLifecycleRouter(self.lifecycleRouter).seize(
                    walletPubKeyHash,
                    self.fraudSlashingAmount,
                    self.fraudNotifierRewardMultiplier,
                    challenger,
                    walletMembersIDs
                );
            }

            terminateWallet(self, walletPubKeyHash);
        } else if (
            walletState == Wallets.WalletState.Terminated ||
            walletState == Wallets.WalletState.Closed
        ) {
            // A terminated wallet may have other fraud challenges pending. A
            // closed wallet may have a legacy challenge that was not covered
            // by a closure guard before migration. In both cases, registry
            // lifecycle has already ended, so the wallet cannot be seized or
            // terminated again. The callback must still succeed so the caller
            // can release the challenge escrow and accounting lock.
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
            delete self.activeWalletID;
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

        wallet.state = WalletState.Closed;

        emit WalletClosed(wallet.ecdsaWalletID, walletPubKeyHash);

        // Scheme-aware lifecycle routing. ECDSA wallets remain
        // unchanged: Bridge stays the wallet owner and calls the
        // ECDSA registry directly, preserving the existing
        // ownership and callback model. FROST wallets dispatch
        // through the lifecycle router, which forwards to
        // frostWalletRegistry.
        if (wallet.ecdsaWalletID != bytes32(0)) {
            self.ecdsaWalletRegistry.closeWallet(wallet.ecdsaWalletID);
        } else {
            IBridgeLifecycleRouter(self.lifecycleRouter).closeWallet(
                walletPubKeyHash
            );
        }
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
            delete self.activeWalletID;
        }

        // Scheme-aware lifecycle routing. ECDSA wallets remain
        // unchanged: Bridge stays the wallet owner and calls the
        // ECDSA registry directly, preserving the existing
        // ownership and callback model. FROST wallets dispatch
        // through the lifecycle router, which forwards to
        // frostWalletRegistry.
        if (wallet.ecdsaWalletID != bytes32(0)) {
            self.ecdsaWalletRegistry.closeWallet(wallet.ecdsaWalletID);
        } else {
            IBridgeLifecycleRouter(self.lifecycleRouter).closeWallet(
                walletPubKeyHash
            );
        }
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
