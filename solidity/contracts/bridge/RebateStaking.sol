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
import "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";


/// @title Contract for staking T token to get rebate on minting/redemption fees
contract RebateStaking is Initializable, OwnableUpgradeable {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    struct Rebate {
        uint32 timestamp;
        uint64 feeRebate;

        // Reserved storage space in case we need to add more variables.
        // The convention from OpenZeppelin suggests the storage space should
        // add up to 50 slots. Here we want to have more slots as there are
        // planned upgrades of the Bridge contract. If more entires are added to
        // the struct in the upcoming versions we need to reduce the array size.
        // See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
        // slither-disable-next-line unused-state
        uint256[50] __gap;
    }

    struct Stake {
        uint96 stakedAmount;
        uint96 unstakingAmount;
        uint32 unstakingTimestamp;

        uint256 rollingWindowStartIndex;
        Rebate[] rebates;
    }

    IERC20Upgradeable public token;
    address public bridge;
    
    uint256 public rollingWindow;
    uint256 public unstakingPeriod;
    uint256 public rebatePerToken;

    mapping(address => Stake) public stakes;

    // Reserved storage space in case we need to add more variables.
    // The convention from OpenZeppelin suggests the storage space should
    // add up to 50 slots. Here we want to have more slots as there are
    // planned upgrades of the Bridge contract. If more entires are added to
    // the struct in the upcoming versions we need to reduce the array size.
    // See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
    // slither-disable-next-line unused-state
    uint256[50] private __gap;

    event RollingWindowUpdated(uint256 rollingWindow);
    event UnstakingPeriodUpdated(uint256 unstakingPeriod);
    event RebatePerTokenUpdated(uint256 rebatePerToken);
    event RebateReceived(address staker, uint64 rebate);
    event RebateCanceled(address staker, uint256 requestedAt);
    event Staked(address staker, uint256 amount);
    event UnstakeStarted(address staker, uint256 amount);
    event UnstakeFinished(address staker, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    modifier onlyBridge() {
        require(msg.sender == address(bridge), "Caller is not the bridge");
        _;
    }

    /// @dev Initializes upgradable contract on deployment.
    function initialize(
        address _bridge,
        address _token,
        uint256 _rollingWindow,
        uint256 _unstakingPeriod,
        uint256 _rebatePerToken
    ) external initializer {
        require(
            _bridge != address(0) && 
            _token != address(0) && 
            _rollingWindow != 0, 
            "Parameters cannot be zero"
        );
        bridge = _bridge;
        token = IERC20Upgradeable(_token);
        rollingWindow = _rollingWindow;
        unstakingPeriod = _unstakingPeriod;
        rebatePerToken = _rebatePerToken;

        __Ownable_init();
    }

    /// @notice Updates the rolling window.
    /// @param _newRollingWindow Duration of the rolling window.
    /// @dev Requirements:
    ///      - The caller must be the contract owner,
    ///      - The new rolling window cannot be zero
    function updateRollingWindow(uint256 _newRollingWindow) external onlyOwner {
        require(
            _newRollingWindow != 0, 
            "Rolling window cannot be zero"
        );
        rollingWindow = _newRollingWindow;
        emit RollingWindowUpdated(rollingWindow);
    }

    /// @notice Updates the unstaking period.
    /// @param _newUnstakingPeriod Duration of the unstaking period.
    /// @dev Requirements:
    ///      - The caller must be the contract owner
    function updateUnstakingPeriod(uint256 _newUnstakingPeriod) external onlyOwner {
        unstakingPeriod = _newUnstakingPeriod;
        emit UnstakingPeriodUpdated(unstakingPeriod);

    }

    /// @notice Updates the rebate per token.
    /// @param _newRebatePerToken Rebate coefficient.
    /// @dev Requirements:
    ///      - The caller must be the contract owner
    function updateRebatePerToken(uint256 _newRebatePerToken) external onlyOwner {
        rebatePerToken = _newRebatePerToken;
        emit RebatePerTokenUpdated(rebatePerToken);
    }

    /// @notice Calculates cap for rebate for the specified user.
    /// @param user Address of depositor or redeemer
    function getRebateCap(address user) external view returns(uint64) {
        Stake storage stakeInfo = stakes[user];
        return getRebateCap(stakeInfo);
    }
    
    /// @notice Calculates cap for rebate for the specified user.
    /// @param stakeInfo Staker struct
    function getRebateCap(Stake storage stakeInfo) internal view returns(uint64) {
        if (rebatePerToken == 0) {
            return 0;
        }
        return SafeCastUpgradeable.toUint64(stakeInfo.stakedAmount / rebatePerToken);
    }

    /// @notice Calculates available rebate for the specified user.
    /// @param user Address of depositor or redeemer
    function getAvailableRebate(address user) external view returns(uint64 rebateInWindow) {
        Stake storage stakeInfo = stakes[user];
        uint64 rebateCap = getRebateCap(stakeInfo);
        if (rebateCap == 0) {
            return 0;
        }

        if (stakeInfo.rebates.length == 0) {
            return rebateCap;
        }

        /* solhint-disable-next-line not-rely-on-time */
        uint256 windowStart = block.timestamp - rollingWindow;
        for (uint256 i = stakeInfo.rollingWindowStartIndex; i < stakeInfo.rebates.length; i++) {
            Rebate storage rebate = stakeInfo.rebates[i];
            if (rebate.timestamp >= windowStart) {
                rebateInWindow += rebate.feeRebate;
            }
        }

        return rebateCap - rebateInWindow;
    }

    /// @notice Calculates used rebate in the rolling window.
    /// @param stakeInfo Staker struct
    /// @return rebateInWindow Used rebate in the rolling window
    function getRebateInRollingWindow(Stake storage stakeInfo) internal returns(uint64 rebateInWindow) {
        if (stakeInfo.rebates.length == 0) {
            return 0;
        }

        /* solhint-disable-next-line not-rely-on-time */
        uint256 windowStart = block.timestamp - rollingWindow;
        for (uint256 i = stakeInfo.rollingWindowStartIndex; i < stakeInfo.rebates.length; i++) {
            Rebate storage rebate = stakeInfo.rebates[i];
            if (rebate.timestamp < windowStart) {
                stakeInfo.rollingWindowStartIndex++;
            } else {
                rebateInWindow += rebate.feeRebate;
            }
        }

        return rebateInWindow;
    }

    /// @notice Checks if user is eligible for rebate
    /// @param user Address of depositor or redeemer
    /// @param treasuryFee Original fees
    /// @return Updated fees considering rebate if applicable
    /// @dev Requirements:
    ///      - The caller must be the bridge contract
    function applyForRebate(address user, uint64 treasuryFee) external onlyBridge returns (uint64) {
        Stake storage stakeInfo = stakes[user];
        
        uint64 rebateCap = getRebateCap(stakeInfo);
        if (rebateCap == 0) {
            return treasuryFee;
        }

        uint64 currentRebate = getRebateInRollingWindow(stakeInfo);
        if (rebateCap <= currentRebate) {
            return treasuryFee;
        }
        uint64 rebate = rebateCap - currentRebate;
        if (rebate > treasuryFee) {
            rebate = treasuryFee;
        }

        Rebate storage value = stakeInfo.rebates.push();
        /* solhint-disable-next-line not-rely-on-time */
        value.timestamp = uint32(block.timestamp);
        value.feeRebate = rebate;
        emit RebateReceived(user, rebate);
        return treasuryFee - rebate;
    }

    /// @notice Cancels rebate in case of reedem request was timed out
    /// @param user Address of depositor or redeemer
    /// @param requestedAt Timestamp when redeem was requested
    /// @dev Requirements:
    ///      - The caller must be the bridge contract
    function cancelRebate(address user, uint256 requestedAt) external onlyBridge {
        Stake storage stakeInfo = stakes[user];
        if (stakeInfo.stakedAmount == 0) {
            return;
        }

        /* solhint-disable-next-line not-rely-on-time */
        uint256 windowStart = block.timestamp - rollingWindow;
        for (uint256 i = stakeInfo.rollingWindowStartIndex; i < stakeInfo.rebates.length; i++) {
            Rebate storage rebate = stakeInfo.rebates[i];
            if (rebate.timestamp > requestedAt) {
                break;
            } else if (rebate.timestamp < windowStart) {
                stakeInfo.rollingWindowStartIndex++;
            } else if (requestedAt == rebate.timestamp) {
                rebate.feeRebate = 0;
                emit RebateCanceled(user, requestedAt);
                break;
            }
        }
    }

    /// @notice Stake T token to be eligible for rebate
    /// @param amount Amount of tokens to stake
    function stake(uint96 amount) external {
        Stake storage stakeInfo = stakes[msg.sender];
        stakeInfo.stakedAmount += amount;

        emit Staked(msg.sender, amount);
        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Start unstaking process
    /// @param amount Amount of tokens to unstake
    function startUnstaking(uint96 amount) external {
        require(amount > 0, "Amount cannot be 0");
        Stake storage stakeInfo = stakes[msg.sender];
        require(stakeInfo.unstakingTimestamp == 0, "Unstaking already started");
        require(amount <= stakeInfo.stakedAmount, "Amount is too big");
        /* solhint-disable-next-line not-rely-on-time */
        stakeInfo.unstakingTimestamp = uint32(block.timestamp);
        stakeInfo.unstakingAmount = amount;
        emit UnstakeStarted(msg.sender, amount);
    }

    /// @notice Finalize unstaking and withdraw tokens
    function finalizeUnstaking() external {
        Stake storage stakeInfo = stakes[msg.sender];
        require(
            stakeInfo.unstakingTimestamp > 0, 
            "No unstaking process"
        );
        require(
            /* solhint-disable-next-line not-rely-on-time */
            stakeInfo.unstakingTimestamp + unstakingPeriod <= block.timestamp, 
            "No finished unstaking process"
        );
        
        stakeInfo.stakedAmount -= stakeInfo.unstakingAmount;
        uint96 amount = stakeInfo.unstakingAmount;
        stakeInfo.unstakingTimestamp = 0;
        stakeInfo.unstakingAmount = 0;
        
        emit UnstakeFinished(msg.sender, amount);
        token.safeTransfer(msg.sender, amount);
    }

    /// @notice Returns size of rebate array
    /// @param user Address of depositor or redeemer
    function getRebateLength(address user) external view returns(uint256) {
        return stakes[user].rebates.length;
    }

    /// @notice Returns timestamp and amount of rebate
    /// @param user Address of depositor or redeemer
    /// @param index Index of the element in the array
    /// @return timestamp Timestamp of rebate
    /// @return feeRebate Amount of rebate
    function getRebate(address user, uint256 index) external view returns(uint32 timestamp, uint64 feeRebate) {
        Rebate storage rebateInfo = stakes[user].rebates[index];
        timestamp = rebateInfo.timestamp;
        feeRebate = rebateInfo.feeRebate;
    }

    /// @notice Returns information about stake
    /// @param user Address of depositor or redeemer
    /// @return stakedAmount Amount of stake
    function getStake(address user) external view returns(uint96 stakedAmount) {
        Stake storage stakeInfo = stakes[user];
        stakedAmount = stakeInfo.stakedAmount;
    }

    /// @notice Returns information about unstaking
    /// @param user Address of depositor or redeemer
    /// @return unstakingAmount Amount that is currently unstaking
    /// @return unstakingTimestamp Amount of rebate
    function getUnstakingAmount(address user) external view returns(uint96 unstakingAmount, uint32 unstakingTimestamp) {
        Stake storage stakeInfo = stakes[user];
        unstakingAmount = stakeInfo.unstakingAmount;
        unstakingTimestamp = stakeInfo.unstakingTimestamp;
    }
}
