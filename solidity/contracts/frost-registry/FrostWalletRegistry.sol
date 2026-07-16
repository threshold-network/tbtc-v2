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

// IWalletRegistry from @keep-network/ecdsa is intentionally NOT
// inherited. Bridge calls FROST's `requestNewWallet()` via the
// minimal `IFrostWalletRegistryRequest` interface declared in
// `contracts/bridge/Wallets.sol`; the rest of IWalletRegistry's
// surface (e.g., `getWalletCreationState() returns
// (EcdsaDkg.State)`) references the ECDSA-namespaced state enum
// which the FROST registry deliberately re-implements with its
// own `FrostDkg.State` (same shape, different identity). Implementing
// IWalletRegistry verbatim would force a return-type conversion
// that would couple every FROST DKG state change to the ECDSA
// enum's versioning.
import "./api/IFrostWalletOwner.sol";
import "./api/IFrostAuthorizationSource.sol";
import "./libraries/FrostRegistryWallets.sol";
import {FrostAuthorization as Authorization} from "./libraries/FrostAuthorization.sol";
import {FrostDkg as DKG} from "./libraries/FrostDkg.sol";
import {FrostInactivity as Inactivity} from "./libraries/FrostInactivity.sol";
import {FrostDkgValidator as DKGValidator} from "./FrostDkgValidator.sol";

import "@keep-network/sortition-pools/contracts/SortitionPool.sol";
import "@keep-network/random-beacon/contracts/api/IRandomBeacon.sol";
import "@keep-network/random-beacon/contracts/api/IRandomBeaconConsumer.sol";
import "@keep-network/random-beacon/contracts/Reimbursable.sol";
import "@keep-network/random-beacon/contracts/ReimbursementPool.sol";
import "@keep-network/random-beacon/contracts/Governable.sol";

import "@threshold-network/solidity-contracts/contracts/staking/IApplication.sol";

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

