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

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import "./api/IWalletExposureLedger.sol";

/// @title WalletExposureLedger
/// @notice The lifecycle-coupling primitive of the delegated staking
///         module. The FROST wallet registry notifies the ledger when a
///         wallet is registered (`approveDkgResult`) and when it is closed
///         (`closeWallet`). Per staking provider the ledger maintains a
///         monotonically increasing exposure epoch counter — each wallet
///         registration assigns the provider a fresh epoch — plus the set
///         of live epochs and a lazily advanced oldest-live-epoch pointer.
///         Stake exits requested at epoch E may only finalize once no live
///         wallet with a per-provider epoch <= E remains
///         (`hasLiveExposureAtOrBefore`), coupling exits to wallet
///         retirement instead of a timer.
/// @dev Both registry hooks are invoked by the registry inside try/catch:
///      a ledger failure must never brick DKG result approval or wallet
///      closure. The view-side lazy walk is bounded and fails safe — if it
///      cannot determine the answer it reports live exposure, keeping
///      exits locked rather than unlocking them early.
contract WalletExposureLedger is
    Initializable,
    OwnableUpgradeable,
    IWalletExposureLedger
{
    struct WalletRecord {
        // Staking providers holding seats in the wallet, as reported by
        // the registry (unique entries with aggregated seat counts).
        address[] stakingProviders;
        // Per-provider exposure epoch assigned at registration, aligned
        // with `stakingProviders`.
        uint64[] epochs;
        // Seat count per provider, aligned with `stakingProviders`. Stored
        // for future seat-exposure-weighted rewards; not otherwise used.
        uint32[] seatCounts;
        // True while the wallet is registered and not yet closed.
        bool live;
    }

    /// @notice Maximum number of epochs a single oldest-live-epoch walk
    ///         advances (state-side) or inspects (view-side). Keeps both
    ///         paths gas-bounded; the amortized cost is O(1) per epoch.
    uint256 internal constant OLDEST_EPOCH_WALK_LIMIT = 256;

    /// @notice Address of the FROST wallet registry — the only caller of
    ///         the two lifecycle hooks.
    address public frostWalletRegistry;

    /// @notice Latest exposure epoch assigned per staking provider.
    mapping(address => uint64) internal epochCounter;

    /// @notice Number of live (registered, not yet closed) wallets per
    ///         staking provider.
    mapping(address => uint32) public liveWalletCount;

    /// @notice True if the given per-provider epoch is backed by a live
    ///         wallet.
    mapping(address => mapping(uint64 => bool)) public liveEpochs;

    /// @notice Lazily advanced pointer at (or below) the provider's oldest
    ///         live epoch. Invariant: no live epoch exists below the
    ///         pointer; the pointer itself may lag on dead epochs and is
    ///         advanced by closures (bounded) and healed by registrations
    ///         when no live exposure remains.
    mapping(address => uint64) public oldestLiveEpoch;

    mapping(bytes32 => WalletRecord) internal walletRecords;

    // Reserved storage space in case we need to add more variables.
    // The convention from OpenZeppelin suggests the storage space should
    // add up to 50 slots.
    // See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
    // slither-disable-next-line unused-state
    uint256[44] private __gap;

    event WalletExposureRegistered(
        bytes32 indexed walletID,
        address[] stakingProviders,
        uint64[] epochs,
        uint32[] seatCounts
    );
    event WalletExposureClosed(bytes32 indexed walletID);

    error ZeroAddress();
    error NotWalletRegistry();
    error ArrayLengthMismatch();
    error WalletAlreadyRegistered();

    modifier onlyWalletRegistry() {
        if (msg.sender != frostWalletRegistry) {
            revert NotWalletRegistry();
        }
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @dev Initializes upgradable contract on deployment.
    /// @param _frostWalletRegistry Address of the FROST wallet registry.
    function initialize(address _frostWalletRegistry) external initializer {
        if (_frostWalletRegistry == address(0)) {
            revert ZeroAddress();
        }

        __Ownable_init();

        frostWalletRegistry = _frostWalletRegistry;
    }

    /// @notice See {IWalletExposureLedger-onWalletRegistered}. Assigns each
    ///         listed staking provider its next exposure epoch, marks the
    ///         epoch live, and stores the wallet record.
    /// @dev Can only be called by the FROST wallet registry. The registry
    ///      passes unique providers; if a provider were repeated, each
    ///      occurrence would simply consume its own epoch and be cleared
    ///      again on closure, so accounting stays consistent either way.
    function onWalletRegistered(
        bytes32 walletID,
        address[] calldata stakingProviders,
        uint32[] calldata seatCounts
    ) external override onlyWalletRegistry {
        if (stakingProviders.length != seatCounts.length) {
            revert ArrayLengthMismatch();
        }

        WalletRecord storage record = walletRecords[walletID];
        if (record.live || record.epochs.length != 0) {
            revert WalletAlreadyRegistered();
        }

        uint64[] memory epochs = new uint64[](stakingProviders.length);
        for (uint256 i = 0; i < stakingProviders.length; i++) {
            address stakingProvider = stakingProviders[i];
            uint64 epoch = ++epochCounter[stakingProvider];

            // If the provider has no live exposure, the new epoch IS the
            // oldest live epoch. Besides initializing first-time
            // providers, this heals a pointer left behind on a long dead
            // range by the bounded closure walk.
            if (liveWalletCount[stakingProvider] == 0) {
                oldestLiveEpoch[stakingProvider] = epoch;
            }

            liveEpochs[stakingProvider][epoch] = true;
            liveWalletCount[stakingProvider]++;
            epochs[i] = epoch;
        }

        record.stakingProviders = stakingProviders;
        record.epochs = epochs;
        record.seatCounts = seatCounts;
        record.live = true;

        emit WalletExposureRegistered(
            walletID,
            stakingProviders,
            epochs,
            seatCounts
        );
    }

    /// @notice See {IWalletExposureLedger-onWalletClosed}. Clears the
    ///         liveness of every epoch recorded for the wallet, decrements
    ///         the providers' live wallet counts, and lazily advances their
    ///         oldest-live-epoch pointers. Idempotent — closing an
    ///         already-closed or unknown wallet is a no-op.
    /// @dev Can only be called by the FROST wallet registry.
    function onWalletClosed(bytes32 walletID)
        external
        override
        onlyWalletRegistry
    {
        WalletRecord storage record = walletRecords[walletID];
        if (!record.live) {
            return;
        }
        record.live = false;

        for (uint256 i = 0; i < record.stakingProviders.length; i++) {
            address stakingProvider = record.stakingProviders[i];
            uint64 epoch = record.epochs[i];

            if (liveEpochs[stakingProvider][epoch]) {
                liveEpochs[stakingProvider][epoch] = false;
                liveWalletCount[stakingProvider]--;
            }

            // Advance the oldest-live-epoch pointer over dead epochs. The
            // walk is bounded per call; any remainder is picked up by
            // subsequent closures, registrations (when no live exposure
            // remains), or absorbed by the bounded view-side walk.
            uint64 oldest = oldestLiveEpoch[stakingProvider];
            uint64 latest = epochCounter[stakingProvider];
            uint256 steps = 0;
            while (
                oldest <= latest &&
                steps < OLDEST_EPOCH_WALK_LIMIT &&
                !liveEpochs[stakingProvider][oldest]
            ) {
                oldest++;
                steps++;
            }
            oldestLiveEpoch[stakingProvider] = oldest;
        }

        emit WalletExposureClosed(walletID);
    }

    /// @notice See {IWalletExposureLedger-currentEpoch}.
    function currentEpoch(address stakingProvider)
        external
        view
        override
        returns (uint64)
    {
        return epochCounter[stakingProvider];
    }

    /// @notice See {IWalletExposureLedger-hasLiveExposureAtOrBefore}.
    ///         Returns true if the staking provider still has live exposure
    ///         to any wallet whose per-provider epoch is at or before the
    ///         given epoch.
    /// @dev Walks forward from the stored oldest-live-epoch pointer
    ///      (without mutating it — this is a view) looking for the first
    ///      live epoch, bounded to `OLDEST_EPOCH_WALK_LIMIT` steps. If the
    ///      walk cannot determine the answer within the bound, it returns
    ///      true — fail-safe: exits stay locked, they are never unlocked
    ///      wrongly.
    function hasLiveExposureAtOrBefore(address stakingProvider, uint64 epoch)
        external
        view
        override
        returns (bool)
    {
        if (liveWalletCount[stakingProvider] == 0) {
            return false;
        }

        uint64 oldest = oldestLiveEpoch[stakingProvider];
        uint64 latest = epochCounter[stakingProvider];

        for (uint256 steps = 0; steps < OLDEST_EPOCH_WALK_LIMIT; steps++) {
            if (oldest > latest) {
                // No live epoch found up to the latest assigned one even
                // though the live count is non-zero — inconsistent state
                // that should be unreachable. Fail safe: report exposure.
                return true;
            }
            if (liveEpochs[stakingProvider][oldest]) {
                return oldest <= epoch;
            }
            oldest++;
        }

        // Walk bound exhausted without an answer. Fail safe: report
        // exposure so exits stay locked.
        return true;
    }

    /// @notice Returns the stored exposure record of the given wallet.
    /// @param walletID Identifier of the wallet.
    /// @return stakingProviders Unique staking providers holding seats.
    /// @return epochs Per-provider exposure epochs assigned at
    ///         registration.
    /// @return seatCounts Seat count per provider.
    /// @return live True while the wallet is registered and not yet
    ///         closed.
    function getWalletExposure(bytes32 walletID)
        external
        view
        returns (
            address[] memory stakingProviders,
            uint64[] memory epochs,
            uint32[] memory seatCounts,
            bool live
        )
    {
        WalletRecord storage record = walletRecords[walletID];
        return (
            record.stakingProviders,
            record.epochs,
            record.seatCounts,
            record.live
        );
    }
}
