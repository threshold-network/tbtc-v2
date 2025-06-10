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

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";


/// @title Contract for staking T token to get rebate on minting/redemption fees
contract RebateStaking is Initializable, OwnableUpgradeable {
    using SafeERC20 for IERC20;

    IERC20 public token;
    address public bridge;
    
    uint256 public rollingWindow;
    uint256 public unstakingPeriod;
    uint256 public rebatePerToken;

    struct Rebate {
        uint256 timestamp;
        uint256 feeRebate;
    }

    struct Stake {
        uint256 stakedAmount;
        uint256 unstakingAmount;
        uint256 unstakingTimestamp;

        uint256 rollingWindowStartIndex;
        Rebate[] rebates;
    }

    mapping(address => Stake) public stakes;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
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
        token = IERC20(_token);
        rollingWindow = _rollingWindow;
        unstakingPeriod = _unstakingPeriod;
        rebatePerToken = _rebatePerToken;

        __Ownable_init();
    }

    function updateRollingWindow(uint256 _newRollingWindow) external onlyOwner {
        require(
            _newRollingWindow != 0, 
            "Rolling window cannot be zero"
        );
        rollingWindow = _newRollingWindow;
    }

    function updateUnstakingPeriod(uint256 _newUnstakingPeriod) external onlyOwner {
        unstakingPeriod = _newUnstakingPeriod;
    }

    function updateRebatePerToken(uint256 _newRebatePerToken) external onlyOwner {
        rebatePerToken = _newRebatePerToken;
    }
    
    function getRebateCap(Stake storage stakeInfo) internal view returns(uint256) {
        return stakeInfo.stakedAmount * rebatePerToken;
    }

    function getRebateInRollingWindow(Stake storage stakeInfo) internal returns(uint256 rebateInWindow) {
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

    function checkForRebate(address user, uint256 treasuryFee) external returns (uint256) {
        require(msg.sender == bridge, "Only bridge can call this method");

        Stake storage stakeInfo = stakes[user];
        
        uint256 rebateCap = getRebateCap(stakeInfo);
        if (rebateCap == 0) {
            return treasuryFee;
        }

        uint256 currentRebate = getRebateInRollingWindow(stakeInfo);
        if (rebateCap <= currentRebate) {
            return treasuryFee;
        }
        uint256 rebate = rebateCap - currentRebate;
        if (rebate > treasuryFee) {
            rebate = treasuryFee;
        }

        stakeInfo.rebates.push(Rebate(block.timestamp, rebate));
        return treasuryFee - rebate;
    }

    function stake(uint256 amount) external {
        Stake storage stakeInfo = stakes[msg.sender];
        stakeInfo.stakedAmount += amount;

        token.safeTransferFrom(msg.sender, address(this), amount);
    }

    function startUnstaking(uint256 amount) external {
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
        uint256 amount = stakeInfo.unstakingAmount;
        stakeInfo.unstakingTimestamp = 0;
        stakeInfo.unstakingAmount = 0;
        token.safeTransfer(msg.sender, amount);
    }
}
