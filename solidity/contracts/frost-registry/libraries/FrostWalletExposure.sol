// SPDX-License-Identifier: GPL-3.0-only
//
// ▓▓▌ ▓▓ ▐▓▓ ▓▓▓▓▓▓▓▓▓▓▌▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▄
// ▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▌▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
//   ▓▓▓▓▓▓    ▓▓▓▓▓▓▓▀    ▐▓▓▓▓▓▓    ▐▓▓▓▓▓   ▓▓▓▓▓▓     ▓▓▓▓▓   ▐▓▓▓▓▓▌   ▐▓▓▓▓▓▓
//   ▓▓▓▓▓▓▄▄▓▓▓▓▓▓▓▀      ▐▓▓▓▓▓▓▄▄▄▄         ▓▓▓▓▓▓▄▄▄▄         ▐▓▓▓▓▓▌   ▐▓▓▓▓▓▓
//   ▓▓▓▓▓▓▓▓▓▓▓▓▓▀        ▐▓▓▓▓▓▓▓▓▓▓         ▓▓▓▓▓▓▓▓▓▓         ▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
//   ▓▓▓▓▓▓▀▀▓▓▓▓▓▓▄       ▐▓▓▓▓▓▓▀▀▀▀         ▓▓▓▓▓▓▀▀▀▀         ▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▀
//   ▓▓▓▓▓▓   ▀▓▓▓▓▓▓▄     ▐▓▓▓▓▓▓     ▓▓▓▓▓   ▓▓▓▓▓▓     ▓▓▓▓▓   ▐▓▓▓▓▓▌
// ▓▓▓▓▓▓▓▓▓▓ █▓▓▓▓▓▓▓▓▓ ▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  ▓▓▓▓▓▓▓▓▓▓
// ▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓ ▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  ▓▓▓▓▓▓▓▓▓▓
//
//                           Trust math, not hardware.

pragma solidity 0.8.17;

import "@keep-network/sortition-pools/contracts/SortitionPool.sol";
import "@openzeppelin/contracts/utils/StorageSlot.sol";

import "../api/IFrostAuthorizationSource.sol";
import "./FrostRegistryWallets.sol";
import {FrostAuthorization as Authorization} from "./FrostAuthorization.sol";
import "../../staking/api/IWalletExposureLedger.sol";

interface IFrostAuthorizationMigration {
    function prepareAuthorizationMigration(address[] calldata stakingProviders)
        external;

    function detachAuthorizationSource(address[] calldata stakingProviders)
        external;
}

interface IFrostRegistryGovernance {
    function governance() external view returns (address);
}

interface IFrostRegistryDkgState {
    function getWalletCreationState() external view returns (uint8);
}

interface IFrostRegistryAuthorizationState {
    function authorizationSource()
        external
        view
        returns (IFrostAuthorizationSource);
}

