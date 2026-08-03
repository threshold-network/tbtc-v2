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

import "../GovernanceUtils.sol";
import "./api/ISlashingModule.sol";
import "./api/IStakeVault.sol";
import "./api/ISeatAllocator.sol";

/// @title SlashingModule
/// @notice Books slashes against staking providers' vault pools and manages
///         the delayed movement of seized T. The economic haircut is applied
///         atomically at report time via the vault's `applySlash` (self-bond
///         first, then delegated assets, capped at what is available); only
///         the movement of already-seized funds is subject to the movement
///         delay and the guardian pause. While a booked slash is pending for
///         a provider, the vault blocks exit finalization for that
///         provider's pool — closing the race where a delegator exits at
///         full share price between an offense and slash execution.
/// @dev `report` is called behind SeatAllocator's retry queue. Accounting is
///      default-off for Phase 1 record-only rollout; once activated, reward
///      checkpointing, the haircut, and reward-weight reduction are one atomic
///      transaction. Any downstream failure reverts to the allocator, which
///      durably queues the report and keeps provider exits blocked until retry.
///      There is no cancel function in v1: objective offenses carry no veto;
///      the guardian can only pause movement of already seized funds.
contract SlashingModule is ISlashingModule, Initializable, OwnableUpgradeable {
    struct PendingSlash {
        address stakingProvider;
        // Amount actually seized from the provider's pool at report time.
        uint96 seizedAmount;
        address notifier;
        // Notifier reward as a percentage of the seized amount, in [0, 100].
        uint96 rewardMultiplier;
        // Earliest timestamp at which the seized funds can be moved.
        uint64 executableAt;
        bool executed;
        // Reserved for a potential future cancellation path; never set in
        // v1 — objective offenses have no veto.
        bool cancelled;
        // Set once the movement delay has elapsed, decrementing the
        // provider's pending slash count exactly once. Decoupled from the
        // guardian movement pause so a paused T-movement leg never freezes
        // exit finalization: the haircut is already booked at report time
        // and the seized T is segregated, so the exit gate can clear on the
        // delay while the actual payout stays paused.
        bool matured;
    }

    /// @notice Upper bound on report entries processed in a single call.
    ///         FROST wallets contain exactly 100 signing seats. Inputs above
    ///         this protocol bound cannot originate from a valid registry
    ///         wallet and are truncated to keep report gas bounded.
    uint256 public constant MAX_REPORT_SEATS = 100;

    IStakeVault public stakeVault;
    address public seatAllocator;

    /// @notice Guardian able to pause the movement of seized funds. Cannot
    ///         affect slash accounting, which is booked at report time.
    address public guardian;

    /// @notice Recipient of the seized funds remaining after the notifier
    ///         reward and the executor cut.
    address public restitutionReserve;

    /// @notice True if the movement of seized funds (`executeSlash`) is
    ///         paused. Reporting and accounting are never paused.
    bool public movementPaused;

    /// @notice Governance delay for two-step parameter updates.
    uint256 public governanceDelay;

    /// @notice Delay between booking a slash and the earliest movement of
    ///         its seized funds.
    uint64 public movementDelay;
    uint64 public newMovementDelay;
    uint256 public movementDelayChangeInitiated;

    /// @notice Cut of the post-notifier-reward remainder paid to the caller
    ///         of `executeSlash`, in basis points.
    uint16 public executorRewardBps;
    uint16 public newExecutorRewardBps;
    uint256 public executorRewardBpsChangeInitiated;

    PendingSlash[] public pendingSlashes;

    /// @notice See `ISlashingModule.pendingSlashCount`.
    mapping(address => uint256) public override pendingSlashCount;

    /// @notice Default-off gate for economic haircut accounting. Governance
    ///         activates or deactivates it through the delayed two-step rail.
    bool public override economicSlashingEnabled;
    bool public newEconomicSlashingEnabled;
    uint256 public economicSlashingChangeInitiated;

    // Reserved storage space in case we need to add more variables.
    // See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
    // slither-disable-next-line unused-state
    uint256[45] private __gap;

    event SeatAllocatorSet(address seatAllocator);
    event GuardianUpdated(address guardian);
    event RestitutionReserveUpdated(address restitutionReserve);

    event MovementDelayUpdateStarted(
        uint64 newMovementDelay,
        uint256 timestamp
    );
    event MovementDelayUpdated(uint64 movementDelay);
    event ExecutorRewardBpsUpdateStarted(
        uint16 newExecutorRewardBps,
        uint256 timestamp
    );
    event ExecutorRewardBpsUpdated(uint16 executorRewardBps);

    event SlashReported(
        uint256 indexed slashId,
        address indexed stakingProvider,
        uint32 seatCount,
        uint96 requestedAmount,
        uint96 seizedAmount,
        address notifier,
        uint96 rewardMultiplier,
        uint64 executableAt
    );
    event SlashMatured(
        uint256 indexed slashId,
        address indexed stakingProvider
    );
    event SlashExecuted(
        uint256 indexed slashId,
        address indexed stakingProvider,
        address indexed executor,
        uint96 notifierReward,
        uint96 executorReward,
        uint96 restitutionAmount
    );
    event SlashMovementPaused(address guardian);
    event SlashMovementUnpaused(address guardian);
    event EconomicSlashingUpdateStarted(bool enabled, uint256 timestamp);
    event EconomicSlashingUpdated(bool enabled);
    event SlashReportRecorded(bytes32 indexed reportHash);

    error ZeroAddress();
    error AlreadySet();
    error CallerNotSeatAllocator();
    error CallerNotGuardian();
    error InvalidSlashId();
    error SlashAlreadyExecuted();
    error SlashAlreadyMatured();
    error SlashIsCancelled();
    error MovementDelayNotElapsed();
    error MovementIsPaused();
    error MovementNotPaused();
    error ExecutorRewardBpsTooHigh();
    error MovementDelayTooLong();
    error EconomicSlashingRequired();

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert CallerNotGuardian();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @dev Initializes the upgradeable contract on deployment. The seat
    ///      allocator is wired afterwards with the set-once setter (the
    ///      deployment ordering between the two is circular). The guardian
    ///      and the restitution reserve default to the owner.
    /// @param _stakeVault Address of the stake vault.
    /// @param _governanceDelay Delay for two-step governed parameter updates.
    function initialize(address _stakeVault, uint256 _governanceDelay)
        external
        initializer
    {
        if (_stakeVault == address(0)) revert ZeroAddress();

        stakeVault = IStakeVault(_stakeVault);
        governanceDelay = _governanceDelay;

        movementDelay = 24 hours;
        executorRewardBps = 100;
        guardian = msg.sender;
        restitutionReserve = msg.sender;

        __Ownable_init();
    }

    // ---------------------------------------------------------------------
    // Wiring & roles (owner)
    // ---------------------------------------------------------------------

    /// @notice Sets the seat allocator address. Can be set only once.
    function setSeatAllocator(address _seatAllocator) external onlyOwner {
        if (_seatAllocator == address(0)) revert ZeroAddress();
        if (seatAllocator != address(0)) revert AlreadySet();
        seatAllocator = _seatAllocator;
        emit SeatAllocatorSet(_seatAllocator);
    }

    /// @notice Updates the guardian able to pause seized-funds movement.
    function setGuardian(address _guardian) external onlyOwner {
        if (_guardian == address(0)) revert ZeroAddress();
        guardian = _guardian;
        emit GuardianUpdated(_guardian);
    }

    /// @notice Updates the restitution reserve address receiving the
    ///         remainder of seized funds.
    function setRestitutionReserve(address _restitutionReserve)
        external
        onlyOwner
    {
        if (_restitutionReserve == address(0)) revert ZeroAddress();
        restitutionReserve = _restitutionReserve;
        emit RestitutionReserveUpdated(_restitutionReserve);
    }

    /// @notice Begins a delayed update of economic slash accounting. While
    ///         disabled, reports remain observable but no T is seized.
    function beginEconomicSlashingUpdate(bool enabled) external onlyOwner {
        if (enabled && seatAllocator == address(0)) revert ZeroAddress();
        newEconomicSlashingEnabled = enabled;
        /* solhint-disable-next-line not-rely-on-time */
        economicSlashingChangeInitiated = block.timestamp;
        /* solhint-disable-next-line not-rely-on-time */
        emit EconomicSlashingUpdateStarted(enabled, block.timestamp);
    }

    /// @notice Finalizes a pending economic-slashing gate update.
    function finalizeEconomicSlashingUpdate() external onlyOwner {
        GovernanceUtils.onlyAfterGovernanceDelay(
            economicSlashingChangeInitiated,
            governanceDelay
        );
        if (newEconomicSlashingEnabled && seatAllocator == address(0)) {
            revert ZeroAddress();
        }
        economicSlashingEnabled = newEconomicSlashingEnabled;
        economicSlashingChangeInitiated = 0;
        emit EconomicSlashingUpdated(economicSlashingEnabled);
    }

    // ---------------------------------------------------------------------
    // Governed parameters (owner, two-step delayed)
    // ---------------------------------------------------------------------

    /// @notice Begins the movement delay update process.
    /// @param _newMovementDelay New movement delay in seconds; must not
    ///        exceed 30 days. The bound keeps `executableAt` arithmetic in
    ///        `_bookSlash` far away from uint64 overflow.
    function beginMovementDelayUpdate(uint64 _newMovementDelay)
        external
        onlyOwner
    {
        if (_newMovementDelay > 30 days) revert MovementDelayTooLong();
        /* solhint-disable-next-line not-rely-on-time */
        uint256 timestamp = block.timestamp;
        newMovementDelay = _newMovementDelay;
        movementDelayChangeInitiated = timestamp;
        emit MovementDelayUpdateStarted(_newMovementDelay, timestamp);
    }

    /// @notice Finalizes the movement delay update process.
    /// @dev Can be called only after the governance delay elapsed.
    function finalizeMovementDelayUpdate() external onlyOwner {
        GovernanceUtils.onlyAfterGovernanceDelay(
            movementDelayChangeInitiated,
            governanceDelay
        );
        movementDelay = newMovementDelay;
        emit MovementDelayUpdated(movementDelay);
        movementDelayChangeInitiated = 0;
        newMovementDelay = 0;
    }

    /// @notice Begins the executor reward update process.
    /// @param _newExecutorRewardBps New executor reward in basis points;
    ///        must not exceed 10000.
    function beginExecutorRewardBpsUpdate(uint16 _newExecutorRewardBps)
        external
        onlyOwner
    {
        if (_newExecutorRewardBps > 10000) revert ExecutorRewardBpsTooHigh();
        /* solhint-disable-next-line not-rely-on-time */
        uint256 timestamp = block.timestamp;
        newExecutorRewardBps = _newExecutorRewardBps;
        executorRewardBpsChangeInitiated = timestamp;
        emit ExecutorRewardBpsUpdateStarted(_newExecutorRewardBps, timestamp);
    }

    /// @notice Finalizes the executor reward update process.
    /// @dev Can be called only after the governance delay elapsed.
    function finalizeExecutorRewardBpsUpdate() external onlyOwner {
        GovernanceUtils.onlyAfterGovernanceDelay(
            executorRewardBpsChangeInitiated,
            governanceDelay
        );
        executorRewardBps = newExecutorRewardBps;
        emit ExecutorRewardBpsUpdated(executorRewardBps);
        executorRewardBpsChangeInitiated = 0;
        newExecutorRewardBps = 0;
    }

    // ---------------------------------------------------------------------
    // Slashing
    // ---------------------------------------------------------------------

    /// @notice See `ISlashingModule.report`. Books the haircut atomically at
    ///         report time — one vault `applySlash` per unique provider,
    ///         with duplicate entries aggregated per-seat — and enqueues a
    ///         pending slash per unique provider whose seized funds become
    ///         movable after the movement delay. When economic slashing is
    ///         disabled, a report that requires enforcement reverts and is
    ///         left queued by SeatAllocator. Otherwise empty input is a
    ///         no-op, oversized input is truncated to `MAX_REPORT_SEATS`,
    ///         zero-address entries are skipped, reward multipliers above 100
    ///         are clamped, and zero-stake providers book a zero seizure.
    function report(
        address[] calldata stakingProviders,
        uint96 perSeatAmount,
        uint256 rewardMultiplier,
        address notifier,
        bool requireEconomicSlashing
    ) external override {
        if (msg.sender != seatAllocator) revert CallerNotSeatAllocator();

        if (!economicSlashingEnabled) {
            if (requireEconomicSlashing) {
                revert EconomicSlashingRequired();
            }
            emit SlashReportRecorded(
                keccak256(
                    abi.encode(
                        stakingProviders,
                        perSeatAmount,
                        rewardMultiplier,
                        notifier
                    )
                )
            );
            return;
        }

        uint256 length = stakingProviders.length;
        if (length == 0) {
            return;
        }
        if (length > MAX_REPORT_SEATS) {
            length = MAX_REPORT_SEATS;
        }

        uint96 multiplier = rewardMultiplier > 100
            ? 100
            : uint96(rewardMultiplier);

        // Aggregate duplicate providers in memory; per-seat semantics mean
        // N occurrences of a provider translate to N x `perSeatAmount`.
        address[] memory uniqueProviders = new address[](length);
        uint32[] memory seatCounts = new uint32[](length);
        uint256 uniqueCount = 0;
        for (uint256 i = 0; i < length; i++) {
            address stakingProvider = stakingProviders[i];
            if (stakingProvider == address(0)) {
                continue;
            }
            bool found = false;
            for (uint256 j = 0; j < uniqueCount; j++) {
                if (uniqueProviders[j] == stakingProvider) {
                    seatCounts[j]++;
                    found = true;
                    break;
                }
            }
            if (!found) {
                uniqueProviders[uniqueCount] = stakingProvider;
                seatCounts[uniqueCount] = 1;
                uniqueCount++;
            }
        }

        for (uint256 j = 0; j < uniqueCount; j++) {
            _bookSlash(
                uniqueProviders[j],
                seatCounts[j],
                perSeatAmount,
                multiplier,
                notifier
            );
        }
    }

    /// @dev Books a single aggregated slash: applies the atomic haircut via
    ///      the vault (capped at available, non-reverting) and enqueues the
    ///      pending movement of the seized funds.
    function _bookSlash(
        address stakingProvider,
        uint32 seatCount,
        uint96 perSeatAmount,
        uint96 multiplier,
        address notifier
    ) internal {
        uint256 totalAmount = uint256(seatCount) * perSeatAmount;
        if (totalAmount > type(uint96).max) {
            totalAmount = type(uint96).max;
        }

        // Atomic haircut: seized at report time, capped at available.
        uint96 seized = stakeVault.applySlash(
            stakingProvider,
            uint96(totalAmount)
        );

        // The vault haircut changes reward capital. Reduce the distributor's
        // weight before the report can commit so no permissionless reward
        // tranche can accrue at the pre-slash weight.
        ISeatAllocator(seatAllocator).syncRewardWeightAfterSlash(
            stakingProvider
        );

        /* solhint-disable-next-line not-rely-on-time */
        uint64 executableAt = uint64(block.timestamp) + movementDelay;

        uint256 slashId = pendingSlashes.length;
        pendingSlashes.push(
            PendingSlash({
                stakingProvider: stakingProvider,
                seizedAmount: seized,
                notifier: notifier,
                rewardMultiplier: multiplier,
                executableAt: executableAt,
                executed: false,
                cancelled: false,
                matured: false
            })
        );
        pendingSlashCount[stakingProvider] += 1;

        emit SlashReported(
            slashId,
            stakingProvider,
            seatCount,
            uint96(totalAmount),
            seized,
            notifier,
            multiplier,
            executableAt
        );
    }

    /// @notice Marks a booked slash matured once its movement delay elapses,
    ///         decrementing the provider's pending slash count exactly once.
    ///         Permissionless and, crucially, NOT gated by the guardian
    ///         movement pause: the economic haircut was booked atomically at
    ///         report time and the seized T is already segregated in the
    ///         vault, so clearing the exit gate here can never let a delegator
    ///         escape the haircut. Decoupling maturation from the pause means
    ///         a guardian pause on the T-movement leg (`executeSlash`) no
    ///         longer freezes exit finalization indefinitely — the exit gate
    ///         clears within the movement delay while the actual seized-fund
    ///         movement stays paused.
    /// @param slashId Identifier of the pending slash (its index).
    function matureSlash(uint256 slashId) external {
        if (slashId >= pendingSlashes.length) revert InvalidSlashId();
        PendingSlash storage slash = pendingSlashes[slashId];
        // `executed` implies `matured`, so `matured` alone covers both.
        if (slash.matured) revert SlashAlreadyMatured();
        if (slash.cancelled) revert SlashIsCancelled();
        /* solhint-disable-next-line not-rely-on-time */
        if (block.timestamp < slash.executableAt) {
            revert MovementDelayNotElapsed();
        }

        slash.matured = true;
        pendingSlashCount[slash.stakingProvider] -= 1;

        emit SlashMatured(slashId, slash.stakingProvider);
    }

    /// @notice Moves the seized funds of a booked slash after the movement
    ///         delay: the notifier reward first (`rewardMultiplier` percent
    ///         of the seized amount), then the executor cut
    ///         (`executorRewardBps` of the remainder) to the caller, and the
    ///         rest to the restitution reserve. Permissionless. Matures the
    ///         slash inline if `matureSlash` was not called first, so the
    ///         happy path stays a single call; the pending slash count is
    ///         decremented at most once across the two entrypoints.
    /// @param slashId Identifier of the pending slash (its index).
    function executeSlash(uint256 slashId) external {
        if (slashId >= pendingSlashes.length) revert InvalidSlashId();
        PendingSlash storage slash = pendingSlashes[slashId];
        if (slash.executed) revert SlashAlreadyExecuted();
        if (slash.cancelled) revert SlashIsCancelled();
        /* solhint-disable-next-line not-rely-on-time */
        if (block.timestamp < slash.executableAt) {
            revert MovementDelayNotElapsed();
        }
        if (movementPaused) revert MovementIsPaused();

        slash.executed = true;
        // Decrement the exit gate only if maturation has not already done so
        // (a preceding `matureSlash` during a pause). This keeps the count
        // decremented exactly once per slash and avoids underflow.
        if (!slash.matured) {
            slash.matured = true;
            pendingSlashCount[slash.stakingProvider] -= 1;
        }

        uint96 seized = slash.seizedAmount;
        uint96 notifierReward = 0;
        if (slash.notifier != address(0)) {
            notifierReward = uint96(
                (uint256(seized) * slash.rewardMultiplier) / 100
            );
        }
        uint96 executorReward = uint96(
            (uint256(seized - notifierReward) * executorRewardBps) / 10000
        );
        uint96 restitutionAmount = seized - notifierReward - executorReward;

        emit SlashExecuted(
            slashId,
            slash.stakingProvider,
            msg.sender,
            notifierReward,
            executorReward,
            restitutionAmount
        );

        if (notifierReward > 0) {
            stakeVault.payoutSeized(slash.notifier, notifierReward);
        }
        if (executorReward > 0) {
            stakeVault.payoutSeized(msg.sender, executorReward);
        }
        if (restitutionAmount > 0) {
            stakeVault.payoutSeized(restitutionReserve, restitutionAmount);
        }
    }

    /// @notice Pauses the movement of seized funds. Affects ONLY
    ///         `executeSlash` — slash accounting is booked at report time
    ///         and cannot be paused or undone.
    function pauseMovement() external onlyGuardian {
        if (movementPaused) revert MovementIsPaused();
        movementPaused = true;
        emit SlashMovementPaused(msg.sender);
    }

    /// @notice Unpauses the movement of seized funds.
    function unpauseMovement() external onlyGuardian {
        if (!movementPaused) revert MovementNotPaused();
        movementPaused = false;
        emit SlashMovementUnpaused(msg.sender);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Returns the number of slashes ever booked.
    function pendingSlashesLength() external view returns (uint256) {
        return pendingSlashes.length;
    }
}
