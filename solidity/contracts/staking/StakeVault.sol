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

import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import "../GovernanceUtils.sol";
import "./api/IStakeVault.sol";
import "./api/ISignerRegistry.sol";
import "./api/ISeatAllocator.sol";
import "./api/ISlashingModule.sol";
import "./api/IWalletExposureLedger.sol";
import "./api/IRewardsDistributor.sol";

/// @title StakeVault
/// @notice Singleton vault custodying all staked T for the delegated staking
///         module. Each staking provider has a pool with two tranches:
///         the operator's own self-bond (first-loss) and delegated assets
///         tracked with non-transferable internal shares. The vault also
///         custodies TBTC rewards credited by the rewards distributor and
///         settles them MasterChef-style on every share mutation.
/// @dev Slashing notes:
///      - `applySlash` consumes self-bond first (down to zero, including any
///        queued-but-unfinalized self-bond withdrawal) and only then
///        haircuts `delegatedAssets`, dropping the share price pro-rata for
///        all delegators including pending exits. It caps at the available
///        balance. It checkpoints lazy rewards before mutating the pool, so
///        a downstream failure may revert the module call; SeatAllocator's
///        durable queue preserves the outer never-revert registry path and
///        holds exits until retry succeeds.
///      - Both exits (`finalizeUndelegate`, `finalizeSelfBondWithdrawal`) are
///        blocked by the fixed `undelegationDelay` cooldown and while the
///        slashing module holds a pending slash for the provider. They differ
///        on the wallet-lifecycle gate (`seatAllocator.canFinalizeUndelegate`,
///        which bundles BOTH the live-wallet-exposure check AND the
///        `decreasePending`/`exposureFloorEpoch` "phantom-weight" hold): the
///        operator self-bond withdrawal is additionally gated on it (operators
///        hold key shares and are the first-loss tranche, so their self-bond
///        stays lifecycle-coupled), whereas a delegator undelegation is NOT —
///        passive delegated capital is not coupled to the operator's wallet
///        lifecycle by design, so a delegator may finalize even while live
///        exposure persists AND while an authorization decrease is still
///        awaiting registry approval / the sortition pool reflects stale
///        weight. The self-bond first-loss tranche is the guaranteed
///        live-wallet collateral that intentionally absorbs this. See
///        `_checkExitGates`.
///      Share-price manipulation notes: shares are non-transferable and the
///      first deposit mints 1 share per asset wei. Donation-based share
///      price inflation is not possible because the pool tracks
///      `delegatedAssets` internally — direct T transfers to the vault do
///      not change the share price. Residual: T donated directly to the
///      vault address is unrecoverable.
contract StakeVault is IStakeVault, Initializable, OwnableUpgradeable {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    struct Pool {
        // Operator's own bonded T (first-loss tranche). Includes any amount
        // queued for withdrawal but not yet finalized.
        uint96 selfBond;
        // Self-bond queued for withdrawal, excluded from authorization
        // weight but still slashable. Invariant:
        // `pendingSelfBondWithdrawal <= selfBond`.
        uint96 pendingSelfBondWithdrawal;
        // Total delegated T assets, including assets backing pending
        // undelegation requests.
        uint96 delegatedAssets;
        // Total pool shares.
        uint256 totalShares;
        // Shares queued for undelegation; still included in `totalShares`
        // (still slashed, still earning) but excluded from authorization
        // weight via `pendingUndelegationAssetsOf`.
        uint256 pendingShares;
        // TBTC rewards per share, scaled by 1e18.
        uint256 rewardPerShareAccumulator;
        // Generation increments when slashing wipes all delegated assets or
        // leaves too little backing relative to the 1e18 reward-accumulator
        // scale. Outstanding shares from an older generation remain
        // redeemable only for rewards accrued before the wipe; they can never
        // capture a later deposit.
        uint64 generation;
    }

    struct UndelegationRequest {
        address delegator;
        address stakingProvider;
        uint256 shares;
        uint64 epochAtRequest;
        uint64 requestedAt;
        bool finalized;
    }

    struct SelfBondWithdrawalRequest {
        address stakingProvider;
        uint96 amount;
        uint64 epochAtRequest;
        uint64 requestedAt;
        bool finalized;
    }

    uint256 internal constant REWARD_PRECISION = 1e18;

    /// @notice Governance bounds for the disclosed fixed exit cooldown.
    uint64 public constant MIN_UNDELEGATION_DELAY = 14 days;
    uint64 public constant MAX_UNDELEGATION_DELAY = 60 days;

    IERC20Upgradeable public tToken;
    IERC20Upgradeable public tbtcToken;

    ISignerRegistry public signerRegistry;
    ISeatAllocator public seatAllocator;
    address public slashingModule;
    address public rewardsDistributor;
    IWalletExposureLedger public walletExposureLedger;

    /// @notice Governance delay for two-step parameter updates.
    uint256 public governanceDelay;

    /// @notice Delay between an exit request (undelegation or self-bond
    ///         withdrawal) and the earliest possible finalization. A floor —
    ///         the wallet-exposure gate can extend the wait arbitrarily.
    uint64 public undelegationDelay;
    uint64 public newUndelegationDelay;
    uint256 public undelegationDelayChangeInitiated;

    /// @notice Minimum self-bond an Active operator must keep unqueued.
    uint96 public minSelfBond;
    uint96 public newMinSelfBond;
    uint256 public minSelfBondChangeInitiated;

    mapping(address => Pool) internal pools;

    // Pool shares per provider per delegator. Non-transferable.
    mapping(address => mapping(address => uint256)) internal poolShares;
    // Shares a delegator has queued for undelegation (subset of their
    // `poolShares` balance), preventing double-queueing.
    mapping(address => mapping(address => uint256))
        internal delegatorQueuedShares;
    // MasterChef-style reward debt, 1e18-scaled against the accumulator.
    mapping(address => mapping(address => uint256)) internal rewardDebt;
    // Settled, claimable TBTC rewards.
    mapping(address => mapping(address => uint256)) internal claimableRewards;
    UndelegationRequest[] public undelegationRequests;
    SelfBondWithdrawalRequest[] public selfBondWithdrawalRequests;

    /// @notice T seized by slashes, held by the vault earmarked to the
    ///         slashing module until paid out via `payoutSeized`.
    uint256 public seizedBalance;

    /// @notice Delegation rollout gate. Default-off and reversible through the
    ///         same two-step governance delay as the other vault parameters.
    bool public delegationEnabled;
    bool public newDelegationEnabled;
    uint256 public delegationChangeInitiated;

    mapping(address => mapping(address => uint64)) internal shareGeneration;
    mapping(address => mapping(uint64 => uint256))
        internal generationFinalRewardAccumulator;
    mapping(uint256 => uint64) internal undelegationRequestGeneration;

    /// @notice Cooldown snapshotted when each request is filed so later
    ///         governance updates apply prospectively only.
    mapping(uint256 => uint64) public undelegationRequestDelay;
    mapping(uint256 => uint64) public selfBondWithdrawalRequestDelay;

    // Reserved storage space in case we need to add more variables.
    // See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
    // slither-disable-next-line unused-state
    uint256[40] private __gap;

    event SignerRegistrySet(address signerRegistry);
    event SeatAllocatorSet(address seatAllocator);
    event SlashingModuleSet(address slashingModule);
    event RewardsDistributorSet(address rewardsDistributor);
    event WalletExposureLedgerSet(address walletExposureLedger);

    event UndelegationDelayUpdateStarted(
        uint64 newUndelegationDelay,
        uint256 timestamp
    );
    event UndelegationDelayUpdated(uint64 undelegationDelay);
    event MinSelfBondUpdateStarted(uint96 newMinSelfBond, uint256 timestamp);
    event MinSelfBondUpdated(uint96 minSelfBond);
    event DelegationUpdateStarted(bool enabled, uint256 timestamp);
    event DelegationUpdated(bool enabled);
    event PoolWiped(address indexed stakingProvider, uint64 newGeneration);

    event SelfBondDeposited(address indexed stakingProvider, uint96 amount);
    event Delegated(
        address indexed stakingProvider,
        address indexed delegator,
        uint96 amount,
        uint256 shares
    );
    event UndelegationRequested(
        uint256 indexed requestId,
        address indexed stakingProvider,
        address indexed delegator,
        uint256 shares,
        uint64 epochAtRequest
    );
    event UndelegationFinalized(
        uint256 indexed requestId,
        address indexed stakingProvider,
        address indexed delegator,
        uint256 shares,
        uint96 assets
    );
    event SelfBondWithdrawalRequested(
        uint256 indexed requestId,
        address indexed stakingProvider,
        uint96 amount,
        uint64 epochAtRequest
    );
    event SelfBondWithdrawalFinalized(
        uint256 indexed requestId,
        address indexed stakingProvider,
        uint96 amount
    );
    event SlashApplied(
        address indexed stakingProvider,
        uint96 requestedAmount,
        uint96 fromSelfBond,
        uint96 fromDelegated
    );
    event SeizedFundsPaidOut(address indexed to, uint96 amount);
    event RewardCredited(address indexed stakingProvider, uint256 tbtcAmount);
    event RewardRoutedToBeneficiary(
        address indexed stakingProvider,
        address indexed beneficiary,
        uint256 tbtcAmount
    );
    event RewardsClaimed(
        address indexed stakingProvider,
        address indexed delegator,
        uint256 tbtcAmount
    );

    error ZeroAddress();
    error AlreadySet();
    error AmountCannotBeZero();
    error ProviderNotActive();
    error DelegationDisabled();
    error InsufficientShares();
    error InsufficientSelfBond();
    error SelfBondBelowMinimum();
    error InvalidRequestId();
    error RequestAlreadyFinalized();
    error CallerNotRequestOwner();
    error UndelegationDelayNotElapsed();
    error PendingSlashExists();
    error LiveWalletExposure();
    error CallerNotSlashingModule();
    error CallerNotRewardsDistributor();
    error InsufficientSeizedBalance();
    error NothingToClaim();
    error UndelegationDelayTooShort();
    error UndelegationDelayTooLong();

    modifier onlySlashingModule() {
        if (msg.sender != slashingModule) revert CallerNotSlashingModule();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @dev Initializes the upgradeable contract on deployment. Module
    ///      addresses are wired afterwards with the set-once setters —
    ///      deployment ordering between the staking module contracts is
    ///      circular so they cannot all be initializer arguments.
    /// @param _tToken Address of the staked T token.
    /// @param _tbtcToken Address of the TBTC token (rewards denomination).
    /// @param _governanceDelay Delay for two-step governed parameter updates.
    function initialize(
        address _tToken,
        address _tbtcToken,
        uint256 _governanceDelay
    ) external initializer {
        if (_tToken == address(0) || _tbtcToken == address(0)) {
            revert ZeroAddress();
        }

        tToken = IERC20Upgradeable(_tToken);
        tbtcToken = IERC20Upgradeable(_tbtcToken);
        governanceDelay = _governanceDelay;

        undelegationDelay = 45 days;
        minSelfBond = 40_000e18;

        __Ownable_init();
    }

    // ---------------------------------------------------------------------
    // Wiring (owner, set-once)
    // ---------------------------------------------------------------------

    /// @notice Sets the signer registry address. Can be set only once.
    function setSignerRegistry(address _signerRegistry) external onlyOwner {
        if (_signerRegistry == address(0)) revert ZeroAddress();
        if (address(signerRegistry) != address(0)) revert AlreadySet();
        signerRegistry = ISignerRegistry(_signerRegistry);
        emit SignerRegistrySet(_signerRegistry);
    }

    /// @notice Sets the seat allocator address. Can be set only once.
    function setSeatAllocator(address _seatAllocator) external onlyOwner {
        if (_seatAllocator == address(0)) revert ZeroAddress();
        if (address(seatAllocator) != address(0)) revert AlreadySet();
        seatAllocator = ISeatAllocator(_seatAllocator);
        emit SeatAllocatorSet(_seatAllocator);
    }

    /// @notice Sets the slashing module address. Can be set only once.
    function setSlashingModule(address _slashingModule) external onlyOwner {
        if (_slashingModule == address(0)) revert ZeroAddress();
        if (slashingModule != address(0)) revert AlreadySet();
        slashingModule = _slashingModule;
        emit SlashingModuleSet(_slashingModule);
    }

    /// @notice Sets the rewards distributor address. Can be set only once.
    function setRewardsDistributor(address _rewardsDistributor)
        external
        onlyOwner
    {
        if (_rewardsDistributor == address(0)) revert ZeroAddress();
        if (rewardsDistributor != address(0)) revert AlreadySet();
        rewardsDistributor = _rewardsDistributor;
        emit RewardsDistributorSet(_rewardsDistributor);
    }

    /// @notice Sets the wallet exposure ledger address. Can be set only once.
    function setWalletExposureLedger(address _walletExposureLedger)
        external
        onlyOwner
    {
        if (_walletExposureLedger == address(0)) revert ZeroAddress();
        if (address(walletExposureLedger) != address(0)) revert AlreadySet();
        walletExposureLedger = IWalletExposureLedger(_walletExposureLedger);
        emit WalletExposureLedgerSet(_walletExposureLedger);
    }

    // ---------------------------------------------------------------------
    // Governed parameters (owner, two-step delayed)
    // ---------------------------------------------------------------------

    /// @notice Begins the undelegation delay update process.
    /// @param _newUndelegationDelay New undelegation delay in seconds.
    function beginUndelegationDelayUpdate(uint64 _newUndelegationDelay)
        external
        onlyOwner
    {
        _validateUndelegationDelay(_newUndelegationDelay);
        /* solhint-disable-next-line not-rely-on-time */
        uint256 timestamp = block.timestamp;
        newUndelegationDelay = _newUndelegationDelay;
        undelegationDelayChangeInitiated = timestamp;
        emit UndelegationDelayUpdateStarted(_newUndelegationDelay, timestamp);
    }

    /// @notice Finalizes the undelegation delay update process.
    /// @dev Can be called only after the governance delay elapsed.
    function finalizeUndelegationDelayUpdate() external onlyOwner {
        GovernanceUtils.onlyAfterGovernanceDelay(
            undelegationDelayChangeInitiated,
            governanceDelay
        );
        _validateUndelegationDelay(newUndelegationDelay);
        undelegationDelay = newUndelegationDelay;
        emit UndelegationDelayUpdated(undelegationDelay);
        undelegationDelayChangeInitiated = 0;
        newUndelegationDelay = 0;
    }

    /// @notice Begins the minimum self-bond update process.
    /// @param _newMinSelfBond New minimum self-bond amount.
    function beginMinSelfBondUpdate(uint96 _newMinSelfBond) external onlyOwner {
        /* solhint-disable-next-line not-rely-on-time */
        uint256 timestamp = block.timestamp;
        newMinSelfBond = _newMinSelfBond;
        minSelfBondChangeInitiated = timestamp;
        emit MinSelfBondUpdateStarted(_newMinSelfBond, timestamp);
    }

    /// @notice Finalizes the minimum self-bond update process and atomically
    ///         synchronizes every current sortition-pool provider against the
    ///         new eligibility floor.
    /// @param stakingProviders Complete current sortition-pool roster. The
    ///        wallet registry validates completeness and uniqueness.
    /// @dev Can be called only after the governance delay elapsed. Any
    ///      authorization, reward-weight, roster, or pool-leaf sync failure
    ///      reverts the global floor update too.
    function finalizeMinSelfBondUpdate(address[] calldata stakingProviders)
        external
        onlyOwner
    {
        GovernanceUtils.onlyAfterGovernanceDelay(
            minSelfBondChangeInitiated,
            governanceDelay
        );
        minSelfBond = newMinSelfBond;
        seatAllocator.synchronizeAuthorizationRoster(stakingProviders);
        emit MinSelfBondUpdated(minSelfBond);
        minSelfBondChangeInitiated = 0;
        newMinSelfBond = 0;
    }

    /// @notice Begins a delayed delegation-gate update. Governance may disable
    ///         new deposits without affecting exits or existing positions.
    function beginDelegationUpdate(bool enabled) external onlyOwner {
        newDelegationEnabled = enabled;
        /* solhint-disable-next-line not-rely-on-time */
        delegationChangeInitiated = block.timestamp;
        /* solhint-disable-next-line not-rely-on-time */
        emit DelegationUpdateStarted(enabled, block.timestamp);
    }

    /// @notice Finalizes a pending delegation-gate update.
    function finalizeDelegationUpdate() external onlyOwner {
        GovernanceUtils.onlyAfterGovernanceDelay(
            delegationChangeInitiated,
            governanceDelay
        );
        delegationEnabled = newDelegationEnabled;
        delegationChangeInitiated = 0;
        emit DelegationUpdated(delegationEnabled);
    }

    // ---------------------------------------------------------------------
    // Self-bond
    // ---------------------------------------------------------------------

    /// @notice Deposits T as the caller's operator self-bond. The caller is
    ///         the staking provider and must be Active in the signer
    ///         registry.
    /// @param amount Amount of T to bond.
    function depositSelfBond(uint96 amount) external {
        if (amount == 0) revert AmountCannotBeZero();
        if (!signerRegistry.isActive(msg.sender)) revert ProviderNotActive();

        // Attribute rewards earned by the existing self-bond/delegation mix
        // before changing that mix.
        IRewardsDistributor(rewardsDistributor).settleOperator(msg.sender);
        pools[msg.sender].selfBond += amount;

        emit SelfBondDeposited(msg.sender, amount);
        tToken.safeTransferFrom(msg.sender, address(this), amount);
        _refresh(msg.sender);
    }

    /// @notice Queues a withdrawal of the caller's self-bond. The amount is
    ///         excluded from authorization weight immediately but remains
    ///         slashable (first-loss) until finalized. An Active operator
    ///         must keep at least the minimum self-bond unqueued;
    ///         Deactivating or Ejected operators may exit fully.
    /// @param amount Amount of self-bond to queue for withdrawal.
    /// @return requestId Identifier to pass to `finalizeSelfBondWithdrawal`.
    function requestSelfBondWithdrawal(uint96 amount)
        external
        returns (uint256 requestId)
    {
        if (amount == 0) revert AmountCannotBeZero();
        Pool storage pool = pools[msg.sender];

        uint96 available = pool.selfBond - pool.pendingSelfBondWithdrawal;
        if (amount > available) revert InsufficientSelfBond();

        if (
            signerRegistry.operatorStatus(msg.sender) == OperatorStatus.Active
        ) {
            if (available - amount < minSelfBond) {
                revert SelfBondBelowMinimum();
            }
        }

        pool.pendingSelfBondWithdrawal += amount;

        uint64 epochAtRequest = walletExposureLedger.currentEpoch(msg.sender);
        /* solhint-disable-next-line not-rely-on-time */
        uint64 requestedAt = uint64(block.timestamp);
        requestId = selfBondWithdrawalRequests.length;
        selfBondWithdrawalRequests.push(
            SelfBondWithdrawalRequest({
                stakingProvider: msg.sender,
                amount: amount,
                epochAtRequest: epochAtRequest,
                requestedAt: requestedAt,
                finalized: false
            })
        );
        selfBondWithdrawalRequestDelay[requestId] = undelegationDelay;

        emit SelfBondWithdrawalRequested(
            requestId,
            msg.sender,
            amount,
            epochAtRequest
        );
        _refresh(msg.sender);
    }

    /// @notice Finalizes a queued self-bond withdrawal (OPERATOR path).
    ///         Pays out at most what is left after slashes that hit the queued
    ///         self-bond during the wait.
    /// @dev Unlike the delegator path, self-bond withdrawal STAYS
    ///      lifecycle-gated (`enforceLifecycleGate = true`): the fixed
    ///      `undelegationDelay` cooldown must have elapsed, no slash may be
    ///      pending, AND there must be no live wallet exposure at or before the
    ///      epoch recorded at request time. Operators hold the wallets' FROST
    ///      key shares and are the first-loss tranche, so their self-bond is
    ///      the guaranteed live-wallet slashing collateral and must remain
    ///      locked until every wallet it backed at request time has retired.
    /// @param requestId Identifier returned by `requestSelfBondWithdrawal`.
    function finalizeSelfBondWithdrawal(uint256 requestId) external {
        if (requestId >= selfBondWithdrawalRequests.length) {
            revert InvalidRequestId();
        }
        SelfBondWithdrawalRequest storage request = selfBondWithdrawalRequests[
            requestId
        ];
        if (request.finalized) revert RequestAlreadyFinalized();
        if (request.stakingProvider != msg.sender) {
            revert CallerNotRequestOwner();
        }
        _checkExitGates(
            msg.sender,
            request.requestedAt,
            selfBondWithdrawalRequestDelay[requestId],
            request.epochAtRequest,
            true
        );

        // Attribute rewards earned by the existing self-bond/delegation mix
        // before reducing the operator tranche.
        IRewardsDistributor(rewardsDistributor).settleOperator(msg.sender);
        Pool storage pool = pools[msg.sender];

        // Slashes during the wait consume queued self-bond too; cap the
        // payout at what remains queued.
        uint96 amount = request.amount;
        if (amount > pool.pendingSelfBondWithdrawal) {
            amount = pool.pendingSelfBondWithdrawal;
        }

        request.finalized = true;
        pool.pendingSelfBondWithdrawal -= amount;
        pool.selfBond -= amount;

        emit SelfBondWithdrawalFinalized(requestId, msg.sender, amount);
        if (amount > 0) {
            tToken.safeTransfer(msg.sender, amount);
        }
        _refresh(msg.sender);
    }

    // ---------------------------------------------------------------------
    // Delegation
    // ---------------------------------------------------------------------

    /// @notice Delegates T to the given staking provider's pool, minting
    ///         non-transferable shares at the current share price. The
    ///         provider must be Active in the signer registry.
    /// @param stakingProvider Address of the staking provider.
    /// @param amount Amount of T to delegate.
    function delegate(address stakingProvider, uint96 amount) external {
        if (amount == 0) revert AmountCannotBeZero();
        if (!delegationEnabled) revert DelegationDisabled();
        if (!signerRegistry.isActive(stakingProvider)) {
            revert ProviderNotActive();
        }

        IRewardsDistributor(rewardsDistributor).settleOperator(stakingProvider);
        _settleRewards(stakingProvider, msg.sender);

        Pool storage pool = pools[stakingProvider];

        if (_requiresGenerationReset(pool, amount)) {
            // `_settleRewards` deliberately leaves reward debt untouched.
            // Anchor it before finalizing the old generation so the second
            // settlement only clears stale shares instead of crediting the
            // same accrual twice.
            _updateRewardDebt(stakingProvider, msg.sender);
            _resetWipedPool(stakingProvider, pool);
            _settleRewards(stakingProvider, msg.sender);
        }

        uint256 mintedShares;
        if (pool.totalShares == 0) {
            // First deposit: 1 share per asset wei.
            mintedShares = amount;
        } else {
            mintedShares =
                (uint256(amount) * pool.totalShares) /
                pool.delegatedAssets;
        }

        pool.delegatedAssets += amount;
        pool.totalShares += mintedShares;
        poolShares[stakingProvider][msg.sender] += mintedShares;

        _updateRewardDebt(stakingProvider, msg.sender);

        emit Delegated(stakingProvider, msg.sender, amount, mintedShares);
        tToken.safeTransferFrom(msg.sender, address(this), amount);
        _refresh(stakingProvider);
    }

    /// @notice Queues an undelegation of the given number of shares. The
    ///         shares stay in the pool — still slashable and still earning —
    ///         but the backing assets are excluded from authorization weight
    ///         immediately.
    /// @param stakingProvider Address of the staking provider.
    /// @param shares_ Number of shares to queue for undelegation.
    /// @return requestId Identifier to pass to `finalizeUndelegate`.
    function requestUndelegate(address stakingProvider, uint256 shares_)
        external
        returns (uint256 requestId)
    {
        if (shares_ == 0) revert AmountCannotBeZero();

        _settleRewards(stakingProvider, msg.sender);

        uint256 freeShares = poolShares[stakingProvider][msg.sender] -
            delegatorQueuedShares[stakingProvider][msg.sender];
        if (shares_ > freeShares) revert InsufficientShares();

        // Shares stay in the pool so the share balance does not change, but
        // settle anyway to keep reward accounting anchored at every queue
        // mutation.
        _updateRewardDebt(stakingProvider, msg.sender);

        delegatorQueuedShares[stakingProvider][msg.sender] += shares_;
        pools[stakingProvider].pendingShares += shares_;

        uint64 epochAtRequest = walletExposureLedger.currentEpoch(
            stakingProvider
        );
        /* solhint-disable-next-line not-rely-on-time */
        uint64 requestedAt = uint64(block.timestamp);
        requestId = undelegationRequests.length;
        undelegationRequests.push(
            UndelegationRequest({
                delegator: msg.sender,
                stakingProvider: stakingProvider,
                shares: shares_,
                epochAtRequest: epochAtRequest,
                requestedAt: requestedAt,
                finalized: false
            })
        );
        undelegationRequestGeneration[requestId] = pools[stakingProvider]
            .generation;
        undelegationRequestDelay[requestId] = undelegationDelay;

        emit UndelegationRequested(
            requestId,
            stakingProvider,
            msg.sender,
            shares_,
            epochAtRequest
        );
        _refresh(stakingProvider);
    }

    /// @notice Finalizes a queued undelegation (DELEGATOR path), burning the
    ///         shares at the CURRENT share price — any slash during the wait
    ///         was borne pro-rata — and returning the backing T.
    /// @dev Delegated capital is NOT lifecycle-coupled: this exit requires
    ///      only that the fixed `undelegationDelay` cooldown has elapsed and
    ///      that no slash is pending for the provider. It deliberately does
    ///      NOT enforce the wallet-lifecycle gate (`enforceLifecycleGate =
    ///      false`), i.e. it skips `seatAllocator.canFinalizeUndelegate`
    ///      entirely. That call bundles TWO holds and BOTH are dropped for
    ///      delegators — not only the pure wallet-lifecycle exposure check:
    ///        1. the live-wallet exposure / `exposureFloorEpoch` check — so a
    ///           delegator finalizes even while the operator holds live wallet
    ///           exposure at or before the request epoch; and
    ///        2. the `decreasePending` "phantom-weight" hold — so a delegator
    ///           finalizes even while an authorization decrease is still
    ///           awaiting registry approval and the sortition pool may still
    ///           reflect the pre-decrease (stale) weight, i.e. a wallet could
    ///           still be selecting this provider on a stale leaf.
    ///      Both are intentional and consistent with the fixed-cooldown design.
    ///      Rationale (design §13): stake is far below custody value and the
    ///      operator's self-bond first-loss tranche — which DOES stay
    ///      lifecycle-coupled (see `finalizeSelfBondWithdrawal`) and is the
    ///      guaranteed live-wallet collateral — over-covers realistic slashes
    ///      and absorbs this residual, so coupling passive delegated capital to
    ///      the operator's up-to-8-month wallet lifecycle would be a
    ///      viability-killing lock for a symbolic coverage guarantee. The
    ///      pending-slash block still holds, so the delegator-escape race
    ///      (finalizing at the pre-haircut price while a fraud is being
    ///      executed) stays closed via the atomic-at-report haircut.
    /// @param requestId Identifier returned by `requestUndelegate`.
    function finalizeUndelegate(uint256 requestId) external {
        if (requestId >= undelegationRequests.length) {
            revert InvalidRequestId();
        }
        UndelegationRequest storage request = undelegationRequests[requestId];
        if (request.finalized) revert RequestAlreadyFinalized();
        if (request.delegator != msg.sender) revert CallerNotRequestOwner();

        address stakingProvider = request.stakingProvider;
        // `request.epochAtRequest` is still recorded (for the request event /
        // telemetry) but is no longer gated on for delegators: the lifecycle
        // gate is disabled on this path.
        _checkExitGates(
            stakingProvider,
            request.requestedAt,
            undelegationRequestDelay[requestId],
            request.epochAtRequest,
            false
        );

        IRewardsDistributor(rewardsDistributor).settleOperator(stakingProvider);
        _settleRewards(stakingProvider, msg.sender);

        Pool storage pool = pools[stakingProvider];
        if (undelegationRequestGeneration[requestId] != pool.generation) {
            request.finalized = true;
            emit UndelegationFinalized(
                requestId,
                stakingProvider,
                msg.sender,
                request.shares,
                0
            );
            return;
        }
        uint256 assets = (request.shares * pool.delegatedAssets) /
            pool.totalShares;

        request.finalized = true;
        pool.totalShares -= request.shares;
        pool.pendingShares -= request.shares;
        pool.delegatedAssets -= uint96(assets);
        poolShares[stakingProvider][msg.sender] -= request.shares;
        delegatorQueuedShares[stakingProvider][msg.sender] -= request.shares;

        _updateRewardDebt(stakingProvider, msg.sender);

        emit UndelegationFinalized(
            requestId,
            stakingProvider,
            msg.sender,
            request.shares,
            uint96(assets)
        );
        if (assets > 0) {
            tToken.safeTransfer(msg.sender, assets);
        }
        _refresh(stakingProvider);
    }

    // ---------------------------------------------------------------------
    // Slashing (slashing module only)
    // ---------------------------------------------------------------------

    /// @notice See `IStakeVault.applySlash`. First-loss order: self-bond is
    ///         consumed to zero (including queued-but-unfinalized self-bond
    ///         withdrawals) before delegated assets are haircut. Caps at the
    ///         available balance and never reverts for `amount` greater than
    ///         what is available. Before changing tranche composition it
    ///         settles the distributor's lazy accrual at the pre-slash mix;
    ///         any settlement failure reverts the module call so the allocator
    ///         can queue the report and hold exits. It does NOT refresh registry
    ///         authorization; the allocator marks that weight dirty separately.
    function applySlash(address stakingProvider, uint96 amount)
        external
        override
        onlySlashingModule
        returns (uint96 seized)
    {
        if (rewardsDistributor == address(0)) revert ZeroAddress();

        // Attribute every already-notified reward tranche using the pool's
        // pre-slash self-bond/delegation composition. The distributor calls
        // back into creditReward before this function mutates either tranche.
        IRewardsDistributor(rewardsDistributor).settleOperator(stakingProvider);

        Pool storage pool = pools[stakingProvider];

        uint96 fromSelfBond = amount <= pool.selfBond ? amount : pool.selfBond;
        if (fromSelfBond > 0) {
            pool.selfBond -= fromSelfBond;
            if (pool.pendingSelfBondWithdrawal > pool.selfBond) {
                pool.pendingSelfBondWithdrawal = pool.selfBond;
            }
        }

        uint96 remaining = amount - fromSelfBond;
        uint96 fromDelegated = remaining <= pool.delegatedAssets
            ? remaining
            : pool.delegatedAssets;
        if (fromDelegated > 0) {
            pool.delegatedAssets -= fromDelegated;
            if (_requiresGenerationReset(pool, 0)) {
                _resetWipedPool(stakingProvider, pool);
            }
        }

        seized = fromSelfBond + fromDelegated;
        seizedBalance += seized;

        emit SlashApplied(stakingProvider, amount, fromSelfBond, fromDelegated);
    }

    /// @notice See `IStakeVault.payoutSeized`.
    function payoutSeized(address to, uint96 amount)
        external
        override
        onlySlashingModule
    {
        if (amount > seizedBalance) revert InsufficientSeizedBalance();
        seizedBalance -= amount;
        emit SeizedFundsPaidOut(to, amount);
        tToken.safeTransfer(to, amount);
    }

    // ---------------------------------------------------------------------
    // Rewards
    // ---------------------------------------------------------------------

    /// @notice See `IStakeVault.creditReward`. The TBTC must already have
    ///         been transferred to the vault. The post-commission amount is
    ///         split between the self-bond and delegated tranches pro rata to
    ///         their T capital; the self-bond share is routed to the provider
    ///         beneficiary and only the delegated share enters the per-share
    ///         accumulator.
    function creditReward(address stakingProvider, uint256 tbtcAmount)
        external
        override
    {
        if (msg.sender != rewardsDistributor) {
            revert CallerNotRewardsDistributor();
        }
        if (tbtcAmount == 0) return;

        Pool storage pool = pools[stakingProvider];
        uint256 totalCapital = uint256(pool.selfBond) + pool.delegatedAssets;
        uint256 selfBondReward = totalCapital == 0
            ? tbtcAmount
            : (tbtcAmount * pool.selfBond) / totalCapital;
        uint256 delegatedReward = tbtcAmount - selfBondReward;

        if (selfBondReward > 0 || pool.totalShares == 0) {
            address beneficiary = signerRegistry.beneficiaryOf(stakingProvider);
            if (beneficiary == address(0)) {
                beneficiary = stakingProvider;
            }
            uint256 beneficiaryReward = selfBondReward;
            if (pool.totalShares == 0) {
                beneficiaryReward += delegatedReward;
                delegatedReward = 0;
            }
            claimableRewards[stakingProvider][beneficiary] += beneficiaryReward;
            emit RewardRoutedToBeneficiary(
                stakingProvider,
                beneficiary,
                beneficiaryReward
            );
        }
        if (delegatedReward > 0) {
            pool.rewardPerShareAccumulator +=
                (delegatedReward * REWARD_PRECISION) /
                pool.totalShares;
        }

        emit RewardCredited(stakingProvider, tbtcAmount);
    }

    /// @notice Settles and transfers the caller's accrued TBTC rewards from
    ///         the given staking provider's pool.
    /// @param stakingProvider Address of the staking provider.
    function claimRewards(address stakingProvider) external {
        IRewardsDistributor(rewardsDistributor).settleOperator(stakingProvider);
        _settleRewards(stakingProvider, msg.sender);
        _updateRewardDebt(stakingProvider, msg.sender);

        uint256 amount = claimableRewards[stakingProvider][msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimableRewards[stakingProvider][msg.sender] = 0;

        emit RewardsClaimed(stakingProvider, msg.sender, amount);
        tbtcToken.safeTransfer(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice See `IStakeVault.selfBondOf`.
    function selfBondOf(address stakingProvider)
        external
        view
        override
        returns (uint96)
    {
        return pools[stakingProvider].selfBond;
    }

    /// @notice Returns the self-bond amount queued for withdrawal for the
    ///         given staking provider; excluded from authorization weight
    ///         but still slashable.
    function pendingSelfBondWithdrawalOf(address stakingProvider)
        external
        view
        returns (uint96)
    {
        return pools[stakingProvider].pendingSelfBondWithdrawal;
    }

    /// @notice See `IStakeVault.delegatedAssetsOf`.
    function delegatedAssetsOf(address stakingProvider)
        external
        view
        override
        returns (uint96)
    {
        return pools[stakingProvider].delegatedAssets;
    }

    /// @notice See `IStakeVault.pendingUndelegationAssetsOf`. Valued at the
    ///         current share price.
    function pendingUndelegationAssetsOf(address stakingProvider)
        external
        view
        override
        returns (uint96)
    {
        Pool storage pool = pools[stakingProvider];
        if (pool.totalShares == 0) {
            return 0;
        }
        return
            uint96(
                (pool.pendingShares * pool.delegatedAssets) / pool.totalShares
            );
    }

    /// @notice See `IStakeVault.sharesOf`.
    function sharesOf(address stakingProvider, address delegator)
        external
        view
        override
        returns (uint256)
    {
        return
            shareGeneration[stakingProvider][delegator] ==
                pools[stakingProvider].generation
                ? poolShares[stakingProvider][delegator]
                : 0;
    }

    /// @notice Returns the total shares of the given provider's pool.
    function totalSharesOf(address stakingProvider)
        external
        view
        returns (uint256)
    {
        return pools[stakingProvider].totalShares;
    }

    /// @notice Returns the shares of the given provider's pool queued for
    ///         undelegation.
    function pendingSharesOf(address stakingProvider)
        external
        view
        returns (uint256)
    {
        return pools[stakingProvider].pendingShares;
    }

    /// @notice Returns the shares the given delegator has queued for
    ///         undelegation in the given provider's pool.
    function queuedSharesOf(address stakingProvider, address delegator)
        external
        view
        returns (uint256)
    {
        return
            shareGeneration[stakingProvider][delegator] ==
                pools[stakingProvider].generation
                ? delegatorQueuedShares[stakingProvider][delegator]
                : 0;
    }

    /// @notice Returns the provider pool's TBTC reward-per-share
    ///         accumulator, scaled by 1e18.
    function rewardPerShareAccumulatorOf(address stakingProvider)
        external
        view
        returns (uint256)
    {
        return pools[stakingProvider].rewardPerShareAccumulator;
    }

    /// @notice Returns the delegator's total claimable TBTC rewards in the
    ///         given provider's pool: already-settled rewards plus rewards
    ///         accrued since the last settlement.
    function claimableRewardsOf(address stakingProvider, address delegator)
        external
        view
        returns (uint256)
    {
        Pool storage pool = pools[stakingProvider];
        uint64 delegatorGeneration = shareGeneration[stakingProvider][
            delegator
        ];
        uint256 accumulator = delegatorGeneration == pool.generation
            ? pool.rewardPerShareAccumulator
            : generationFinalRewardAccumulator[stakingProvider][
                delegatorGeneration
            ];
        uint256 accrued = (poolShares[stakingProvider][delegator] *
            accumulator) / REWARD_PRECISION;
        uint256 debt = rewardDebt[stakingProvider][delegator];
        return
            claimableRewards[stakingProvider][delegator] +
            (accrued > debt ? accrued - debt : 0);
    }

    /// @notice Returns the number of undelegation requests ever created.
    function undelegationRequestCount() external view returns (uint256) {
        return undelegationRequests.length;
    }

    /// @notice Returns the number of self-bond withdrawal requests ever
    ///         created.
    function selfBondWithdrawalRequestCount() external view returns (uint256) {
        return selfBondWithdrawalRequests.length;
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    /// @dev Common exit gates for `finalizeUndelegate` and
    ///      `finalizeSelfBondWithdrawal`. Two checks are UNCONDITIONAL and
    ///      apply to delegators and operators alike:
    ///        (1) the fixed `undelegationDelay` cooldown must have elapsed;
    ///        (2) no pending slash may reference the provider — together with
    ///            the atomic-at-report haircut this closes the escape race
    ///            where an exiter finalizes at the pre-haircut share price
    ///            between a fraud report and its execution.
    ///      A THIRD check — the wallet-lifecycle gate, the seat allocator's
    ///      `canFinalizeUndelegate` — is applied only when
    ///      `enforceLifecycleGate` is true. That single call bundles TWO holds:
    ///      (a) it blocks the exit while the ledger reports live wallet exposure
    ///      at or before the epoch recorded at request time (raised to
    ///      `exposureFloorEpoch`); and (b) it blocks the exit while an
    ///      authorization decrease is still awaiting registry approval
    ///      (`decreasePending`), i.e. while the sortition pool may still reflect
    ///      stale, pre-decrease weight ("phantom weight") and a wallet could
    ///      still select this provider on a stale leaf. Passing `false`
    ///      therefore drops BOTH holds, not only the pure exposure check.
    ///
    ///      The gate is enforced asymmetrically by design (see §5, §6, §13 of
    ///      the delegated-staking design):
    ///        - Delegator undelegations pass `false`: passive delegated
    ///          capital is NOT coupled to the operator's full wallet lifecycle.
    ///          A delegator exits on the fixed cooldown plus the pending-slash
    ///          block alone — finalizing even while live wallet exposure
    ///          persists AND while an authorization decrease is still awaiting
    ///          registry approval / the sortition pool reflects stale weight.
    ///          This is intentional and consistent with the fixed-cooldown
    ///          design. The guaranteed live-wallet slashing collateral is
    ///          the operator's self-bond first-loss tranche (which stays
    ///          lifecycle-coupled below and over-covers realistic slashes:
    ///          per-seat self-bond `minSelfBond` far exceeds per-seat slash
    ///          amounts), not the delegated tranche.
    ///        - Operator self-bond withdrawals pass `true`: operators hold the
    ///          wallets' FROST key shares and are the first-loss tranche, so
    ///          their self-bond stays slashable — and thus locked — until every
    ///          wallet they backed at request time has retired.
    /// @param enforceLifecycleGate When true, additionally require no live
    ///        wallet exposure at or before `epochAtRequest` (self-bond path).
    function _checkExitGates(
        address stakingProvider,
        uint64 requestedAt,
        uint64 delayAtRequest,
        uint64 epochAtRequest,
        bool enforceLifecycleGate
    ) internal view {
        // A zero snapshot can only belong to a request created by an older
        // implementation. Preserve its then-current behavior on upgrade;
        // every new request snapshots a bounded non-zero delay.
        uint64 effectiveDelay = delayAtRequest == 0
            ? undelegationDelay
            : delayAtRequest;
        /* solhint-disable-next-line not-rely-on-time */
        if (block.timestamp < uint256(requestedAt) + effectiveDelay) {
            revert UndelegationDelayNotElapsed();
        }
        if (
            ISlashingModule(slashingModule).pendingSlashCount(
                stakingProvider
            ) !=
            0 ||
            seatAllocator.queuedSlashCount(stakingProvider) != 0
        ) {
            revert PendingSlashExists();
        }
        if (enforceLifecycleGate) {
            if (
                !seatAllocator.canFinalizeUndelegate(
                    stakingProvider,
                    epochAtRequest
                )
            ) {
                revert LiveWalletExposure();
            }
        }
    }

    function _validateUndelegationDelay(uint64 delay_) internal pure {
        if (delay_ < MIN_UNDELEGATION_DELAY) {
            revert UndelegationDelayTooShort();
        }
        if (delay_ > MAX_UNDELEGATION_DELAY) {
            revert UndelegationDelayTooLong();
        }
    }

    /// @dev Settles the delegator's rewards accrued since the last
    ///      settlement into `claimableRewards`. Callers mutating shares must
    ///      call `_updateRewardDebt` after the mutation.
    function _settleRewards(address stakingProvider, address delegator)
        internal
    {
        Pool storage pool = pools[stakingProvider];
        uint64 delegatorGeneration = shareGeneration[stakingProvider][
            delegator
        ];
        uint256 accumulator = delegatorGeneration == pool.generation
            ? pool.rewardPerShareAccumulator
            : generationFinalRewardAccumulator[stakingProvider][
                delegatorGeneration
            ];
        uint256 accrued = (poolShares[stakingProvider][delegator] *
            accumulator) / REWARD_PRECISION;
        uint256 debt = rewardDebt[stakingProvider][delegator];
        if (accrued > debt) {
            claimableRewards[stakingProvider][delegator] += accrued - debt;
        }

        if (delegatorGeneration != pool.generation) {
            poolShares[stakingProvider][delegator] = 0;
            delegatorQueuedShares[stakingProvider][delegator] = 0;
            rewardDebt[stakingProvider][delegator] = 0;
            shareGeneration[stakingProvider][delegator] = pool.generation;
        }
    }

    /// @dev Re-anchors the delegator's reward debt at the current share
    ///      balance and accumulator value.
    function _updateRewardDebt(address stakingProvider, address delegator)
        internal
    {
        shareGeneration[stakingProvider][delegator] = pools[stakingProvider]
            .generation;
        rewardDebt[stakingProvider][delegator] =
            (poolShares[stakingProvider][delegator] *
                pools[stakingProvider].rewardPerShareAccumulator) /
            REWARD_PRECISION;
    }

    function _resetWipedPool(address stakingProvider, Pool storage pool)
        internal
    {
        generationFinalRewardAccumulator[stakingProvider][
            pool.generation
        ] = pool.rewardPerShareAccumulator;
        pool.totalShares = 0;
        pool.pendingShares = 0;
        pool.generation += 1;
        emit PoolWiped(stakingProvider, pool.generation);
    }

    /// @dev Treats a delegated tranche as economically wiped once its
    ///      share-to-asset ratio reaches the 1e18 accumulator scale. Resetting
    ///      at the slash boundary caps share amplification before a later
    ///      deposit can mint an enormous supply against dust and permanently
    ///      round ordinary rewards to zero.
    function _requiresGenerationReset(Pool storage pool, uint96 incomingAssets)
        internal
        view
        returns (bool)
    {
        if (pool.totalShares == 0) return false;

        uint256 scaledAssets = uint256(pool.delegatedAssets) * REWARD_PRECISION;
        if (scaledAssets <= pool.totalShares) return true;

        // A deposit preserves the existing share price, so a pool sitting just
        // above the reset boundary can otherwise mint an enormous share supply
        // and let a later ordinary slash reset that amplified supply while
        // material assets remain. Reset before minting when the incoming
        // deposit would consume the remaining precision headroom. Since the
        // margin is denominated in shares, even the maximum uint96 deposit can
        // only abandon sub-token dust from the old generation.
        return incomingAssets >= scaledAssets - pool.totalShares;
    }

    /// @dev Syncs the provider's authorization weight to the registry via
    ///      the seat allocator. Tolerates unset allocator to keep bootstrap
    ///      wiring order flexible. Deliberately NOT called from `applySlash`;
    ///      the slashing module synchronizes reward weight atomically and the
    ///      allocator separately marks registry authorization dirty.
    function _refresh(address stakingProvider) internal {
        if (address(seatAllocator) != address(0)) {
            seatAllocator.refreshAuthorization(stakingProvider);
        }
    }
}
