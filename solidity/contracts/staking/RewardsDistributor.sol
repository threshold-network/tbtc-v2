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

import "./api/IRewardsDistributor.sol";
import "./api/ISignerRegistry.sol";
import "./api/IStakeVault.sol";

/// @title RewardsDistributor
/// @notice Distributes TBTC protocol revenue across staking providers pro
///         rata to their authorization weight. The fee router notifies
///         reward tranches; a global 1e18-scaled accumulator tracks reward
///         per unit of weight, and every weight change checkpoints the
///         affected provider so rewards accrued before the change settle at
///         the old weight. Tranches notified while the total weight is zero
///         are carried as undistributed and folded into the next tranche.
///         `settleOperator` splits a provider's accrual between operator
///         commission (claimable by the registry beneficiary) and the
///         delegator share, which is transferred to the stake vault and
///         credited to the provider's pool.
contract RewardsDistributor is
    IRewardsDistributor,
    Initializable,
    OwnableUpgradeable
{
    using SafeERC20Upgradeable for IERC20Upgradeable;

    error ZeroAddress();
    error CallerNotSeatAllocator();
    error CallerNotFeeRouter();
    error CallerNotBeneficiary();
    error NothingToClaim();

    /// @notice Precision of the reward-per-weight accumulator.
    uint256 public constant ACCUMULATOR_PRECISION = 1e18;

    /// @notice The TBTC token rewards are denominated in.
    IERC20Upgradeable public tbtcToken;

    /// @notice The stake vault credited with the delegator share of settled
    ///         rewards.
    IStakeVault public stakeVault;

    /// @notice The signer registry resolving operator commission and
    ///         beneficiary.
    ISignerRegistry public signerRegistry;

    /// @notice The seat allocator; the only caller of `onWeightChanged`.
    address public seatAllocator;

    /// @notice The fee router; the only caller of `notifyReward`.
    address public feeRouter;

    /// @notice Global reward accumulator: TBTC wei per unit of weight,
    ///         scaled by `ACCUMULATOR_PRECISION`.
    uint256 public accRewardPerWeight;

    /// @notice Reward amount notified while the total weight was zero,
    ///         folded into the next tranche notified at non-zero weight.
    uint256 public undistributedRewards;

    /// @notice Sum of all providers' current weights.
    uint256 public totalWeight;

    /// @notice Current weight of each staking provider, as last reported by
    ///         the seat allocator.
    mapping(address => uint96) public weightOf;

    /// @notice Value of `accRewardPerWeight` at each provider's last
    ///         checkpoint.
    mapping(address => uint256) public weightCheckpoint;

    /// @notice Rewards settled to each provider but not yet split between
    ///         commission and the vault's self-bond/delegated pool reward.
    mapping(address => uint256) public accruedRewards;

    /// @notice Operator commission claimable by each provider's beneficiary.
    mapping(address => uint256) public operatorCommission;

    struct AccumulatorCheckpoint {
        uint64 timestamp;
        uint256 accumulator;
    }

    /// @notice Commission already attributed to each provider's unsettled
    ///         gross rewards.
    mapping(address => uint256) public accruedCommission;

    /// @notice Commission rate applying at the provider's last reward
    ///         checkpoint.
    mapping(address => uint16) public commissionCheckpointBps;
    mapping(address => bool) internal commissionCheckpointInitialized;

    /// @notice Global accumulator history used to split a provider's accrual
    ///         exactly at a noticed commission effective timestamp.
    AccumulatorCheckpoint[] internal accumulatorCheckpoints;

    // Reserved storage space in case we need to add more variables.
    // See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
    // slither-disable-next-line unused-state
    uint256[43] private __gap;

    event RewardNotified(uint256 amount, uint256 undistributedFolded);
    event WeightChanged(
        address indexed stakingProvider,
        uint96 previousWeight,
        uint96 newWeight
    );
    event OperatorSettled(
        address indexed stakingProvider,
        uint256 commission,
        uint256 poolReward
    );
    event CommissionClaimed(
        address indexed stakingProvider,
        address indexed beneficiary,
        uint256 amount
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    modifier onlySeatAllocator() {
        if (msg.sender != seatAllocator) revert CallerNotSeatAllocator();
        _;
    }

    modifier onlyFeeRouter() {
        if (msg.sender != feeRouter) revert CallerNotFeeRouter();
        _;
    }

    /// @notice Initializes the rewards distributor.
    /// @param _tbtcToken Address of the TBTC token.
    /// @param _stakeVault Address of the stake vault.
    /// @param _signerRegistry Address of the signer registry.
    /// @param _seatAllocator Address of the seat allocator.
    /// @param _feeRouter Address of the fee router.
    function initialize(
        address _tbtcToken,
        address _stakeVault,
        address _signerRegistry,
        address _seatAllocator,
        address _feeRouter
    ) external initializer {
        if (
            _tbtcToken == address(0) ||
            _stakeVault == address(0) ||
            _signerRegistry == address(0) ||
            _seatAllocator == address(0) ||
            _feeRouter == address(0)
        ) {
            revert ZeroAddress();
        }

        tbtcToken = IERC20Upgradeable(_tbtcToken);
        stakeVault = IStakeVault(_stakeVault);
        signerRegistry = ISignerRegistry(_signerRegistry);
        seatAllocator = _seatAllocator;
        feeRouter = _feeRouter;

        __Ownable_init();
    }

    /// @notice See {IRewardsDistributor-notifyReward}. The TBTC MUST already
    ///         have been transferred to the distributor before this call.
    /// @dev Callable only by the fee router. Accumulator division truncates;
    ///      the dust (less than `totalWeight` wei per tranche) stays in the
    ///      distributor's TBTC balance.
    function notifyReward(uint256 tbtcAmount) external override onlyFeeRouter {
        if (totalWeight == 0) {
            undistributedRewards += tbtcAmount;
            emit RewardNotified(tbtcAmount, 0);
            return;
        }

        uint256 folded = undistributedRewards;
        accRewardPerWeight +=
            ((tbtcAmount + folded) * ACCUMULATOR_PRECISION) /
            totalWeight;
        undistributedRewards = 0;
        _recordAccumulatorCheckpoint();
        emit RewardNotified(tbtcAmount, folded);
    }

    /// @notice See {IRewardsDistributor-onWeightChanged}. Settles the
    ///         provider's accrual at the previous weight, then records the
    ///         new weight and updates the total weight.
    /// @dev Callable only by the seat allocator.
    function onWeightChanged(address stakingProvider, uint96 newWeight)
        external
        override
        onlySeatAllocator
    {
        _checkpoint(stakingProvider);
        uint96 previousWeight = weightOf[stakingProvider];
        totalWeight = totalWeight - previousWeight + newWeight;
        weightOf[stakingProvider] = newWeight;
        emit WeightChanged(stakingProvider, previousWeight, newWeight);
    }

    /// @notice Settles the given provider's reward accrual and splits it:
    ///         `commissionBpsOf(provider)` of the accrual becomes operator
    ///         commission claimable by the beneficiary; the remainder is
    ///         transferred to the stake vault and split between the provider's
    ///         self-bond and delegated tranches. Permissionless; a no-op when
    ///         nothing has accrued.
    /// @param stakingProvider Address of the staking provider to settle.
    function settleOperator(address stakingProvider) external override {
        _checkpoint(stakingProvider);

        uint256 amount = accruedRewards[stakingProvider];
        if (amount == 0) {
            return;
        }
        accruedRewards[stakingProvider] = 0;
        uint256 commission = accruedCommission[stakingProvider];
        accruedCommission[stakingProvider] = 0;
        uint256 poolReward = amount - commission;

        operatorCommission[stakingProvider] += commission;

        if (poolReward > 0) {
            tbtcToken.safeTransfer(address(stakeVault), poolReward);
            stakeVault.creditReward(stakingProvider, poolReward);
        }

        emit OperatorSettled(stakingProvider, commission, poolReward);
    }

    /// @notice Transfers the given provider's accumulated operator
    ///         commission to the beneficiary.
    /// @param stakingProvider Address of the staking provider whose
    ///        commission is claimed.
    /// @dev Requirements:
    ///      - The caller must be the provider's beneficiary as resolved by
    ///        the signer registry,
    ///      - There must be a non-zero commission to claim.
    function claimCommission(address stakingProvider) external {
        address payable beneficiary = signerRegistry.beneficiaryOf(
            stakingProvider
        );
        if (msg.sender != beneficiary) revert CallerNotBeneficiary();

        uint256 amount = operatorCommission[stakingProvider];
        if (amount == 0) revert NothingToClaim();
        operatorCommission[stakingProvider] = 0;

        tbtcToken.safeTransfer(beneficiary, amount);
        emit CommissionClaimed(stakingProvider, beneficiary, amount);
    }

    /// @notice Returns the given provider's total pending reward: the
    ///         settled accrual plus the unsettled amount implied by the
    ///         accumulator at the provider's current weight. This is the
    ///         pre-split amount; commission is taken at settlement.
    /// @param stakingProvider Address of the staking provider.
    /// @return Pending reward in TBTC wei.
    function pendingRewardOf(address stakingProvider)
        external
        view
        returns (uint256)
    {
        return
            accruedRewards[stakingProvider] +
            ((accRewardPerWeight - weightCheckpoint[stakingProvider]) *
                weightOf[stakingProvider]) /
            ACCUMULATOR_PRECISION;
    }

    /// @dev Settles the provider's unsettled accrual at the current weight
    ///      and moves the checkpoint to the current accumulator value.
    function _checkpoint(address stakingProvider) internal {
        uint256 checkpoint = weightCheckpoint[stakingProvider];
        uint256 delta = accRewardPerWeight - checkpoint;
        uint96 weight = weightOf[stakingProvider];
        (
            uint16 baseCommissionBps,
            uint16 pendingCommissionBps,
            uint64 effectiveAt
        ) = signerRegistry.commissionScheduleOf(stakingProvider);

        uint16 previousCommissionBps = commissionCheckpointInitialized[
            stakingProvider
        ]
            ? commissionCheckpointBps[stakingProvider]
            : baseCommissionBps;
        uint16 currentCommissionBps = effectiveAt != 0 &&
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp >= effectiveAt
            ? pendingCommissionBps
            : baseCommissionBps;

        if (delta > 0 && weight > 0) {
            if (
                currentCommissionBps != previousCommissionBps &&
                effectiveAt != 0
            ) {
                uint256 boundary = _accumulatorBefore(effectiveAt);
                if (boundary < checkpoint) boundary = checkpoint;
                if (boundary > accRewardPerWeight) {
                    boundary = accRewardPerWeight;
                }

                _accrue(
                    stakingProvider,
                    ((boundary - checkpoint) * weight) / ACCUMULATOR_PRECISION,
                    previousCommissionBps
                );
                _accrue(
                    stakingProvider,
                    ((accRewardPerWeight - boundary) * weight) /
                        ACCUMULATOR_PRECISION,
                    currentCommissionBps
                );
            } else {
                _accrue(
                    stakingProvider,
                    (delta * weight) / ACCUMULATOR_PRECISION,
                    previousCommissionBps
                );
            }
        }
        // Keep the rate checkpoint current even when no rewards accrued. This
        // is required when SignerRegistry checkpoints a matured schedule just
        // before replacing it with a new declaration.
        commissionCheckpointBps[stakingProvider] = currentCommissionBps;
        commissionCheckpointInitialized[stakingProvider] = true;
        weightCheckpoint[stakingProvider] = accRewardPerWeight;
    }

    function _accrue(
        address stakingProvider,
        uint256 amount,
        uint16 commissionBps
    ) internal {
        if (amount == 0) return;
        accruedRewards[stakingProvider] += amount;
        accruedCommission[stakingProvider] += (amount * commissionBps) / 10000;
    }

    function _recordAccumulatorCheckpoint() internal {
        /* solhint-disable-next-line not-rely-on-time */
        uint64 timestamp = uint64(block.timestamp);
        uint256 length = accumulatorCheckpoints.length;
        if (
            length > 0 &&
            accumulatorCheckpoints[length - 1].timestamp == timestamp
        ) {
            accumulatorCheckpoints[length - 1].accumulator = accRewardPerWeight;
        } else {
            accumulatorCheckpoints.push(
                AccumulatorCheckpoint(timestamp, accRewardPerWeight)
            );
        }
    }

    /// @dev Returns the accumulator after the last reward notification whose
    ///      timestamp is strictly before `timestamp`. Notifications at the
    ///      effective timestamp use the newly-effective commission.
    function _accumulatorBefore(uint64 timestamp)
        internal
        view
        returns (uint256)
    {
        uint256 low = 0;
        uint256 high = accumulatorCheckpoints.length;
        while (low < high) {
            uint256 mid = (low + high) / 2;
            if (accumulatorCheckpoints[mid].timestamp < timestamp) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        return low == 0 ? 0 : accumulatorCheckpoints[low - 1].accumulator;
    }
}