contract FrostWalletRegistry is
    IRandomBeaconConsumer,
    IApplication,
    Governable,
    Reimbursable,
    Initializable
{
    using Authorization for Authorization.Data;
    using DKG for DKG.Data;
    using FrostRegistryWallets for FrostRegistryWallets.Data;

    // Libraries data storages
    Authorization.Data internal authorization;
    DKG.Data internal dkg;
    FrostRegistryWallets.Data internal wallets;

    /// @notice Slashing amount for submitting a malicious DKG result. Every
    ///         DKG result submitted can be challenged for the time of
    ///         `dkg.resultChallengePeriodLength`. If the DKG result submitted
    ///         is challenged and proven to be malicious, the operator who
    ///         submitted the malicious result is slashed for
    ///         `_maliciousDkgResultSlashingAmount`.
    uint96 internal _maliciousDkgResultSlashingAmount;

    /// @notice Compatibility multiplier passed to the authorization source's
    ///         malicious behavior hook. Under the FROST allowlist model, the
    ///         hook is a no-op event emission; there are no staked tokens to
    ///         seize or notifier rewards to pay from staking.
    uint256 internal _maliciousDkgResultNotificationRewardMultiplier;

    /// @notice Duration of the sortition pool rewards ban imposed on operators
    ///         who missed their turn for DKG result submission or who failed
    ///         a heartbeat.
    uint256 internal _sortitionPoolRewardsBanDuration;

    /// @notice Calculated max gas cost for submitting a DKG result. This will
    ///         be refunded as part of the DKG approval process. It is in the
    ///         submitter's interest to not skip his priority turn on the approval,
    ///         otherwise the refund of the DKG submission will be refunded to
    ///         another group member that will call the DKG approve function.
    uint256 internal _dkgResultSubmissionGas;

    /// @notice Gas that is meant to balance the DKG result approval's overall
    ///         cost. It can be updated by the governance based on the current
    ///         market conditions.
    uint256 internal _dkgResultApprovalGasOffset;

    /// @notice Gas that is meant to balance the notification of an operator
    ///         inactivity. It can be updated by the governance based on the
    ///         current market conditions.
    uint256 internal _notifyOperatorInactivityGasOffset;

    /// @notice Gas that is meant to balance the notification of a seed for DKG
    ///         delivery timeout. It can be updated by the governance based on the
    ///         current market conditions.
    uint256 internal _notifySeedTimeoutGasOffset;

    /// @notice Gas that is meant to balance the notification of a DKG protocol
    ///         execution timeout. It can be updated by the governance based on the
    ///         current market conditions.
    /// @dev The value is subtracted for the refundable gas calculation, as the
    ///      DKG timeout notification transaction recovers some gas when cleaning
    ///      up the storage.
    uint256 internal _notifyDkgTimeoutNegativeGasOffset;

    /// @notice Stores current operator inactivity claim nonce for the given
    ///         wallet signing group. Each claim is made with a unique nonce
    ///         which protects against claim replay.
    mapping(bytes32 => uint256) public inactivityClaimNonce; // walletID -> nonce

    /// @notice RFC v4 delta #4: defensive guard against duplicate
    ///         FROST wallet registration. Set in `approveDkgResult`
    ///         when a wallet is successfully registered; re-checked
    ///         at the top of `submitDkgResult` to fail fast (and
    ///         to prevent a griefing attack where a malicious
    ///         operator submits a valid-but-already-registered
    ///         result, which would otherwise consume the challenge
    ///         window without yielding a new wallet — leaving the
    ///         DKG state machine locked until timeout).
    ///         Layered on top of the Bridge's own collision check
    ///         in `Wallets.registerNewFrostWallet`; mirrors the
    ///         pattern PR #435 uses for `fraudChallenges`.
    mapping(bytes32 => bool) public registered; // xOnlyOutputKey -> true

    // Address that initiates wallet CREATION on the FROST registry.
    // Set to Bridge at initialize() time. Bridge calls
    // `requestNewWallet()` directly when its scheme-aware
    // dispatcher (post-C-2) routes to the FROST path.
    IFrostWalletOwner public walletOwner;

    // Address that initiates wallet LIFECYCLE operations
    // (closeWallet, seize) on the FROST registry. Distinct from
    // `walletOwner` because the lifecycle path goes through a
    // different on-chain contract: Bridge dispatches FROST
    // lifecycle calls through `BridgeLifecycleRouter` (see
    // `IBridgeLifecycleRouter` + `Bridge.setLifecycleRouter`),
    // so `msg.sender` on close/seize is the router address, not
    // Bridge's. A single `walletOwner` slot can't satisfy both
    // call patterns. Set by governance via `updateLifecycleOwner`
    // after the BridgeLifecycleRouter contract is deployed
    // (deferred to a follow-up PR; not in this commit's deploy
    // script). Until wired, close/seize revert — safe because no
    // FROST wallets exist immediately after registry deploy.
    // (Per PR #441 review — the original single-owner model
    // would have wedged FROST lifecycle calls post-C-2 even
    // with walletOwner=Bridge wired.)
    address public lifecycleOwner;

    // External dependencies

    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    SortitionPool public immutable sortitionPool;
    IRandomBeacon public randomBeacon;

    /// @notice Contract providing FROST operator authorization weights. The
    ///         current production source is `FrostAllowlist`, but the registry
    ///         only depends on this neutral interface. Source migration is
    ///         upgrade-only because `initializeV2` is intentionally one-shot.
    IFrostAuthorizationSource public authorizationSource;

    // Events
    event DkgStarted(uint256 indexed seed);

    event DkgResultSubmitted(
        bytes32 indexed resultHash,
        uint256 indexed seed,
        DKG.Result result
    );

    event DkgTimedOut();

    event DkgResultApproved(
        bytes32 indexed resultHash,
        address indexed approver
    );

    event DkgResultChallenged(
        bytes32 indexed resultHash,
        address indexed challenger,
        string reason
    );

    event DkgStateLocked();

    event DkgSeedTimedOut();

    event WalletCreated(
        bytes32 indexed walletID,
        bytes32 indexed dkgResultHash
    );

    event WalletClosed(bytes32 indexed walletID);

    event DkgMaliciousResultSlashed(
        bytes32 indexed resultHash,
        uint256 slashingAmount,
        address maliciousSubmitter
    );

    event DkgMaliciousResultSlashingFailed(
        bytes32 indexed resultHash,
        uint256 slashingAmount,
        address maliciousSubmitter
    );

    event AuthorizationParametersUpdated(
        uint96 minimumAuthorization,
        uint64 authorizationDecreaseDelay,
        uint64 authorizationDecreaseChangePeriod
    );

    event RewardParametersUpdated(
        uint256 maliciousDkgResultNotificationRewardMultiplier,
        uint256 sortitionPoolRewardsBanDuration
    );

    event SlashingParametersUpdated(uint256 maliciousDkgResultSlashingAmount);

    event DkgParametersUpdated(
        uint256 seedTimeout,
        uint256 resultChallengePeriodLength,
        uint256 resultChallengeExtraGas,
        uint256 resultSubmissionTimeout,
        uint256 resultSubmitterPrecedencePeriodLength
    );

    event GasParametersUpdated(
        uint256 dkgResultSubmissionGas,
        uint256 dkgResultApprovalGasOffset,
        uint256 notifyOperatorInactivityGasOffset,
        uint256 notifySeedTimeoutGasOffset,
        uint256 notifyDkgTimeoutNegativeGasOffset
    );

    event RandomBeaconUpgraded(address randomBeacon);

    event WalletOwnerUpdated(address walletOwner);

    event LifecycleOwnerUpdated(address lifecycleOwner);

    event AuthorizationSourceUpdated(address authorizationSource);

    /// @notice Raised when `requestNewWallet` or `approveDkgResult`
    ///         is called while `lifecycleOwner` is the zero
    ///         address — i.e., before governance has wired the
    ///         BridgeLifecycleRouter via `updateLifecycleOwner`.
    ///         Forces the activation sequence to wire lifecycle
    ///         ownership BEFORE any FROST wallets can be created.
    ///         Custom error (not require string) so it survives
    ///         all JSON-RPC node decoding paths.
    error LifecycleOwnerNotSet();

    event OperatorRegistered(
        address indexed stakingProvider,
        address indexed operator
    );

    event AuthorizationIncreased(
        address indexed stakingProvider,
        address indexed operator,
        uint96 fromAmount,
        uint96 toAmount
    );

    event AuthorizationDecreaseRequested(
        address indexed stakingProvider,
        address indexed operator,
        uint96 fromAmount,
        uint96 toAmount,
        uint64 decreasingAt
    );

    event AuthorizationDecreaseApproved(address indexed stakingProvider);

    event InvoluntaryAuthorizationDecreaseFailed(
        address indexed stakingProvider,
        address indexed operator,
        uint96 fromAmount,
        uint96 toAmount
    );

    event OperatorJoinedSortitionPool(
        address indexed stakingProvider,
        address indexed operator
    );

    event OperatorStatusUpdated(
        address indexed stakingProvider,
        address indexed operator
    );

    event InactivityClaimed(
        bytes32 indexed walletID,
        uint256 nonce,
        address notifier
    );

    modifier onlyAuthorizationSource() {
        address currentAuthorizationSource = address(authorizationSource);
        require(
            currentAuthorizationSource != address(0),
            "Authorization source is not initialized"
        );
        require(
            msg.sender == currentAuthorizationSource,
            "Caller is not the authorization source"
        );
        _;
    }

    /// @notice Reverts if called not by the Wallet Owner.
    /// @dev Used by `requestNewWallet` — Bridge calls directly.
    modifier onlyWalletOwner() {
        require(
            msg.sender == address(walletOwner),
            "Caller is not the Wallet Owner"
        );
        _;
    }

    /// @notice Reverts if called not by the Lifecycle Owner.
    /// @dev Used by `closeWallet` + `seize` — Bridge routes
    ///      these through `BridgeLifecycleRouter`, so the
    ///      caller-of-record is the router, not Bridge itself.
    modifier onlyLifecycleOwner() {
        require(
            msg.sender == lifecycleOwner,
            "Caller is not the Lifecycle Owner"
        );
        _;
    }

    modifier onlyReimbursableAdmin() override {
        require(governance == msg.sender, "Caller is not the governance");
        _;
    }

    /// @dev Used to initialize immutable variables only, use `initialize` function
    ///      for upgradable contract initialization on deployment.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(SortitionPool _sortitionPool) {
        sortitionPool = _sortitionPool;

        _disableInitializers();
    }

    /// @dev Initializes upgradable contract on deployment.
    /// @param _bridge Bridge address — serves two distinct roles:
    ///        (a) wired into the DKG result digest for
    ///            cross-deployment replay safety (RFC v4); and
    ///        (b) set as the registry's `walletOwner`, so the
    ///            `onlyWalletOwner` modifier on `requestNewWallet` /
    ///            `closeWallet` / etc. resolves correctly when
    ///            Bridge's scheme-aware dispatcher (post-C-2)
    ///            routes wallet-creation requests here. Without
    ///            this, the registry would be deployed-but-dead
    ///            even AFTER `setFrostWalletRegistry` wires it
    ///            to Bridge, because every entry would revert
    ///            with `Caller is not the Wallet Owner`.
    ///            (Per PR #441 review.)
    function initialize(
        DKGValidator _ecdsaDkgValidator,
        IRandomBeacon _randomBeacon,
        ReimbursementPool _reimbursementPool,
        address _bridge
    ) external initializer {
        randomBeacon = _randomBeacon;
        reimbursementPool = _reimbursementPool;
        // Wire walletOwner = Bridge at init time. The
        // `updateWalletOwner` external still exists for
        // governance to retarget in a future deploy where
        // Bridge ownership is moved (e.g., to a router or
        // lifecycle-dispatch contract).
        walletOwner = IFrostWalletOwner(_bridge);
        emit WalletOwnerUpdated(_bridge);

        _transferGovernance(msg.sender);

        //
        // All parameters set in the constructor are initial ones, used at the
        // moment contracts were deployed for the first time. Parameters are
        // governable and values assigned in the constructor do not need to
        // reflect the current ones.
        //

        // Minimum authorization is 40k T.
        //
        // Authorization decrease delay is 45 days.
        //
        // Authorization decrease change period is 45 days. It means pending
        // authorization decrease can be overwritten all the time.
        authorization.setMinimumAuthorization(40_000e18);
        authorization.setAuthorizationDecreaseDelay(3_888_000);
        authorization.setAuthorizationDecreaseChangePeriod(3_888_000);

        // Malicious DKG result slashing amount is set initially to 1% of the
        // minimum authorization (400 T). This values needs to be increased
        // significantly once the system is fully launched.
        //
        // Notifier multiplier kept at 100 for compatibility with the
        // authorization-source hook. The FROST allowlist hook is event-only.
        //
        // Inactive operators are set as ineligible for rewards for 2 weeks.
        _maliciousDkgResultSlashingAmount = 400e18;
        _maliciousDkgResultNotificationRewardMultiplier = 100;
        _sortitionPoolRewardsBanDuration = 2 weeks;

        // DKG seed timeout is set to 48h assuming 15s block time. The same
        // value is used by the Random Beacon as a relay entry hard timeout.
        //
        // DKG result challenge period length is set to 48h as well, assuming
        // 15s block time.
        //
        // DKG result submission timeout covers:
        // - 20 blocks required to confirm the DkgStarted event off-chain
        // - 1 attempt of the off-chain protocol that takes 216 blocks at most
        // - 3 blocks to submit the result for each of the 100 members
        // That gives: 20 + (1 * 216) + (3 * 100) = 536
        //
        //
        // The original DKG result submitter has 20 blocks to approve it before
        // anyone else can do that.
        //
        // With these parameters, the happy path takes no more than 104 hours.
        // In practice, it should take about 48 hours (just the challenge time).
        // Optimization noted during PR #441 review: `registry`
        // address is no longer passed at init time — FrostDkg's
        // internal library functions execute in this contract's
        // context, so `address(this)` at the validate call site
        // evaluates to the registry address directly.
        dkg.init(sortitionPool, _ecdsaDkgValidator, _bridge);
        dkg.setSeedTimeout(11_520);
        dkg.setResultChallengePeriodLength(11_520);
        dkg.setResultChallengeExtraGas(50_000);
        dkg.setResultSubmissionTimeout(536);
        dkg.setSubmitterPrecedencePeriodLength(20);

        // DKG result submission recreates the 100-member group selected for the
        // current seed. The reimbursement includes headroom over the measured
        // cost of that validation against a populated sortition pool.
        _dkgResultSubmissionGas = 1_500_000;

        // The remaining gas parameters were adjusted based on Ethereum state in
        // April 2022. If the cost of EVM opcodes changes over time, these
        // parameters will have to be updated.
        _dkgResultApprovalGasOffset = 72_000;
        _notifyOperatorInactivityGasOffset = 93_000;
        _notifySeedTimeoutGasOffset = 7_250;
        _notifyDkgTimeoutNegativeGasOffset = 2_300;
    }

    /// @notice Wires the FROST operator authorization source. Authorization
    ///         callbacks and authorization weight reads are disabled until this
    ///         method is called.
    function initializeV2(address _authorizationSource)
        external
        reinitializer(2)
    {
        require(governance == msg.sender, "Caller is not the governance");
        require(
            _authorizationSource != address(0),
            "Authorization source address cannot be zero"
        );
        authorizationSource = IFrostAuthorizationSource(_authorizationSource);
        emit AuthorizationSourceUpdated(_authorizationSource);
    }

    /// @notice Withdraws application rewards for the given staking provider.
    ///         Rewards are withdrawn to the beneficiary returned by the
    ///         allowlist compatibility interface. Reverts if staking provider
    ///         has not registered the operator address.
    /// @dev Emits `RewardsWithdrawn` event.
    function withdrawRewards(address stakingProvider) external {
        address operator = stakingProviderToOperator(stakingProvider);
        require(operator != address(0), "Unknown operator");
        (, address beneficiary, ) = _currentAuthorizationSource().rolesOf(
            stakingProvider
        );
        uint96 amount = sortitionPool.withdrawRewards(operator, beneficiary);
        // slither-disable-next-line reentrancy-events
        emit RewardsWithdrawn(stakingProvider, amount);
    }

    /// @notice Withdraws rewards belonging to operators marked as ineligible
    ///         for sortition pool rewards.
    /// @dev Can be called only by the contract guvnor, which should be the
    ///      wallet registry governance contract.
    /// @param recipient Recipient of withdrawn rewards.
    function withdrawIneligibleRewards(address recipient)
        external
        onlyGovernance
    {
        sortitionPool.withdrawIneligible(recipient);
    }

    /// @notice Used by staking provider to set operator address that will
    ///         operate a FROST node. The given staking provider can set operator
    ///         address only one time. The operator address can not be changed
    ///         and must be unique. Reverts if the operator is already set for
    ///         the staking provider or if the operator address is already in
    ///         use. Reverts if there is a pending authorization decrease for
    ///         the staking provider.
    function registerOperator(address operator) external {
        authorization.registerOperator(operator);
    }

    /// @notice Lets the operator join the sortition pool. The operator address
    ///         must be known - before calling this function, it has to be
    ///         appointed by the staking provider by calling `registerOperator`.
    ///         Also, the operator must have the minimum authorization required
    ///         by FROST. Function reverts if there is no minimum authorization
    ///         or if the operator is not known. If there was an
    ///         authorization decrease requested, it is activated by starting
    ///         the authorization decrease delay.
    function joinSortitionPool() external {
        authorization.joinSortitionPool(
            _currentAuthorizationSource(),
            sortitionPool
        );
    }

    /// @notice Updates status of the operator in the sortition pool. If there
    ///         was an authorization decrease requested, it is activated by
    ///         starting the authorization decrease delay.
    ///         Function reverts if the operator is not known.
    function updateOperatorStatus(address operator) external {
        authorization.updateOperatorStatus(
            _currentAuthorizationSource(),
            sortitionPool,
            operator
        );
    }

    /// @notice Used by the authorization source to inform the registry that
    ///         the authorization weight for the given staking provider
    ///         increased.
    ///
    ///         Reverts if the authorization amount is below the minimum.
    ///
    ///         The function is not updating the sortition pool. Sortition pool
    ///         state needs to be updated by the operator with a call to
    ///         `joinSortitionPool` or `updateOperatorStatus`.
    ///
    /// @dev Can only be called by the FROST allowlist authorization source.
    function authorizationIncreased(
        address stakingProvider,
        uint96 fromAmount,
        uint96 toAmount
    ) external onlyAuthorizationSource {
        authorization.authorizationIncreased(
            stakingProvider,
            fromAmount,
            toAmount
        );
    }

    /// @notice Used by the authorization source to inform the registry that an
    ///         authorization weight decrease for the given staking provider has
    ///         been requested.
    ///
    ///         Reverts if the amount after deauthorization would be non-zero
    ///         and lower than the minimum authorization.
    ///
    ///         If the operator is not known (`registerOperator` was not called)
    ///         it lets to `approveAuthorizationDecrease` immediatelly. If the
    ///         operator is known (`registerOperator` was called), the operator
    ///         needs to update state of the sortition pool with a call to
    ///         `joinSortitionPool` or `updateOperatorStatus`. After the
    ///         sortition pool state is in sync, authorization decrease delay
    ///         starts.
    ///
    ///         After authorization decrease delay passes, authorization
    ///         decrease request needs to be approved with a call to
    ///         `approveAuthorizationDecrease` function.
    ///
    ///         If there is a pending authorization decrease request, it is
    ///         overwritten.
    ///
    /// @dev Can only be called by the FROST allowlist authorization source.
    function authorizationDecreaseRequested(
        address stakingProvider,
        uint96 fromAmount,
        uint96 toAmount
    ) external onlyAuthorizationSource {
        authorization.authorizationDecreaseRequested(
            stakingProvider,
            fromAmount,
            toAmount
        );
    }

    /// @notice Approves the previously registered authorization decrease
    ///         request. Reverts if authorization decrease delay has not passed
    ///         yet or if the authorization decrease was not requested for the
    ///         given staking provider.
    function approveAuthorizationDecrease(address stakingProvider) external {
        authorization.approveAuthorizationDecrease(
            _currentAuthorizationSource(),
            stakingProvider
        );
    }

    /// @notice Compatibility callback for involuntary authorization decreases.
    ///         Under the FROST allowlist model, authorization changes are
    ///         governance-controlled rather than token-slashing-controlled.
    ///
    ///         If the operator is not known (`registerOperator` was not called)
    ///         the function does nothing. The operator was never in a sortition
    ///         pool so there is nothing to update.
    ///
    ///         If the operator is known, sortition pool is unlocked, and the
    ///         operator is in the sortition pool, the sortition pool state is
    ///         updated. If the sortition pool is locked, update needs to be
    ///         postponed. Every other operator provider is incentivized to call
    ///         `updateOperatorStatus` for the problematic operator to increase
    ///         their own rewards in the pool.
    function involuntaryAuthorizationDecrease(
        address stakingProvider,
        uint96 fromAmount,
        uint96 toAmount
    ) external onlyAuthorizationSource {
        authorization.involuntaryAuthorizationDecrease(
            _currentAuthorizationSource(),
            sortitionPool,
            stakingProvider,
            fromAmount,
            toAmount
        );
    }

    /// @notice Updates address of the Random Beacon.
    /// @dev Can be called only by the contract guvnor, which should be the
    ///      wallet registry governance contract. The caller is responsible for
    ///      validating parameters.
    /// @param _randomBeacon Random Beacon address.
    function upgradeRandomBeacon(IRandomBeacon _randomBeacon)
        external
        onlyGovernance
    {
        randomBeacon = _randomBeacon;
        emit RandomBeaconUpgraded(address(_randomBeacon));
    }

    /// @notice Updates the wallet owner.
    /// @dev Can be called only by the contract guvnor, which should be the
    ///      wallet registry governance contract. The caller is responsible for
    ///      validating parameters. The wallet owner has to implement `IFrostWalletOwner`
    ///      interface.
    /// @param _walletOwner New wallet owner address.
    function updateWalletOwner(IFrostWalletOwner _walletOwner)
        external
        onlyGovernance
    {
        walletOwner = _walletOwner;
        emit WalletOwnerUpdated(address(_walletOwner));
    }

    /// @notice Updates the lifecycle owner — the address that may
    ///         call `closeWallet` + `seize`. This is the
    ///         `BridgeLifecycleRouter` contract (see
    ///         `IBridgeLifecycleRouter`); Bridge routes FROST
    ///         lifecycle operations through it, so the
    ///         caller-of-record on the registry is the router
    ///         address (not Bridge's).
    /// @dev Governance-only. Intended deployment order:
    ///      (1) deploy the FrostWalletRegistry;
    ///      (2) `Bridge.setFrostWalletRegistry(registry)`;
    ///      (3) deploy `BridgeLifecycleRouter`;
    ///      (4) `Bridge.setLifecycleRouter(router)`;
    ///      (5) `registry.updateLifecycleOwner(router)` (this
    ///          function).
    ///      Until step 5 completes, FROST `closeWallet` / `seize`
    ///      revert with `Caller is not the Lifecycle Owner`. Safe
    ///      because no FROST wallets exist between deploy and
    ///      C-2's scheme flip.
    /// @param _lifecycleOwner New lifecycle owner address.
    function updateLifecycleOwner(address _lifecycleOwner)
        external
        onlyGovernance
    {
        lifecycleOwner = _lifecycleOwner;
        emit LifecycleOwnerUpdated(_lifecycleOwner);
    }

    /// @notice Updates the values of authorization parameters.
    /// @dev Can be called only by the contract guvnor, which should be the
    ///      wallet registry governance contract. The caller is responsible for
    ///      validating parameters.
    /// @param _minimumAuthorization New minimum authorization amount.
    /// @param _authorizationDecreaseDelay New authorization decrease delay in
    ///        seconds.
    /// @param _authorizationDecreaseChangePeriod New authorization decrease
    ///        change period in seconds.
    function updateAuthorizationParameters(
        uint96 _minimumAuthorization,
        uint64 _authorizationDecreaseDelay,
        uint64 _authorizationDecreaseChangePeriod
    ) external onlyGovernance {
        authorization.setMinimumAuthorization(_minimumAuthorization);
        authorization.setAuthorizationDecreaseDelay(
            _authorizationDecreaseDelay
        );
        authorization.setAuthorizationDecreaseChangePeriod(
            _authorizationDecreaseChangePeriod
        );

        emit AuthorizationParametersUpdated(
            _minimumAuthorization,
            _authorizationDecreaseDelay,
            _authorizationDecreaseChangePeriod
        );
    }

    /// @notice Updates the values of DKG parameters.
    /// @dev Can be called only by the contract guvnor, which should be the
    ///      wallet registry governance contract. The caller is responsible for
    ///      validating parameters.
    /// @param _seedTimeout New seed timeout.
    /// @param _resultChallengePeriodLength New DKG result challenge period
    ///        length.
    /// @param _resultChallengeExtraGas New extra gas value required to be left
    ///        at the end of the DKG result challenge transaction.
    /// @param _resultSubmissionTimeout New DKG result submission timeout.
    /// @param _submitterPrecedencePeriodLength New submitter precedence period
    ///        length.
    function updateDkgParameters(
        uint256 _seedTimeout,
        uint256 _resultChallengePeriodLength,
        uint256 _resultChallengeExtraGas,
        uint256 _resultSubmissionTimeout,
        uint256 _submitterPrecedencePeriodLength
    ) external onlyGovernance {
        dkg.setSeedTimeout(_seedTimeout);
        dkg.setResultChallengePeriodLength(_resultChallengePeriodLength);
        dkg.setResultChallengeExtraGas(_resultChallengeExtraGas);
        dkg.setResultSubmissionTimeout(_resultSubmissionTimeout);
        dkg.setSubmitterPrecedencePeriodLength(
            _submitterPrecedencePeriodLength
        );

        // slither-disable-next-line reentrancy-events
        emit DkgParametersUpdated(
            _seedTimeout,
            _resultChallengePeriodLength,
            _resultChallengeExtraGas,
            _resultSubmissionTimeout,
            _submitterPrecedencePeriodLength
        );
    }

    /// @notice Updates the values of reward parameters.
    /// @dev Can be called only by the contract guvnor, which should be the
    ///      wallet registry governance contract. The caller is responsible for
    ///      validating parameters.
    /// @param maliciousDkgResultNotificationRewardMultiplier New value of the
    ///        DKG malicious result notification reward multiplier.
    /// @param sortitionPoolRewardsBanDuration New sortition pool rewards
    ///        ban duration in seconds.
    function updateRewardParameters(
        uint256 maliciousDkgResultNotificationRewardMultiplier,
        uint256 sortitionPoolRewardsBanDuration
    ) external onlyGovernance {
        _maliciousDkgResultNotificationRewardMultiplier = maliciousDkgResultNotificationRewardMultiplier;
        _sortitionPoolRewardsBanDuration = sortitionPoolRewardsBanDuration;
        emit RewardParametersUpdated(
            maliciousDkgResultNotificationRewardMultiplier,
            sortitionPoolRewardsBanDuration
        );
    }

    /// @notice Updates the values of slashing parameters.
    /// @dev Can be called only by the contract guvnor, which should be the
    ///      wallet registry governance contract. The caller is responsible for
    ///      validating parameters.
    /// @param maliciousDkgResultSlashingAmount New malicious DKG result
    ///        slashing amount.
    function updateSlashingParameters(uint96 maliciousDkgResultSlashingAmount)
        external
        onlyGovernance
    {
        _maliciousDkgResultSlashingAmount = maliciousDkgResultSlashingAmount;
        emit SlashingParametersUpdated(maliciousDkgResultSlashingAmount);
    }

    /// @notice Updates the values of gas-related parameters.
    /// @dev Can be called only by the contract guvnor, which should be the
    ///      wallet registry governance contract. The caller is responsible for
    ///      validating parameters.
    /// @param dkgResultSubmissionGas New DKG result submission gas.
    /// @param dkgResultApprovalGasOffset New DKG result approval gas offset.
    /// @param notifyOperatorInactivityGasOffset New operator inactivity
    ///        notification gas offset.
    /// @param notifySeedTimeoutGasOffset New seed for DKG delivery timeout
    ///        notification gas offset.
    /// @param notifyDkgTimeoutNegativeGasOffset New DKG timeout notification gas
    ///        offset.
    function updateGasParameters(
        uint256 dkgResultSubmissionGas,
        uint256 dkgResultApprovalGasOffset,
        uint256 notifyOperatorInactivityGasOffset,
        uint256 notifySeedTimeoutGasOffset,
        uint256 notifyDkgTimeoutNegativeGasOffset
    ) external onlyGovernance {
        _dkgResultSubmissionGas = dkgResultSubmissionGas;
        _dkgResultApprovalGasOffset = dkgResultApprovalGasOffset;
        _notifyOperatorInactivityGasOffset = notifyOperatorInactivityGasOffset;
        _notifySeedTimeoutGasOffset = notifySeedTimeoutGasOffset;
        _notifyDkgTimeoutNegativeGasOffset = notifyDkgTimeoutNegativeGasOffset;

        emit GasParametersUpdated(
            dkgResultSubmissionGas,
            dkgResultApprovalGasOffset,
            notifyOperatorInactivityGasOffset,
            _notifySeedTimeoutGasOffset,
            _notifyDkgTimeoutNegativeGasOffset
        );
    }

    /// @notice Requests a new wallet creation.
    /// @dev Can be called only by the owner of wallets.
    ///      It locks the DKG and request a new relay entry. It expects
    ///      that the DKG process will be started once a new relay entry
    ///      gets generated.
    ///
    ///      Pre-condition: `lifecycleOwner` MUST be set first
    ///      (governance calls `updateLifecycleOwner(router)` after
    ///      the BridgeLifecycleRouter is deployed). Without this
    ///      guard, a DKG session could complete + register a live
    ///      FROST wallet that the registry then refuses to
    ///      `closeWallet`/`seize` — every lifecycle call would
    ///      revert with `Caller is not the Lifecycle Owner` and
    ///      the wallet would be operationally orphaned until
    ///      governance retroactively wired the router. Failing
    ///      fast here forces the activation sequence to wire
    ///      lifecycle ownership BEFORE any FROST wallets exist.
    ///      (Per PR #441 follow-up review.)
    function requestNewWallet() external onlyWalletOwner {
        if (lifecycleOwner == address(0)) {
            revert LifecycleOwnerNotSet();
        }
        dkg.lockState();

        randomBeacon.requestRelayEntry(this);
    }

    /// @notice Closes an existing wallet. Reverts if wallet with the given ID
    ///         does not exist or if it has already been closed.
    /// @param walletID ID of the wallet.
    /// @dev Only the Lifecycle Owner can call this function —
    ///      Bridge dispatches FROST lifecycle calls through
    ///      `BridgeLifecycleRouter`, so `msg.sender` is the
    ///      router, not Bridge. See the `lifecycleOwner` storage
    ///      block comment.
    function closeWallet(bytes32 walletID) external onlyLifecycleOwner {
        wallets.deleteWallet(walletID);
        emit WalletClosed(walletID);
    }

    /// @notice A callback that is executed once a new relay entry gets
    ///         generated. It starts the DKG process.
    /// @dev Can be called only by the random beacon contract.
    /// @param relayEntry Relay entry.
    function __beaconCallback(uint256 relayEntry, uint256) external {
        require(
            msg.sender == address(randomBeacon),
            "Caller is not the Random Beacon"
        );

        dkg.start(relayEntry);
    }

    /// @notice Submits result of DKG protocol.
    ///         The DKG result consists of result submitting member index,
    ///         calculated group public key, bytes array of misbehaved members,
    ///         concatenation of signatures from group members, indices of members
    ///         corresponding to each signature and the list of group members.
    ///         The result is registered optimistically and waits for an approval.
    ///         The result can be challenged when it is believed to be incorrect.
    ///         The challenge verifies the registered result i.a. it checks if members
    ///         list corresponds to the expected set of members determined
    ///         by the sortition pool.
    /// @dev The message each member signs is the v4 RFC result digest
    ///      (see `wallet-registry-trust-model-rfc.md`):
    ///        keccak256(abi.encode(
    ///          "tbtc-frost-dkg-result-v1",
    ///          block.chainid,
    ///          address(bridge),
    ///          address(this),
    ///          seed,
    ///          xOnlyOutputKey,
    ///          keccak256(abi.encode(members)),
    ///          keccak256(abi.encode(misbehavedMembersIndices))
    ///        ))
    ///      EIP-191-prefixed before signing. `FrostDkgValidator` computes
    ///      this digest and verifies the signature bundle; the
    ///      validator's surface takes `address bridge` and
    ///      `address registry` parameters so the digest binds correctly
    ///      across deployments.
    /// @param dkgResult DKG result.
    function submitDkgResult(DKG.Result calldata dkgResult) external {
        // RFC v4 delta #4: fail-fast on already-registered keys.
        // Without this top-of-function check, a valid-but-stale
        // result could enter the challenge window and lock the
        // DKG state machine until timeout (the result is "valid"
        // per the validator so there's no challenge basis, but
        // `approveDkgResult` would revert downstream on
        // `wallets.validateXOnlyOutputKey`).
        require(
            !registered[dkgResult.xOnlyOutputKey],
            "FROST wallet already registered"
        );
        wallets.validateXOnlyOutputKey(dkgResult.xOnlyOutputKey);
        dkg.submitResult(dkgResult);
    }

    /// @notice Approves DKG result. Can be called when the challenge period for
    ///         the submitted result is finished. Considers the submitted result
    ///         as valid, bans misbehaved group members from the sortition pool
    ///         rewards, and completes the group creation by activating the
    ///         candidate group. For the first `resultSubmissionTimeout` blocks
    ///         after the end of the challenge period can be called only by the
    ///         DKG result submitter. After that time, can be called by anyone.
    ///         A new wallet based on the DKG result details.
    /// @param dkgResult Result to approve. Must match the submitted result
    ///        stored during `submitDkgResult`.
    function approveDkgResult(DKG.Result calldata dkgResult) external {
        // Defense-in-depth: `requestNewWallet` already checks
        // `lifecycleOwner != 0` before locking DKG, so by the
        // time a result is approved, lifecycle should be wired.
        // BUT governance COULD theoretically `updateLifecycleOwner(0)`
        // mid-DKG (the setter is just a write, not a one-time
        // setter), so re-check here to guarantee no FROST wallet
        // ever registers without an active lifecycle path.
        // (Per PR #441 follow-up review.)
        if (lifecycleOwner == address(0)) {
            revert LifecycleOwnerNotSet();
        }
        uint256 gasStart = gasleft();
        uint32[] memory misbehavedMembers = dkg.approveResult(dkgResult);

        bytes32 walletID = wallets.addWallet(
            dkgResult.membersHash,
            dkgResult.xOnlyOutputKey
        );

        // RFC v4 delta #4: set the defensive-guard flag at the
        // same time the wallet is added to storage; subsequent
        // `submitDkgResult` calls for the same key fail-fast.
        registered[dkgResult.xOnlyOutputKey] = true;

        emit WalletCreated(walletID, keccak256(abi.encode(dkgResult)));

        if (misbehavedMembers.length > 0) {
            sortitionPool.setRewardIneligibility(
                misbehavedMembers,
                // solhint-disable-next-line not-rely-on-time
                block.timestamp + _sortitionPoolRewardsBanDuration
            );
        }

        // RFC v4 delta #3: FROST callback shape. The Bridge callback
        // receives only the x-only output key; the FROST DKG output has
        // no y-coordinate and the walletID is the key itself (see
        // `IFrostWalletOwner.__frostWalletCreatedCallback`).
        walletOwner.__frostWalletCreatedCallback(dkgResult.xOnlyOutputKey);

        dkg.complete();

        // Refund msg.sender's ETH for DKG result submission and result approval
        reimbursementPool.refund(
            _dkgResultSubmissionGas +
                (gasStart - gasleft()) +
                _dkgResultApprovalGasOffset,
            msg.sender
        );
    }

    /// @notice Notifies about seed for DKG delivery timeout. It is expected
    ///         that a seed is delivered by the Random Beacon as a relay entry in a
    ///         callback function.
    function notifySeedTimeout() external {
        uint256 gasStart = gasleft();

        dkg.notifySeedTimeout();

        reimbursementPool.refund(
            (gasStart - gasleft()) + _notifySeedTimeoutGasOffset,
            msg.sender
        );
    }

    /// @notice Notifies about DKG timeout.
    function notifyDkgTimeout() external {
        uint256 gasStart = gasleft();

        dkg.notifyDkgTimeout();

        // Note that the offset is subtracted as it is expected that the cleanup
        // performed on DKG timeout notification removes data from the storage
        // which is recovering gas for the transaction.
        reimbursementPool.refund(
            (gasStart - gasleft()) - _notifyDkgTimeoutNegativeGasOffset,
            msg.sender
        );
    }

    /// @notice Challenges DKG result. If the submitted result is proved to be
    ///         invalid it reverts the DKG back to the result submission phase.
    /// @param dkgResult Result to challenge. Must match the submitted result
    ///        stored during `submitDkgResult`.
    /// @dev Due to EIP-150 1/64 of the gas is not forwarded to the call, and
    ///      will be kept to execute the remaining operations in the function
    ///      after the call inside the try-catch. To eliminate a class of
    ///      attacks related to the gas limit manipulation, this function
    ///      requires an extra amount of gas to be left at the end of the
    ///      execution.
    function challengeDkgResult(DKG.Result calldata dkgResult) external {
        // solhint-disable-next-line avoid-tx-origin
        require(msg.sender == tx.origin, "Not EOA");

        (
            bytes32 maliciousDkgResultHash,
            uint32 maliciousDkgResultSubmitterId
        ) = dkg.challengeResult(dkgResult);

        address maliciousDkgResultSubmitterAddress = sortitionPool
            .getIDOperator(maliciousDkgResultSubmitterId);

        address[] memory operatorWrapper = new address[](1);
        operatorWrapper[0] = operatorToStakingProvider(
            maliciousDkgResultSubmitterAddress
        );

        IFrostAuthorizationSource currentAuthorizationSource = _currentAuthorizationSource();
        try
            currentAuthorizationSource.reportMaliciousBehavior(
                _maliciousDkgResultSlashingAmount,
                _maliciousDkgResultNotificationRewardMultiplier,
                msg.sender,
                operatorWrapper
            )
        {
            // slither-disable-next-line reentrancy-events
            emit DkgMaliciousResultSlashed(
                maliciousDkgResultHash,
                _maliciousDkgResultSlashingAmount,
                maliciousDkgResultSubmitterAddress
            );
        } catch {
            // Should never happen but we want to ensure a non-critical path
            // failure from an external contract does not stop the challenge
            // to complete.
            emit DkgMaliciousResultSlashingFailed(
                maliciousDkgResultHash,
                _maliciousDkgResultSlashingAmount,
                maliciousDkgResultSubmitterAddress
            );
        }

        // Due to EIP-150, 1/64 of the gas is not forwarded to the call, and
        // will be kept to execute the remaining operations in the function
        // after the call inside the try-catch.
        //
        // To ensure there is no way for the caller to manipulate gas limit in
        // such a way that the call inside try-catch fails with out-of-gas and
        // the rest of the function is executed with the remaining 1/64 of gas,
        // we require an extra gas amount to be left at the end of the call to
        // `challengeDkgResult`.
        dkg.requireChallengeExtraGas();
    }

    /// @notice Notifies about operators who are inactive. Using this function,
    ///         a majority of the wallet signing group can decide about
    ///         punishing specific group members who constantly fail doing their
    ///         job. If the provided claim is proved to be valid and signed by
    ///         sufficient number of group members, operators of members deemed
    ///         as inactive are banned from sortition pool rewards for the
    ///         duration specified by `sortitionPoolRewardsBanDuration` parameter.
    ///         The function allows to signal about single operators being
    ///         inactive as well as to signal wallet-wide heartbeat failures
    ///         that are propagated to the wallet owner who should begin the
    ///         procedure of moving responsibilities to another wallet given
    ///         that the wallet who failed the heartbeat may soon be not able to
    ///         function and provide new signatures.
    ///         The sender of the claim must be one of the claim signers. This
    ///         function can be called only for registered wallets
    /// @param claim Operator inactivity claim.
    /// @param nonce Current inactivity claim nonce for the given wallet signing
    ///              group. Must be the same as the stored one.
    /// @param groupMembers Identifiers of the wallet signing group members.
    function notifyOperatorInactivity(
        Inactivity.Claim calldata claim,
        uint256 nonce,
        uint32[] calldata groupMembers
    ) external {
        uint256 gasStart = gasleft();

        bytes32 walletID = claim.walletID;

        require(nonce == inactivityClaimNonce[walletID], "Invalid nonce");

        bytes32 xOnlyOutputKey = wallets.getWalletXOnlyOutputKey(walletID);
        bytes32 memberIdsHash = wallets.getWalletMembersIdsHash(walletID);

        require(
            memberIdsHash == keccak256(abi.encode(groupMembers)),
            "Invalid group members"
        );

        Inactivity.processClaim(
            inactivityClaimNonce,
            sortitionPool,
            walletOwner,
            claim,
            xOnlyOutputKey,
            nonce,
            groupMembers,
            _sortitionPoolRewardsBanDuration
        );

        reimbursementPool.refund(
            (gasStart - gasleft()) + _notifyOperatorInactivityGasOffset,
            msg.sender
        );
    }

    /// @notice Allows the wallet owner to report all signing group members of
    ///         the wallet with the given ID to the authorization source's
    ///         misbehavior hook. In the FROST allowlist implementation this is
    ///         an event-only no-op because operators do not stake tokens.
    /// @param amount Compatibility amount forwarded to the authorization
    ///        source. The FROST allowlist ignores it.
    /// @param rewardMultiplier Compatibility reward multiplier forwarded to the
    ///        authorization source. The FROST allowlist ignores it.
    /// @param notifier Address of the misbehavior notifier.
    /// @param walletID ID of the wallet.
    /// @param walletMembersIDs Identifiers of the wallet signing group members.
    /// @dev Requirements:
    ///      - The expression `keccak256(abi.encode(walletMembersIDs))` must
    ///        be exactly the same as the hash stored under `membersIdsHash`
    ///        for the given `walletID`. Those IDs are not directly stored
    ///        in the contract for gas efficiency purposes but they can be
    ///        read from appropriate `DkgResultSubmitted` and `DkgResultApproved`
    ///        events.
    ///      - `rewardMultiplier` must be between [0, 100].
    ///      - This function reverts if the authorization source call reverts.
    ///        The calling code needs to handle the potential revert.
    function seize(
        uint96 amount,
        uint256 rewardMultiplier,
        address notifier,
        bytes32 walletID,
        uint32[] calldata walletMembersIDs
    ) external onlyLifecycleOwner {
        bytes32 memberIdsHash = wallets.getWalletMembersIdsHash(walletID);
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
            stakingProvidersAddresses[i] = operatorToStakingProvider(
                groupMembersAddresses[i]
            );
        }

        _currentAuthorizationSource().reportMaliciousBehavior(
            amount,
            rewardMultiplier,
            notifier,
            stakingProvidersAddresses
        );
    }

    /// @notice Checks if DKG result is valid for the current DKG.
    /// @param result DKG result.
    /// @return True if the result is valid. If the result is invalid it returns
    ///         false and an error message.
    function isDkgResultValid(DKG.Result calldata result)
        external
        view
        returns (bool, string memory)
    {
        return dkg.isResultValid(result);
    }

    /// @notice Check current wallet creation state.
    function getWalletCreationState() external view returns (DKG.State) {
        return dkg.currentState();
    }

    /// @notice Checks whether the given operator is a member of the given
    ///         wallet signing group.
    /// @param walletID ID of the wallet.
    /// @param walletMembersIDs Identifiers of the wallet signing group members.
    /// @param operator Address of the checked operator.
    /// @param walletMemberIndex Position of the operator in the wallet signing
    ///        group members list.
    /// @return True - if the operator is a member of the given wallet signing
    ///         group. False - otherwise.
    /// @dev Requirements:
    ///      - The `operator` parameter must be an actual sortition pool operator.
    ///      - The expression `keccak256(abi.encode(walletMembersIDs))` must
    ///        be exactly the same as the hash stored under `membersIdsHash`
    ///        for the given `walletID`. Those IDs are not directly stored
    ///        in the contract for gas efficiency purposes but they can be
    ///        read from appropriate `DkgResultSubmitted` and `DkgResultApproved`
    ///        events.
    ///      - The `walletMemberIndex` must be in range [1, walletMembersIDs.length]
    function isWalletMember(
        bytes32 walletID,
        uint32[] calldata walletMembersIDs,
        address operator,
        uint256 walletMemberIndex
    ) external view returns (bool) {
        return
            Inactivity.isWalletMember(
                wallets,
                sortitionPool,
                walletID,
                walletMembersIDs,
                operator,
                walletMemberIndex
            );
    }

    /// @notice Checks if awaiting seed timed out.
    /// @return True if awaiting seed timed out, false otherwise.
    function hasSeedTimedOut() external view returns (bool) {
        return dkg.hasSeedTimedOut();
    }

    /// @notice Checks if DKG timed out. The DKG timeout period includes time required
    ///         for off-chain protocol execution and time for the result publication
    ///         for all group members. After this time result cannot be submitted
    ///         and DKG can be notified about the timeout.
    /// @return True if DKG timed out, false otherwise.
    function hasDkgTimedOut() external view returns (bool) {
        return dkg.hasDkgTimedOut();
    }

    function getWallet(bytes32 walletID)
        external
        view
        returns (FrostRegistryWallets.Wallet memory)
    {
        FrostRegistryWallets.Wallet storage wallet = wallets.registry[walletID];
        if (wallet.xOnlyOutputKey == bytes32(0)) {
            return wallets.archived[walletID];
        }
        return wallet;
    }

    /// @notice Gets the FROST x-only Taproot output key (BIP-340)
    ///         for a wallet with the given wallet ID. The walletID
    ///         is itself the x-only output key for FROST wallets,
    ///         so this view is effectively an existence check +
    ///         identity echo.
    /// @param walletID ID of the wallet (== x-only output key).
    /// @return The 32-byte x-only Taproot output key.
    function getWalletXOnlyOutputKey(bytes32 walletID)
        external
        view
        returns (bytes32)
    {
        return wallets.getWalletXOnlyOutputKey(walletID);
    }

    /// @notice Checks if a wallet with the given ID is registered.
    /// @param walletID Wallet's ID.
    /// @return True if wallet is registered, false otherwise.
    function isWalletRegistered(bytes32 walletID) external view returns (bool) {
        return wallets.isWalletRegistered(walletID);
    }

    /// @notice The minimum authorization amount required so that an operator
    ///         can participate in FROST wallet operations.
    function minimumAuthorization() external view returns (uint96) {
        return authorization.parameters.minimumAuthorization;
    }

    /// @notice Returns the current value of the provider's eligible
    ///         authorization. Eligible authorization is defined as the current
    ///         authorization weight minus the pending authorization decrease.
    ///         This value is used for the operator's weight in the sortition
    ///         pool. If it is below the minimum authorization, eligible
    ///         authorization is 0.
    function eligibleStake(address stakingProvider)
        external
        view
        returns (uint96)
    {
        return
            authorization.eligibleStake(
                _currentAuthorizationSource(),
                stakingProvider
            );
    }

    /// @notice Returns the amount of rewards available for withdrawal for the
    ///         given staking provider. Reverts if staking provider has not
    ///         registered the operator address.
    function availableRewards(address stakingProvider)
        external
        view
        returns (uint96)
    {
        address operator = stakingProviderToOperator(stakingProvider);
        require(operator != address(0), "Unknown operator");
        return sortitionPool.getAvailableRewards(operator);
    }

    /// @notice Returns the amount of authorization weight that is pending
    ///         decrease for the given staking provider. If no authorization
    ///         decrease has been requested, returns zero.
    function pendingAuthorizationDecrease(address stakingProvider)
        external
        view
        returns (uint96)
    {
        return authorization.pendingAuthorizationDecrease(stakingProvider);
    }

    /// @notice Returns the remaining time in seconds that needs to pass before
    ///         the requested authorization decrease can be approved.
    ///         If the sortition pool state was not updated yet by the operator
    ///         after requesting the authorization decrease, returns
    ///         `type(uint64).max`.
    function remainingAuthorizationDecreaseDelay(address stakingProvider)
        external
        view
        returns (uint64)
    {
        return
            authorization.remainingAuthorizationDecreaseDelay(stakingProvider);
    }

    /// @notice Returns operator registered for the given staking provider.
    function stakingProviderToOperator(address stakingProvider)
        public
        view
        returns (address)
    {
        return authorization.stakingProviderToOperator[stakingProvider];
    }

    /// @notice Returns staking provider of the given operator.
    function operatorToStakingProvider(address operator)
        public
        view
        returns (address)
    {
        return authorization.operatorToStakingProvider[operator];
    }

    /// @notice Checks if the operator's authorization is in sync with the
    ///         operator's weight in the sortition pool.
    ///         If the operator is not in the sortition pool and their
    ///         authorization weight is non-zero, function returns false.
    function isOperatorUpToDate(address operator) external view returns (bool) {
        return
            authorization.isOperatorUpToDate(
                _currentAuthorizationSource(),
                sortitionPool,
                operator
            );
    }

    function _currentAuthorizationSource()
        internal
        view
        returns (IFrostAuthorizationSource)
    {
        require(
            address(authorizationSource) != address(0),
            "Authorization source is not initialized"
        );
        return authorizationSource;
    }

    /// @notice Returns true if the given operator is in the sortition pool.
    ///         Otherwise, returns false.
    function isOperatorInPool(address operator) external view returns (bool) {
        return sortitionPool.isOperatorInPool(operator);
    }

    /// @notice Selects a new group of operators. Can only be called when DKG
    ///         is in progress and the pool is locked.
    ///         At least one operator has to be registered in the pool,
    ///         otherwise the function fails reverting the transaction.
    /// @return IDs of selected group members.
    function selectGroup() external view returns (uint32[] memory) {
        return sortitionPool.selectGroup(DKG.groupSize, bytes32(dkg.seed));
    }

    /// @notice Retrieves dkg parameters that were set in DKG library.
    function dkgParameters() external view returns (DKG.Parameters memory) {
        return dkg.parameters;
    }

    /// @notice Returns authorization-related parameters.
    /// @dev The minimum authorization is also returned by `minimumAuthorization()`
    ///      function, as a requirement of `IApplication` interface.
    /// @return minimumAuthorization The minimum authorization amount required
    ///         so that operator can participate in the random beacon. This
    ///         amount is required to execute slashing for providing a malicious
    ///         DKG result or when a relay entry times out.
    /// @return authorizationDecreaseDelay Delay in seconds that needs to pass
    ///         between the time authorization decrease is requested and the
    ///         time that request gets approved. Protects against free-riders
    ///         earning rewards and not being active in the network.
    /// @return authorizationDecreaseChangePeriod Authorization decrease change
    ///         period in seconds. It is the time, before authorization decrease
    ///         delay end, during which the pending authorization decrease
    ///         request can be overwritten.
    ///         If set to 0, pending authorization decrease request can not be
    ///         overwritten until the entire `authorizationDecreaseDelay` ends.
    ///         If set to value equal `authorizationDecreaseDelay`, request can
    ///         always be overwritten.
    function authorizationParameters()
        external
        view
        returns (
            uint96 minimumAuthorization,
            uint64 authorizationDecreaseDelay,
            uint64 authorizationDecreaseChangePeriod
        )
    {
        return (
            authorization.parameters.minimumAuthorization,
            authorization.parameters.authorizationDecreaseDelay,
            authorization.parameters.authorizationDecreaseChangePeriod
        );
    }

    /// @notice Retrieves reward-related parameters.
    /// @return maliciousDkgResultNotificationRewardMultiplier Compatibility
    ///         multiplier forwarded to the authorization source's malicious
    ///         behavior hook.
    /// @return sortitionPoolRewardsBanDuration Duration of the sortition pool
    ///         rewards ban imposed on operators who missed their turn for DKG
    ///         result submission or who failed a heartbeat.
    function rewardParameters()
        external
        view
        returns (
            uint256 maliciousDkgResultNotificationRewardMultiplier,
            uint256 sortitionPoolRewardsBanDuration
        )
    {
        return (
            _maliciousDkgResultNotificationRewardMultiplier,
            _sortitionPoolRewardsBanDuration
        );
    }

    /// @notice Retrieves slashing-related parameters.
    /// @return maliciousDkgResultSlashingAmount Slashing amount for submitting
    ///         a malicious DKG result. Every DKG result submitted can be
    ///         challenged for the time of `dkg.resultChallengePeriodLength`.
    ///         If the DKG result submitted is challenged and proven to be
    ///         malicious, the operator who submitted the malicious result is
    ///         slashed for `_maliciousDkgResultSlashingAmount`.
    function slashingParameters()
        external
        view
        returns (uint96 maliciousDkgResultSlashingAmount)
    {
        return _maliciousDkgResultSlashingAmount;
    }

    /// @notice Retrieves gas-related parameters.
    /// @return dkgResultSubmissionGas Calculated max gas cost for submitting
    ///         a DKG result. This will be refunded as part of the DKG approval
    ///         process. It is in the submitter's interest to not skip his
    ///         priority turn on the approval, otherwise the refund of the DKG
    ///         submission will be refunded to another group member that will
    ///         call the DKG approve function.
    /// @return dkgResultApprovalGasOffset Gas that is meant to balance the DKG
    ///         result approval's overall cost. It can be updated by the
    ///         governance based on the current market conditions.
    /// @return notifyOperatorInactivityGasOffset Gas that is meant to balance
    ///         the notification of an operator inactivity. It can be updated by
    ///         the governance based on the current market conditions.
    /// @return notifySeedTimeoutGasOffset Gas that is meant to balance the
    ///         notification of a seed for DKG delivery timeout. It can be updated
    ///         by the governance based on the current market conditions.
    /// @return notifyDkgTimeoutNegativeGasOffset Gas that is meant to balance
    ///         the notification of a DKG protocol execution timeout. It can be
    ///         updated by the governance based on the current market conditions.
    function gasParameters()
        external
        view
        returns (
            uint256 dkgResultSubmissionGas,
            uint256 dkgResultApprovalGasOffset,
            uint256 notifyOperatorInactivityGasOffset,
            uint256 notifySeedTimeoutGasOffset,
            uint256 notifyDkgTimeoutNegativeGasOffset
        )
    {
        return (
            _dkgResultSubmissionGas,
            _dkgResultApprovalGasOffset,
            _notifyOperatorInactivityGasOffset,
            _notifySeedTimeoutGasOffset,
            _notifyDkgTimeoutNegativeGasOffset
        );
    }
}
