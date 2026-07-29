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
///        balance and never reverts — it is on the never-revert
///        malicious-behavior reporting path.
///      - Exits (`finalizeUndelegate`, `finalizeSelfBondWithdrawal`) are
///        blocked while the slashing module holds a pending slash for the
///        provider, and additionally gated on the undelegation delay and on
///        the seat allocator's wallet-exposure check.
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

    // Reserved storage space in case we need to add more variables.
    // See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
    // slither-disable-next-line unused-state
    uint256[47] private __gap;

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
    error PoolWipedOut();
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

    /// @notice Finalizes the minimum self-bond update process.
    /// @dev Can be called only after the governance delay elapsed.
    function finalizeMinSelfBondUpdate() external onlyOwner {
        GovernanceUtils.onlyAfterGovernanceDelay(
            minSelfBondChangeInitiated,
            governanceDelay
        );
        minSelfBond = newMinSelfBond;
        emit MinSelfBondUpdated(minSelfBond);
        minSelfBondChangeInitiated = 0;
        newMinSelfBond = 0;
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

        emit SelfBondWithdrawalRequested(
            requestId,
            msg.sender,
            amount,
            epochAtRequest
        );
        _refresh(msg.sender);
    }

    /// @notice Finalizes a queued self-bond withdrawal. Requires the
    ///         undelegation delay to have elapsed, no pending slash for the
    ///         provider, and no live wallet exposure at or before the epoch
    ///         recorded at request time. Pays out at most what is left after
    ///         slashes that hit the queued self-bond during the wait.
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
            request.epochAtRequest
        );

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
        if (!signerRegistry.isActive(stakingProvider)) {
            revert ProviderNotActive();
        }

        Pool storage pool = pools[stakingProvider];

        uint256 mintedShares;
        if (pool.totalShares == 0) {
            // First deposit: 1 share per asset wei.
            mintedShares = amount;
        } else {
            if (pool.delegatedAssets == 0) {
                // The pool was fully slashed while shares are outstanding;
                // minting at any price would let the wiped shares capture
                // value from the new deposit.
                revert PoolWipedOut();
            }
            mintedShares =
                (uint256(amount) * pool.totalShares) /
                pool.delegatedAssets;
        }

        _settleRewards(stakingProvider, msg.sender);

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

        uint256 freeShares = poolShares[stakingProvider][msg.sender] -
            delegatorQueuedShares[stakingProvider][msg.sender];
        if (shares_ > freeShares) revert InsufficientShares();

        // Shares stay in the pool so the share balance does not change, but
        // settle anyway to keep reward accounting anchored at every queue
        // mutation.
        _settleRewards(stakingProvider, msg.sender);
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

        emit UndelegationRequested(
            requestId,
            stakingProvider,
            msg.sender,
            shares_,
            epochAtRequest
        );
        _refresh(stakingProvider);
    }

    /// @notice Finalizes a queued undelegation, burning the shares at the
    ///         CURRENT share price — any slash during the wait was borne
    ///         pro-rata — and returning the backing T. Requires the
    ///         undelegation delay to have elapsed, no pending slash for the
    ///         provider, and no live wallet exposure at or before the epoch
    ///         recorded at request time.
    /// @param requestId Identifier returned by `requestUndelegate`.
    function finalizeUndelegate(uint256 requestId) external {
        if (requestId >= undelegationRequests.length) {
            revert InvalidRequestId();
        }
        UndelegationRequest storage request = undelegationRequests[requestId];
        if (request.finalized) revert RequestAlreadyFinalized();
        if (request.delegator != msg.sender) revert CallerNotRequestOwner();

        address stakingProvider = request.stakingProvider;
        _checkExitGates(
            stakingProvider,
            request.requestedAt,
            request.epochAtRequest
        );

        _settleRewards(stakingProvider, msg.sender);

        Pool storage pool = pools[stakingProvider];
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
    ///         what is available. Performs no external calls and does NOT
    ///         refresh the allocator — this is the never-revert reporting
    ///         path; the allocator marks the weight dirty separately.
    function applySlash(address stakingProvider, uint96 amount)
        external
        override
        onlySlashingModule
        returns (uint96 seized)
    {
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
    ///         been transferred to the vault. If the pool has no shares the
    ///         full amount is routed to the provider's beneficiary as
    ///         claimable rewards instead (falling back to the provider
    ///         address if no beneficiary is registered).
    function creditReward(address stakingProvider, uint256 tbtcAmount)
        external
        override
    {
        if (msg.sender != rewardsDistributor) {
            revert CallerNotRewardsDistributor();
        }
        if (tbtcAmount == 0) return;

        Pool storage pool = pools[stakingProvider];
        if (pool.totalShares == 0) {
            address beneficiary = signerRegistry.beneficiaryOf(stakingProvider);
            if (beneficiary == address(0)) {
                beneficiary = stakingProvider;
            }
            claimableRewards[stakingProvider][beneficiary] += tbtcAmount;
            emit RewardRoutedToBeneficiary(
                stakingProvider,
                beneficiary,
                tbtcAmount
            );
        } else {
            pool.rewardPerShareAccumulator +=
                (tbtcAmount * REWARD_PRECISION) /
                pool.totalShares;
        }

        emit RewardCredited(stakingProvider, tbtcAmount);
    }

    /// @notice Settles and transfers the caller's accrued TBTC rewards from
    ///         the given staking provider's pool.
    /// @param stakingProvider Address of the staking provider.
    function claimRewards(address stakingProvider) external {
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
        return poolShares[stakingProvider][delegator];
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
        return delegatorQueuedShares[stakingProvider][delegator];
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
        uint256 accrued = (poolShares[stakingProvider][delegator] *
            pools[stakingProvider].rewardPerShareAccumulator) /
            REWARD_PRECISION;
        return
            claimableRewards[stakingProvider][delegator] +
            accrued -
            rewardDebt[stakingProvider][delegator];
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
    ///      `finalizeSelfBondWithdrawal`: the undelegation delay must have
    ///      elapsed, no pending slash may exist for the provider, and the
    ///      seat allocator must confirm there is no live wallet exposure at
    ///      or before the epoch recorded at request time.
    function _checkExitGates(
        address stakingProvider,
        uint64 requestedAt,
        uint64 epochAtRequest
    ) internal view {
        /* solhint-disable-next-line not-rely-on-time */
        if (block.timestamp < uint256(requestedAt) + undelegationDelay) {
            revert UndelegationDelayNotElapsed();
        }
        if (
            ISlashingModule(slashingModule).pendingSlashCount(
                stakingProvider
            ) != 0
        ) {
            revert PendingSlashExists();
        }
        if (
            !seatAllocator.canFinalizeUndelegate(
                stakingProvider,
                epochAtRequest
            )
        ) {
            revert LiveWalletExposure();
        }
    }

    /// @dev Settles the delegator's rewards accrued since the last
    ///      settlement into `claimableRewards`. Callers mutating shares must
    ///      call `_updateRewardDebt` after the mutation.
    function _settleRewards(address stakingProvider, address delegator)
        internal
    {
        uint256 accrued = (poolShares[stakingProvider][delegator] *
            pools[stakingProvider].rewardPerShareAccumulator) /
            REWARD_PRECISION;
        uint256 debt = rewardDebt[stakingProvider][delegator];
        if (accrued > debt) {
            claimableRewards[stakingProvider][delegator] += accrued - debt;
        }
    }

    /// @dev Re-anchors the delegator's reward debt at the current share
    ///      balance and accumulator value.
    function _updateRewardDebt(address stakingProvider, address delegator)
        internal
    {
        rewardDebt[stakingProvider][delegator] =
            (poolShares[stakingProvider][delegator] *
                pools[stakingProvider].rewardPerShareAccumulator) /
            REWARD_PRECISION;
    }

    /// @dev Syncs the provider's authorization weight to the registry via
    ///      the seat allocator. Tolerates unset allocator to keep bootstrap
    ///      wiring order flexible. Deliberately NOT called from `applySlash`
    ///      (never-revert path).
    function _refresh(address stakingProvider) internal {
        if (address(seatAllocator) != address(0)) {
            seatAllocator.refreshAuthorization(stakingProvider);
        }
    }
}