/// @title FROST wallet exposure notification
/// @notice Resolves a registered wallet's signing group member IDs to their
///         staking providers and notifies the wallet exposure ledger. Kept
///         as an externally linked library (like `FrostInactivity`) so the
///         resolution and encoding code lives outside the
///         `FrostWalletRegistry` bytecode — the registry runs close to the
///         contract size limit.
library FrostWalletExposure {
    using Authorization for Authorization.Data;

    struct Data {
        // Wallet exposure ledger notified about wallet registrations and
        // closures. Zero address while unset — notifications are skipped.
        IWalletExposureLedger ledger;
        // Lifecycle events observed since the implementation containing these
        // counters became active. The pre-upgrade portion is supplied once,
        // and permanently recorded, during the first stateful-source migration.
        uint256 walletsCreatedAfterUpgrade;
        uint256 walletsClosedAfterUpgrade;
        uint256 historicalWalletsCreated;
        uint256 historicalWalletsClosed;
        bool historicalWalletCountSet;
        // True while the current source uses the stateful migration hooks.
        bool statefulAuthorizationSource;
        // Complete legacy roster captured immediately before the stateful
        // cutover. Rollback uses it as the target roster so providers removed
        // by the stateful source can be reinserted atomically.
        address[] rollbackStakingProviders;
    }

    /// @notice Emitted when the wallet exposure ledger address is set.
    /// @dev Emitted via delegatecall, so the log is attributed to the
    ///      `FrostWalletRegistry` address.
    event WalletExposureLedgerSet(address walletExposureLedger);
    event AuthorizationSourceUpdated(address authorizationSource);

    /// @notice Emitted when a notification call to the wallet exposure
    ///         ledger reverted. The failure is swallowed on purpose —
    ///         neither DKG result approval nor wallet closure may be
    ///         bricked by the ledger. Emitted via delegatecall, so the
    ///         log is attributed to the `FrostWalletRegistry` address.
    event WalletExposureLedgerCallFailed(bytes32 indexed walletID);
    event AuthorizationSourceCallbackFailed(bytes4 indexed selector);

    /// @notice Emitted when a swallowed `onWalletRegistered` hook is repaired
    ///         by `reconcile`: a wallet the registry still confirms as
    ///         registered, but that the ledger never recorded, is re-recorded
    ///         as live. Emitted via delegatecall, so the log is attributed to
    ///         the `FrostWalletRegistry` address.
    event WalletExposureReconciledRegistered(bytes32 indexed walletID);

    /// @notice Emitted when a swallowed `onWalletClosed` hook is repaired by
    ///         `reconcile`: a wallet the registry no longer knows, but that
    ///         the ledger still marks live, has its closure replayed. Emitted
    ///         via delegatecall, so the log is attributed to the
    ///         `FrostWalletRegistry` address.
    event WalletExposureReconciledClosed(bytes32 indexed walletID);

    /// @notice Emitted once when governance supplies the event-audited wallet
    ///         lifecycle totals from before the exposure counters existed.
    event HistoricalWalletCountSet(
        uint256 walletsCreated,
        uint256 walletsClosed
    );
    /// @notice Raised when `setLedger` is called after the ledger address
    ///         has already been set. The ledger wiring is one-shot;
    ///         migrating to a new ledger is upgrade-only.
    error WalletExposureLedgerAlreadySet();

    /// @notice Raised when `reconcile` is called before the ledger has been
    ///         wired: there is nothing to reconcile against.
    error WalletExposureLedgerNotSet();

    /// @notice Raised when `reconcile` finds the ledger already consistent
    ///         with the registry's authoritative wallet state — there is no
    ///         swallowed hook to repair. Also the idempotency barrier: a
    ///         second reconcile of the same wallet reverts here.
    error WalletExposureInSync();

    /// @notice Raised when `setLedger` is called with the zero address.
    error WalletExposureLedgerAddressZero();

    /// @notice Raised when `setLedger` is called with an address that has
    ///         no deployed code. A codeless ledger would make the
    ///         compiler-inserted extcodesize check on the notification
    ///         calls revert OUTSIDE the try/catch, bricking DKG result
    ///         approval and wallet closure.
    error WalletExposureLedgerNotContract();
    error AuthorizationSourceAddressZero();
    error AuthorizationSourceNotContract();
    error CallerNotGovernanceOrProxyAdmin();
    error AuthorizationMigrationPreparationFailed(bytes reason);
    error AuthorizationMigrationDetachmentFailed(bytes reason);
    error WalletExposureLedgerMigrationNotReady();
    error HistoricalWalletCountInvalid();
    error HistoricalWalletCountMismatch();
    error LiveWalletRosterLengthMismatch();
    error LiveWalletRosterDuplicate();
    error LiveWalletRosterWalletNotRegistered();
    error LiveWalletRosterLedgerMismatch();

    /// @notice Validates and rewrites every active sortition-pool leaf for an
    ///         authorization-source migration. Kept in this linked library so
    ///         the registry remains below the EIP-170 bytecode limit.
    function migrateAuthorizationSource(
        Data storage self,
        Authorization.Data storage authorization,
        SortitionPool sortitionPool,
        FrostRegistryWallets.Data storage wallets,
        IFrostAuthorizationSource authorizationSource,
        bool statefulTarget,
        address walletExposureLedger,
        address[] calldata stakingProviders,
        bytes calldata liveWalletProof
    ) external {
        require(
            IFrostRegistryDkgState(address(this)).getWalletCreationState() == 0,
            "Current state is not IDLE"
        );
        IFrostAuthorizationSource currentAuthorizationSource = IFrostRegistryAuthorizationState(
                address(this)
            ).authorizationSource();
        if (
            msg.sender == address(currentAuthorizationSource) &&
            address(authorizationSource) ==
            address(currentAuthorizationSource) &&
            statefulTarget == self.statefulAuthorizationSource &&
            walletExposureLedger == address(0) &&
            liveWalletProof.length == 0
        ) {
            _validateCurrentAuthorizationRoster(
                authorization,
                sortitionPool,
                stakingProviders
            );
            _rewriteAuthorizationRoster(
                authorization,
                sortitionPool,
                authorizationSource,
                stakingProviders
            );
            return;
        }
        if (
            msg.sender != IFrostRegistryGovernance(address(this)).governance()
        ) {
            address proxyAdmin = StorageSlot
                .getAddressSlot(
                    0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103
                )
                .value;
            if (msg.sender != proxyAdmin) {
                revert CallerNotGovernanceOrProxyAdmin();
            }
        }
        if (address(authorizationSource) == address(0)) {
            revert AuthorizationSourceAddressZero();
        }
        if (address(authorizationSource).code.length == 0) {
            revert AuthorizationSourceNotContract();
        }
        _validateCurrentAuthorizationRoster(
            authorization,
            sortitionPool,
            stakingProviders
        );

        _detachCurrentStatefulSource(self, stakingProviders);

        if (statefulTarget) {
            _prepareStatefulTarget(
                self,
                wallets,
                authorizationSource,
                walletExposureLedger,
                stakingProviders,
                liveWalletProof
            );
        }

        _rewriteMigrationRoster(
            self,
            authorization,
            sortitionPool,
            authorizationSource,
            statefulTarget,
            stakingProviders
        );

        self.statefulAuthorizationSource = statefulTarget;
        emit AuthorizationSourceUpdated(address(authorizationSource));
    }

    function _detachCurrentStatefulSource(
        Data storage self,
        address[] calldata stakingProviders
    ) private {
        if (!self.statefulAuthorizationSource) return;

        try
            IFrostAuthorizationMigration(
                address(
                    IFrostRegistryAuthorizationState(address(this))
                        .authorizationSource()
                )
            ).detachAuthorizationSource(stakingProviders)
        {} catch (bytes memory reason) {
            revert AuthorizationMigrationDetachmentFailed(reason);
        }
    }

    function _prepareStatefulTarget(
        Data storage self,
        FrostRegistryWallets.Data storage wallets,
        IFrostAuthorizationSource authorizationSource,
        address walletExposureLedger,
        address[] calldata stakingProviders,
        bytes calldata liveWalletProof
    ) private {
        if (!self.statefulAuthorizationSource) {
            delete self.rollbackStakingProviders;
            for (uint256 i = 0; i < stakingProviders.length; i++) {
                self.rollbackStakingProviders.push(stakingProviders[i]);
            }
        }

        if (address(self.ledger) == address(0)) {
            _setLedger(self, walletExposureLedger);
        } else if (
            walletExposureLedger != address(0) &&
            walletExposureLedger != address(self.ledger)
        ) {
            revert WalletExposureLedgerAlreadySet();
        }

        // Stateful capability is explicit in calldata. Any preparation
        // failure, including an empty-data revert, is therefore a real failure
        // and must roll the source change back.
        try
            IFrostAuthorizationMigration(address(authorizationSource))
                .prepareAuthorizationMigration(stakingProviders)
        {} catch (bytes memory reason) {
            revert AuthorizationMigrationPreparationFailed(reason);
        }
        _verifyLiveWalletRoster(
            self,
            wallets,
            authorizationSource,
            liveWalletProof
        );
    }

    function _rewriteMigrationRoster(
        Data storage self,
        Authorization.Data storage authorization,
        SortitionPool sortitionPool,
        IFrostAuthorizationSource authorizationSource,
        bool statefulTarget,
        address[] calldata stakingProviders
    ) private {
        if (self.statefulAuthorizationSource && !statefulTarget) {
            _validateTargetAuthorizationRoster(
                authorization,
                self.rollbackStakingProviders
            );
            _rewriteRollbackRoster(
                authorization,
                sortitionPool,
                authorizationSource,
                stakingProviders,
                self.rollbackStakingProviders
            );
            return;
        }

        _rewriteAuthorizationRoster(
            authorization,
            sortitionPool,
            authorizationSource,
            stakingProviders
        );
    }

    function _validateCurrentAuthorizationRoster(
        Authorization.Data storage authorization,
        SortitionPool sortitionPool,
        address[] calldata stakingProviders
    ) private view {
        require(
            stakingProviders.length == sortitionPool.operatorsInPool(),
            "Authorization roster length mismatch"
        );

        for (uint256 i = 0; i < stakingProviders.length; i++) {
            address stakingProvider = stakingProviders[i];
            address operator = authorization.stakingProviderToOperator[
                stakingProvider
            ];
            require(
                operator != address(0) &&
                    sortitionPool.isOperatorInPool(operator),
                "Authorization roster operator not pooled"
            );
            require(
                authorization.pendingDecreases[stakingProvider].decreasingAt ==
                    0,
                "Authorization decrease pending"
            );
            for (uint256 j = 0; j < i; j++) {
                require(
                    stakingProviders[j] != stakingProvider,
                    "Duplicate authorization roster provider"
                );
            }
        }
    }

    function _validateTargetAuthorizationRoster(
        Authorization.Data storage authorization,
        address[] storage stakingProviders
    ) private view {
        for (uint256 i = 0; i < stakingProviders.length; i++) {
            address stakingProvider = stakingProviders[i];
            require(
                authorization.stakingProviderToOperator[stakingProvider] !=
                    address(0),
                "Authorization roster operator unknown"
            );
            require(
                authorization.pendingDecreases[stakingProvider].decreasingAt ==
                    0,
                "Authorization decrease pending"
            );
        }
    }

    function _rewriteAuthorizationRoster(
        Authorization.Data storage authorization,
        SortitionPool sortitionPool,
        IFrostAuthorizationSource authorizationSource,
        address[] calldata stakingProviders
    ) private {
        for (uint256 i = 0; i < stakingProviders.length; i++) {
            authorization.migrateOperatorStatus(
                authorizationSource,
                sortitionPool,
                authorization.stakingProviderToOperator[stakingProviders[i]]
            );
        }
    }

    function _rewriteRollbackRoster(
        Authorization.Data storage authorization,
        SortitionPool sortitionPool,
        IFrostAuthorizationSource authorizationSource,
        address[] calldata currentStakingProviders,
        address[] storage rollbackStakingProviders
    ) private {
        // Rewrite every currently pooled leaf first. Providers absent from the
        // legacy roster normally resolve to zero and are removed.
        _rewriteAuthorizationRoster(
            authorization,
            sortitionPool,
            authorizationSource,
            currentStakingProviders
        );

        // Reinsert every preserved legacy provider whose stateful weight had
        // fallen to zero and removed it from the pool.
        for (uint256 i = 0; i < rollbackStakingProviders.length; i++) {
            address operator = authorization.stakingProviderToOperator[
                rollbackStakingProviders[i]
            ];
            if (!sortitionPool.isOperatorInPool(operator)) {
                authorization.migrateOperatorStatus(
                    authorizationSource,
                    sortitionPool,
                    operator
                );
            }
        }
    }

    function _verifyLiveWalletRoster(
        Data storage self,
        FrostRegistryWallets.Data storage wallets,
        IFrostAuthorizationSource authorizationSource,
        bytes calldata liveWalletProof
    ) private {
        (
            bytes32[] memory liveWalletIDs,
            uint256 historicalWalletsCreated,
            uint256 historicalWalletsClosed
        ) = abi.decode(liveWalletProof, (bytes32[], uint256, uint256));
        IWalletExposureLedger walletExposureLedger = self.ledger;
        if (
            address(walletExposureLedger) == address(0) ||
            address(walletExposureLedger).code.length == 0
        ) {
            revert WalletExposureLedgerMigrationNotReady();
        }

        if (!self.historicalWalletCountSet) {
            if (historicalWalletsClosed > historicalWalletsCreated) {
                revert HistoricalWalletCountInvalid();
            }
            self.historicalWalletsCreated = historicalWalletsCreated;
            self.historicalWalletsClosed = historicalWalletsClosed;
            self.historicalWalletCountSet = true;
            emit HistoricalWalletCountSet(
                historicalWalletsCreated,
                historicalWalletsClosed
            );
        } else if (
            self.historicalWalletsCreated != historicalWalletsCreated ||
            self.historicalWalletsClosed != historicalWalletsClosed
        ) {
            revert HistoricalWalletCountMismatch();
        }

        uint256 totalWalletsCreated = historicalWalletsCreated +
            self.walletsCreatedAfterUpgrade;
        uint256 totalWalletsClosed = historicalWalletsClosed +
            self.walletsClosedAfterUpgrade;
        if (totalWalletsClosed > totalWalletsCreated) {
            revert HistoricalWalletCountInvalid();
        }
        if (liveWalletIDs.length != totalWalletsCreated - totalWalletsClosed) {
            revert LiveWalletRosterLengthMismatch();
        }

        for (uint256 i = 0; i < liveWalletIDs.length; i++) {
            bytes32 walletID = liveWalletIDs[i];
            if (!FrostRegistryWallets.isWalletRegistered(wallets, walletID)) {
                revert LiveWalletRosterWalletNotRegistered();
            }
            for (uint256 j = 0; j < i; j++) {
                if (liveWalletIDs[j] == walletID) {
                    revert LiveWalletRosterDuplicate();
                }
            }

            (
                address[] memory providers,
                uint64[] memory epochs,
                uint32[] memory seatCounts,
                bool live
            ) = walletExposureLedger.getWalletExposure(walletID);
            if (
                !live ||
                providers.length == 0 ||
                providers.length != epochs.length ||
                providers.length != seatCounts.length
            ) {
                revert LiveWalletRosterLedgerMismatch();
            }

            // The proof can include wallets reconciled while the legacy
            // authorization source was active. Their freshly assigned epochs
            // postdate any withdrawal request made while the ledger was
            // blind, so seed the stateful source's exit-gate floor as part of
            // the same atomic migration. A failure rolls the entire source
            // migration back and can be retried safely.
            authorizationSource.onWalletExposureReconciled(providers);
        }
    }

    /// @notice Sets the wallet exposure ledger address. One-shot: reverts
    ///         if the ledger has already been set, if the given address
    ///         is zero, or if it carries no code. Access control
    ///         (governance-only) is enforced by the calling registry
    ///         function.
    /// @param _ledger Address of the wallet exposure ledger.
    function setLedger(Data storage self, address _ledger) external {
        _setLedger(self, _ledger);
    }

    function _setLedger(Data storage self, address _ledger) private {
        if (address(self.ledger) != address(0)) {
            revert WalletExposureLedgerAlreadySet();
        }
        if (_ledger == address(0)) {
            revert WalletExposureLedgerAddressZero();
        }
        if (_ledger.code.length == 0) {
            revert WalletExposureLedgerNotContract();
        }
        self.ledger = IWalletExposureLedger(_ledger);
        emit WalletExposureLedgerSet(_ledger);
    }

    /// @notice Resolves the wallet signing group member IDs to their staking
    ///         providers (same member-ID → operator → staking provider
    ///         resolution as the registry's `seize`), aggregates them into
    ///         unique provider / seat-count arrays, and notifies the wallet
    ///         exposure ledger about the registered wallet. The lifecycle
    ///         counter advances even when the ledger is not wired; only the
    ///         ledger notification is skipped.
    /// @dev The ledger call is wrapped in try/catch: DKG result approval
    ///      MUST NOT be bricked by the ledger, so a failure only emits
    ///      `WalletExposureLedgerCallFailed`.
    /// @param sortitionPool Sortition pool resolving member IDs to operator
    ///        addresses.
    /// @param operatorToStakingProvider Registry mapping from operator
    ///        address to staking provider address.
    /// @param walletID ID of the newly registered wallet.
    /// @param walletMembersIDs Sortition pool IDs of the wallet signing
    ///        group members, as carried by the approved DKG result.
    function notifyWalletRegistered(
        Data storage self,
        SortitionPool sortitionPool,
        mapping(address => address) storage operatorToStakingProvider,
        bytes32 walletID,
        uint32[] calldata walletMembersIDs
    ) external {
        self.walletsCreatedAfterUpgrade++;
        IWalletExposureLedger walletExposureLedger = self.ledger;
        if (address(walletExposureLedger) == address(0)) {
            return;
        }
        // A ledger that lost its code after wiring (selfdestruct) would
        // make the compiler-inserted extcodesize check on the external
        // call below revert OUTSIDE the try/catch — treat it as a failed
        // notification instead.
        if (address(walletExposureLedger).code.length == 0) {
            emit WalletExposureLedgerCallFailed(walletID);
            return;
        }

        (
            address[] memory uniqueProviders,
            uint32[] memory uniqueSeatCounts
        ) = _resolveUniqueProviders(
                sortitionPool,
                operatorToStakingProvider,
                walletMembersIDs
            );

        try
            walletExposureLedger.onWalletRegistered(
                walletID,
                uniqueProviders,
                uniqueSeatCounts
            )
        // solhint-disable-next-line no-empty-blocks
        {

        } catch {
            emit WalletExposureLedgerCallFailed(walletID);
        }
    }

    /// @notice Resolves the wallet signing group member IDs to their staking
    ///         providers (member ID -> operator -> staking provider) and
    ///         aggregates them into aligned, first-occurrence-ordered unique
    ///         provider / seat-count arrays truncated to the number of
    ///         distinct providers. Shared verbatim by `notifyWalletRegistered`
    ///         and `reconcile` so both build identical exposure payloads.
    /// @param sortitionPool Sortition pool resolving member IDs to operator
    ///        addresses.
    /// @param operatorToStakingProvider Registry mapping from operator
    ///        address to staking provider address.
    /// @param walletMembersIDs Sortition pool IDs of the wallet signing group
    ///        members.
    /// @return uniqueProviders Distinct staking providers, first-occurrence
    ///         ordered.
    /// @return uniqueSeatCounts Seat count per provider, aligned with
    ///         `uniqueProviders`.
    function _resolveUniqueProviders(
        SortitionPool sortitionPool,
        mapping(address => address) storage operatorToStakingProvider,
        uint32[] calldata walletMembersIDs
    )
        private
        view
        returns (
            address[] memory uniqueProviders,
            uint32[] memory uniqueSeatCounts
        )
    {
        address[] memory groupMembersAddresses = sortitionPool.getIDOperators(
            walletMembersIDs
        );

        // Scratch arrays sized for the worst case (all members unique);
        // `uniqueCount` tracks the filled prefix.
        uniqueProviders = new address[](groupMembersAddresses.length);
        uniqueSeatCounts = new uint32[](groupMembersAddresses.length);
        uint256 uniqueCount = 0;

        for (uint256 i = 0; i < groupMembersAddresses.length; i++) {
            address stakingProvider = operatorToStakingProvider[
                groupMembersAddresses[i]
            ];

            bool found = false;
            for (uint256 j = 0; j < uniqueCount; j++) {
                if (uniqueProviders[j] == stakingProvider) {
                    uniqueSeatCounts[j]++;
                    found = true;
                    break;
                }
            }

            if (!found) {
                uniqueProviders[uniqueCount] = stakingProvider;
                uniqueSeatCounts[uniqueCount] = 1;
                uniqueCount++;
            }
        }

        // Truncate the scratch arrays to the filled prefix; the ledger
        // interface expects `stakingProviders` and `seatCounts` to be
        // aligned and to contain unique providers only. Safe because the
        // arrays are only shrunk and are not used again after they are
        // returned to the caller.
        // solhint-disable-next-line no-inline-assembly
        assembly {
            mstore(uniqueProviders, uniqueCount)
            mstore(uniqueSeatCounts, uniqueCount)
        }
    }

    /// @notice Permissionless repair of a wallet exposure ledger desynced by a
    ///         swallowed lifecycle hook (surfaced earlier as
    ///         `WalletExposureLedgerCallFailed`). Both directions are driven
    ///         purely from authoritative registry state — a caller can never
    ///         assert exposure the registry does not corroborate:
    ///
    ///         - Under-counted (premature-unlock, UNSAFE) direction
    ///           (`registeredInRegistry == true`): the registry still knows
    ///           the wallet but the ledger has no record — the
    ///           `onWalletRegistered` hook was swallowed. The caller-supplied
    ///           member IDs are verified against the registry's stored
    ///           `membersIdsHash` (same check as `seize`) before being
    ///           resolved to staking providers and recorded live, restoring
    ///           the exit gate so a would-be premature exit is blocked.
    ///         - Over-locked (SAFE) direction
    ///           (`registeredInRegistry == false`): the registry no longer
    ///           knows the wallet (closed or terminated) but the ledger still
    ///           marks it live — the `onWalletClosed` hook was swallowed. The
    ///           closure is replayed from the ledger's own stored record; no
    ///           caller input is trusted and `walletMembersIDs` is ignored.
    ///
    ///         Idempotent: once the ledger matches the registry there is
    ///         nothing to repair and the call reverts `WalletExposureInSync`.
    ///         The ledger's own `WalletAlreadyRegistered` guard is a second
    ///         barrier against double-counting.
    /// @dev Unlike the two lifecycle hooks this is NOT wrapped in try/catch:
    ///      it is a standalone maintenance entrypoint off the Bridge
    ///      lifecycle, so a failed repair must surface (revert) and be
    ///      retried rather than be silently swallowed.
    /// @param wallets Registry wallet storage — read for the authoritative
    ///        `isWalletRegistered` verdict and the stored members hash.
    /// @param sortitionPool Sortition pool resolving member IDs to operator
    ///        addresses.
    /// @param operatorToStakingProvider Registry mapping from operator
    ///        address to staking provider address.
    /// @param walletID ID of the wallet to reconcile.
    /// @param walletMembersIDs Identifiers of the wallet signing group members
    ///        — required and hash-verified in the register direction, ignored
    ///        (may be empty) in the close direction.
    function reconcile(
        Data storage self,
        FrostRegistryWallets.Data storage wallets,
        SortitionPool sortitionPool,
        mapping(address => address) storage operatorToStakingProvider,
        IFrostAuthorizationSource authorizationSource,
        bytes32 walletID,
        uint32[] calldata walletMembersIDs
    ) external {
        IWalletExposureLedger walletExposureLedger = self.ledger;
        if (address(walletExposureLedger) == address(0)) {
            revert WalletExposureLedgerNotSet();
        }

        (, uint64[] memory epochs, , bool live) = walletExposureLedger
            .getWalletExposure(walletID);
        bool ledgerHasRecord = epochs.length != 0;

        // Authoritative registry verdict — reconcile only ever acts on state
        // the registry itself corroborates.
        if (FrostRegistryWallets.isWalletRegistered(wallets, walletID)) {
            // Under-counted direction: the registry knows the wallet but the
            // ledger does not. Rebuild exposure from verified, authoritative
            // state. `ledgerHasRecord` is the divergence gate — a wallet is
            // recorded in the ledger at most once, so a present record means
            // there is nothing to repair (and re-recording would revert
            // `WalletAlreadyRegistered` in the ledger anyway).
            if (ledgerHasRecord) {
                revert WalletExposureInSync();
            }
            require(
                FrostRegistryWallets.getWalletMembersIdsHash(
                    wallets,
                    walletID
                ) == keccak256(abi.encode(walletMembersIDs)),
                "Invalid wallet members identifiers"
            );

            (
                address[] memory uniqueProviders,
                uint32[] memory uniqueSeatCounts
            ) = _resolveUniqueProviders(
                    sortitionPool,
                    operatorToStakingProvider,
                    walletMembersIDs
                );

            walletExposureLedger.onWalletRegistered(
                walletID,
                uniqueProviders,
                uniqueSeatCounts
            );
            if (self.statefulAuthorizationSource) {
                // Reconciliation is an off-lifecycle maintenance path. Once
                // the stateful source is active, recording the missing wallet
                // without advancing its exit-gate floor would leave a
                // one-shot, unsafe partial repair. Require both writes to
                // succeed or revert them atomically.
                authorizationSource.onWalletExposureReconciled(uniqueProviders);
            } else if (address(authorizationSource).code.length != 0) {
                try
                    authorizationSource.onWalletExposureReconciled(
                        uniqueProviders
                    )
                {} catch {
                    emit AuthorizationSourceCallbackFailed(
                        IFrostAuthorizationSource
                            .onWalletExposureReconciled
                            .selector
                    );
                }
            } else {
                emit AuthorizationSourceCallbackFailed(
                    IFrostAuthorizationSource
                        .onWalletExposureReconciled
                        .selector
                );
            }

            emit WalletExposureReconciledRegistered(walletID);
        } else {
            // Over-locked direction: the registry dropped the wallet but the
            // ledger still marks it live. Replay the closure from the
            // ledger's own record; a non-live (or absent) record means there
            // is nothing to repair.
            if (!live) {
                revert WalletExposureInSync();
            }

            walletExposureLedger.onWalletClosed(walletID);

            emit WalletExposureReconciledClosed(walletID);
        }
    }

    /// @notice Verbatim relocation of the registry's `seize` body: verifies
    ///         the member IDs against the stored hash, resolves them to
    ///         staking providers (member ID → operator → staking provider),
    ///         and forwards the report to the authorization source's
    ///         misbehavior hook. Lives here so the resolution and encoding
    ///         code stays outside the `FrostWalletRegistry` bytecode — the
    ///         registry runs close to the contract size limit. Access
    ///         control (lifecycle owner) and the wallet lookup are enforced
    ///         by the calling registry function; requires and their order
    ///         are unchanged from the original registry body.
    /// @param sortitionPool Sortition pool resolving member IDs to operator
    ///        addresses.
    /// @param operatorToStakingProvider Registry mapping from operator
    ///        address to staking provider address.
    /// @param authorizationSource The registry's authorization source; the
    ///        original body resolved it through
    ///        `_currentAuthorizationSource()` after the resolution loop, so
    ///        the not-initialized check is repeated here at the same point.
    /// @param memberIdsHash Members IDs hash stored for the wallet.
    /// @param amount Compatibility amount forwarded to the authorization
    ///        source.
    /// @param rewardMultiplier Compatibility reward multiplier forwarded to
    ///        the authorization source.
    /// @param notifier Address of the misbehavior notifier.
    /// @param walletMembersIDs Identifiers of the wallet signing group
    ///        members.
    function seize(
        SortitionPool sortitionPool,
        mapping(address => address) storage operatorToStakingProvider,
        IFrostAuthorizationSource authorizationSource,
        bytes32 memberIdsHash,
        uint96 amount,
        uint256 rewardMultiplier,
        address notifier,
        uint32[] calldata walletMembersIDs
    ) external {
        require(
            memberIdsHash == keccak256(abi.encode(walletMembersIDs)),
            "Invalid wallet members identifiers"
        );

        address[] memory groupMembersAddresses = sortitionPool.getIDOperators(
            walletMembersIDs
        );
        address[] memory stakingProvidersAddresses = new address[](
            walletMembersIDs.length
        );
        for (uint256 i = 0; i < groupMembersAddresses.length; i++) {
            stakingProvidersAddresses[i] = operatorToStakingProvider[
                groupMembersAddresses[i]
            ];
        }

        require(
            address(authorizationSource) != address(0),
            "Authorization source is not initialized"
        );
        authorizationSource.reportMaliciousBehavior(
            amount,
            rewardMultiplier,
            notifier,
            stakingProvidersAddresses
        );
    }

    /// @notice Checks whether an operator occupies the requested position in
    ///         a registered wallet's authenticated member list.
    function isWalletMember(
        FrostRegistryWallets.Data storage wallets,
        SortitionPool sortitionPool,
        bytes32 walletID,
        uint32[] calldata walletMembersIDs,
        address operator,
        uint256 walletMemberIndex
    ) external view returns (bool) {
        uint32 operatorID = sortitionPool.getOperatorID(operator);
        require(operatorID != 0, "Not a sortition pool operator");

        require(
            FrostRegistryWallets.getWalletMembersIdsHash(wallets, walletID) ==
                keccak256(abi.encode(walletMembersIDs)),
            "Invalid wallet members identifiers"
        );
        require(
            1 <= walletMemberIndex &&
                walletMemberIndex <= walletMembersIDs.length,
            "Wallet member index is out of range"
        );

        return walletMembersIDs[walletMemberIndex - 1] == operatorID;
    }

    /// @notice Records that a wallet was closed and notifies the wallet
    ///         exposure ledger. The lifecycle counter advances even when the
    ///         ledger is not wired; only the ledger notification is skipped.
    /// @dev The ledger call is wrapped in try/catch: `closeWallet` is
    ///      driven by the Bridge lifecycle and MUST NOT revert because of
    ///      the ledger, so a failure only emits
    ///      `WalletExposureLedgerCallFailed`.
    /// @param walletID ID of the closed wallet.
    function notifyWalletClosed(Data storage self, bytes32 walletID) external {
        self.walletsClosedAfterUpgrade++;
        IWalletExposureLedger walletExposureLedger = self.ledger;
        if (address(walletExposureLedger) == address(0)) {
            return;
        }
        // See `notifyWalletRegistered` — a codeless ledger must not brick
        // wallet closure via the pre-call extcodesize check.
        if (address(walletExposureLedger).code.length == 0) {
            emit WalletExposureLedgerCallFailed(walletID);
            return;
        }

        try walletExposureLedger.onWalletClosed(walletID) {
            // solhint-disable-previous-line no-empty-blocks
        } catch {
            emit WalletExposureLedgerCallFailed(walletID);
        }
    }
}
