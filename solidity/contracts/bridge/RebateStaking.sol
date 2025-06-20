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

    IERC20Upgradeable public token;
    address public bridge;
    
    uint256 public rollingWindow;
    uint256 public unstakingPeriod;
    uint256 public rebatePerToken;

    struct Rebate {
        uint256 timestamp;
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
        uint64 stakedAmount;
        uint64 unstakingAmount;
        uint256 unstakingTimestamp;

        uint256 rollingWindowStartIndex;
        Rebate[] rebates;
    }

    mapping(address => Stake) public stakes;

    // Reserved storage space in case we need to add more variables.
    // The convention from OpenZeppelin suggests the storage space should
    // add up to 50 slots. Here we want to have more slots as there are
    // planned upgrades of the Bridge contract. If more entires are added to
    // the struct in the upcoming versions we need to reduce the array size.
    // See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
    // slither-disable-next-line unused-state
    uint256[50] __gap;

    event RollingWindowUpdated(uint256 rollingWindow);
    event UnstakingPeriodUpdated(uint256 unstakingPeriod);
    event RebatePerTokenUpdated(uint256 rebatePerToken);

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

    function getRebateCap(address user) external view returns(uint64) {
        Stake storage stakeInfo = stakes[user];
        return getRebateCap(stakeInfo);
    }
    
    function getRebateCap(Stake storage stakeInfo) internal view returns(uint64) {
        if (rebatePerToken == 0) {
            return 0;
        }
        return SafeCastUpgradeable.toUint64(stakeInfo.stakedAmount / rebatePerToken);
    }

    // TODO somehow combine with internal method
    function getAvailableRebate(address user) external view returns(uint64 rebateInWindow) {
        Stake storage stakeInfo = stakes[user];
        uint64 rebateCap = getRebateCap(stakeInfo);
        if (rebateCap == 0) {
            return 0;
        }

        if (stakeInfo.rebates.length == 0) {
            return rebateCap;
        }

        uint256 windowStart = block.timestamp - rollingWindow;
        for (uint256 i = stakeInfo.rollingWindowStartIndex; i < stakeInfo.rebates.length; i++) {
            Rebate storage rebate = stakeInfo.rebates[i];
            if (rebate.timestamp > windowStart) {
                rebateInWindow += rebate.feeRebate;
            }
        }

        return rebateCap - rebateInWindow;
    }

    function getRebateInRollingWindow(Stake storage stakeInfo) internal returns(uint64 rebateInWindow) {
        if (stakeInfo.rebates.length == 0) {
            return 0;
        }

        uint256 windowStart = block.timestamp - rollingWindow;
        for (uint256 i = stakeInfo.rollingWindowStartIndex; i < stakeInfo.rebates.length; i++) {
            Rebate storage rebate = stakeInfo.rebates[i];
            if (rebate.timestamp <= windowStart) {
                stakeInfo.rollingWindowStartIndex++;
            } else {
                rebateInWindow += rebate.feeRebate;
            }
        }

        return rebateInWindow;
    }

    function checkForRebate(address user, uint64 treasuryFee) external onlyBridge returns (uint64) {
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
        value.timestamp = block.timestamp;
        value.feeRebate = rebate;
        return treasuryFee - rebate;
    }

    function cancelRebate(address user, uint256 requestedAt) onlyBridge external {
        require(msg.sender == bridge, "Only bridge can call this method");

        Stake storage stakeInfo = stakes[user];
        if (stakeInfo.stakedAmount == 0) {
            return;
        }

        uint256 windowStart = block.timestamp - rollingWindow;
        for (uint256 i = stakeInfo.rollingWindowStartIndex; i < stakeInfo.rebates.length; i++) {
            Rebate storage rebate = stakeInfo.rebates[i];
            if (rebate.timestamp > requestedAt) {
                break;
            } else if (rebate.timestamp <= windowStart) {
                stakeInfo.rollingWindowStartIndex++;
            } else if (requestedAt == rebate.timestamp) { // TODO check if it's possible to have more than one
                rebate.feeRebate = 0;
                break;
            }
        }
    }

    function stake(uint64 amount) external {
        Stake storage stakeInfo = stakes[msg.sender];
        stakeInfo.stakedAmount += amount;

        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    function startUnstaking(uint64 amount) external {
        Stake storage stakeInfo = stakes[msg.sender];
        require(stakeInfo.unstakingTimestamp == 0, "Unstaking already started");
        require(amount <= stakeInfo.stakedAmount, "Amount is too big");
        stakeInfo.unstakingTimestamp = block.timestamp;
        stakeInfo.unstakingAmount = amount;
    }

    function finalizeUnstaking() external {
        Stake storage stakeInfo = stakes[msg.sender];
        require(
            stakeInfo.unstakingTimestamp > 0 && 
            stakeInfo.unstakingTimestamp + unstakingPeriod <= block.timestamp, 
            "Not enough time passed"
        );
        uint64 amount = stakeInfo.unstakingAmount;
        stakeInfo.unstakingTimestamp = 0;
        stakeInfo.unstakingAmount = 0;
        token.safeTransfer(msg.sender, amount);
    }
}
