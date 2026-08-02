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
import "./api/IRewardsDistributor.sol";

/// @notice Subset of the Bank interface used by the fee router. Mirrors the
///         exact signatures of `contracts/bank/Bank.sol`: `balanceOf` is the
///         public balances mapping getter and `approveBalance` follows the
///         Bank's non-atomic allowance rule (a non-zero allowance cannot be
///         overwritten with another non-zero value).
interface IFeeRouterBank {
    function approveBalance(address spender, uint256 amount) external;

    function balanceOf(address account) external view returns (uint256);
}

/// @notice Subset of the TBTC vault interface used by the fee router.
///         Mirrors `TBTCVault.mint(uint256 amount)`: `amount` is denominated
///         in TBTC (1e18 precision); the vault transfers
///         `amount / SATOSHI_MULTIPLIER` of the caller's Bank balance
///         (satoshis) to itself and mints `amount` of TBTC to the caller.
///         The vault must have a Bank balance allowance from the caller of at
///         least `amount / SATOSHI_MULTIPLIER`.
interface IFeeRouterTbtcVault {
    function mint(uint256 amount) external;
}

/// @title FeeRouter
/// @notice Collection point for tBTC protocol revenue in the delegated
///         staking module, designed to be set as the Bridge `treasury`
///         address. This is the OM-deprecation variant: with optimistic
///         minting deprecated there are exactly two revenue legs —
///         (1) Bank balance satoshis (deposit and redemption treasury fees,
///         landing at SPV proof time) and (2) ETH (confiscated challenger
///         escrow from defeated fraud challenges). Any TBTC arriving
///         directly is still handled by the split step. `distribute()`
///         converts Bank satoshis into TBTC through a single
///         `tbtcVault.mint` call (1 satoshi -> 1e10 TBTC wei), forwards
///         `rewardShareBps` of the resulting TBTC to the rewards
///         distributor, and sends the remainder plus the full ETH balance to
///         the DAO treasury. ETH is adversarial-event revenue, not a fee,
///         and is never part of the staking reward share.
contract FeeRouter is Initializable, OwnableUpgradeable {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    error ZeroAddress();
    error RewardShareBpsExceedsMax();
    error EthTransferFailed();
    error AlreadySet();
    error BankBalanceNotMigrated();
    error TbtcBalanceNotMigrated();

    /// @notice Must match `TBTCVault.SATOSHI_MULTIPLIER`: the number of TBTC
    ///         wei minted per satoshi of Bank balance.
    uint256 public constant SATOSHI_MULTIPLIER = 10**10;

    /// @notice The Bank holding this contract's satoshi-denominated fee
    ///         balance.
    IFeeRouterBank public bank;

    /// @notice The TBTC vault used to convert Bank satoshis into TBTC.
    IFeeRouterTbtcVault public tbtcVault;

    /// @notice The TBTC token.
    IERC20Upgradeable public tbtcToken;

    /// @notice The rewards distributor receiving the staking reward share.
    IRewardsDistributor public rewardsDistributor;

    /// @notice The DAO treasury receiving the non-reward TBTC remainder and
    ///         the full ETH balance.
    address public daoTreasury;

    /// @notice The governance delay applied to two-step parameter updates.
    uint64 public governanceDelay;

    /// @notice The share of distributed TBTC routed to the rewards
    ///         distributor, in basis points. Zero routes everything to the
    ///         DAO treasury.
    uint16 public rewardShareBps;

    /// @notice The pending new value of `rewardShareBps`, valid only while
    ///         `rewardShareBpsChangeInitiated` is non-zero.
    uint16 public newRewardShareBps;

    /// @notice The timestamp at which the pending `rewardShareBps` update
    ///         was initiated; zero if no update is pending.
    uint256 public rewardShareBpsChangeInitiated;

    address public newDaoTreasury;
    uint256 public daoTreasuryChangeInitiated;

    IFeeRouterBank public newBank;
    IFeeRouterTbtcVault public newTbtcVault;
    IERC20Upgradeable public newTbtcToken;
    uint256 public infrastructureChangeInitiated;

    // Reserved storage space in case we need to add more variables.
    // See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
    // slither-disable-next-line unused-state
    uint256[41] private __gap;

    event RewardShareBpsUpdateStarted(
        uint16 newRewardShareBps,
        uint256 timestamp
    );
    event RewardShareBpsUpdated(uint16 rewardShareBps);
    event DaoTreasuryUpdateStarted(address daoTreasury, uint256 timestamp);
    event DaoTreasuryUpdated(address daoTreasury);
    event RewardsDistributorSet(address rewardsDistributor);
    event InfrastructureUpdateStarted(
        address bank,
        address tbtcVault,
        address tbtcToken,
        uint256 timestamp
    );
    event InfrastructureUpdated(
        address bank,
        address tbtcVault,
        address tbtcToken
    );
    event EthDistributed(address indexed daoTreasury, uint256 amount);
    event RevenueDistributed(
        uint256 satoshisConverted,
        uint256 tbtcToRewards,
        uint256 tbtcToTreasury,
        uint256 ethToTreasury
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Accepts plain ETH transfers. The Bridge's fraud machinery
    ///         (`Fraud.sol`) forwards defeated-challenge ETH to the treasury
    ///         address with a 100k gas stipend and silently ignores failure —
    ///         this function MUST always succeed within that stipend or
    ///         confiscated ETH strands in the Bridge. It therefore does
    ///         nothing but receive.
    receive() external payable {}

    /// @notice Initializes the fee router.
    /// @param _bank Address of the Bank.
    /// @param _tbtcVault Address of the TBTC vault.
    /// @param _tbtcToken Address of the TBTC token.
    /// @param _rewardsDistributor Address of the rewards distributor.
    /// @param _daoTreasury Address of the DAO treasury.
    /// @param _rewardShareBps Initial reward share in basis points; must not
    ///        exceed 10000.
    /// @param _governanceDelay Governance delay for two-step parameter
    ///        updates.
    function initialize(
        address _bank,
        address _tbtcVault,
        address _tbtcToken,
        address _rewardsDistributor,
        address _daoTreasury,
        uint16 _rewardShareBps,
        uint64 _governanceDelay
    ) external initializer {
        if (
            _bank == address(0) ||
            _tbtcVault == address(0) ||
            _tbtcToken == address(0) ||
            _daoTreasury == address(0)
        ) {
            revert ZeroAddress();
        }
        if (_rewardShareBps > 10000) {
            revert RewardShareBpsExceedsMax();
        }

        bank = IFeeRouterBank(_bank);
        tbtcVault = IFeeRouterTbtcVault(_tbtcVault);
        tbtcToken = IERC20Upgradeable(_tbtcToken);
        rewardsDistributor = IRewardsDistributor(_rewardsDistributor);
        daoTreasury = _daoTreasury;
        rewardShareBps = _rewardShareBps;
        governanceDelay = _governanceDelay;

        __Ownable_init();
    }

    /// @notice Sets the rewards distributor after proxy deployment. Set once
    ///         to break the distributor/router initializer cycle safely.
    function setRewardsDistributor(address _rewardsDistributor)
        external
        onlyOwner
    {
        if (_rewardsDistributor == address(0)) revert ZeroAddress();
        if (address(rewardsDistributor) != address(0)) revert AlreadySet();
        rewardsDistributor = IRewardsDistributor(_rewardsDistributor);
        emit RewardsDistributorSet(_rewardsDistributor);
    }

    /// @notice Begins the two-step update of `rewardShareBps`.
    /// @param _newRewardShareBps The proposed new reward share in basis
    ///        points; must not exceed 10000.
    /// @dev Requirements:
    ///      - The caller must be the contract owner.
    function beginRewardShareBpsUpdate(uint16 _newRewardShareBps)
        external
        onlyOwner
    {
        if (_newRewardShareBps > 10000) {
            revert RewardShareBpsExceedsMax();
        }
        newRewardShareBps = _newRewardShareBps;
        /* solhint-disable-next-line not-rely-on-time */
        rewardShareBpsChangeInitiated = block.timestamp;
        /* solhint-disable-next-line not-rely-on-time */
        emit RewardShareBpsUpdateStarted(_newRewardShareBps, block.timestamp);
    }

    /// @notice Finalizes the pending `rewardShareBps` update.
    /// @dev Requirements:
    ///      - The caller must be the contract owner,
    ///      - The update must have been initiated,
    ///      - The governance delay must have elapsed.
    function finalizeRewardShareBpsUpdate() external onlyOwner {
        GovernanceUtils.onlyAfterGovernanceDelay(
            rewardShareBpsChangeInitiated,
            governanceDelay
        );
        rewardShareBps = newRewardShareBps;
        emit RewardShareBpsUpdated(newRewardShareBps);
        rewardShareBpsChangeInitiated = 0;
        newRewardShareBps = 0;
    }

    function beginDaoTreasuryUpdate(address _newDaoTreasury)
        external
        onlyOwner
    {
        if (_newDaoTreasury == address(0)) revert ZeroAddress();
        newDaoTreasury = _newDaoTreasury;
        /* solhint-disable-next-line not-rely-on-time */
        daoTreasuryChangeInitiated = block.timestamp;
        /* solhint-disable-next-line not-rely-on-time */
        emit DaoTreasuryUpdateStarted(_newDaoTreasury, block.timestamp);
    }

    function finalizeDaoTreasuryUpdate() external onlyOwner {
        GovernanceUtils.onlyAfterGovernanceDelay(
            daoTreasuryChangeInitiated,
            governanceDelay
        );
        daoTreasury = newDaoTreasury;
        emit DaoTreasuryUpdated(daoTreasury);
        daoTreasuryChangeInitiated = 0;
        newDaoTreasury = address(0);
    }

    /// @notice Begins a delayed Bank/TBTCVault/TBTC infrastructure update. A
    ///         vault swap normally retains Bank and TBTC; accepting all three
    ///         pointers also supports a coordinated infrastructure migration.
    function beginInfrastructureUpdate(
        address _newBank,
        address _newTbtcVault,
        address _newTbtcToken
    ) external onlyOwner {
        if (
            _newBank == address(0) ||
            _newTbtcVault == address(0) ||
            _newTbtcToken == address(0)
        ) {
            revert ZeroAddress();
        }
        newBank = IFeeRouterBank(_newBank);
        newTbtcVault = IFeeRouterTbtcVault(_newTbtcVault);
        newTbtcToken = IERC20Upgradeable(_newTbtcToken);
        /* solhint-disable not-rely-on-time */
        infrastructureChangeInitiated = block.timestamp;
        emit InfrastructureUpdateStarted(
            _newBank,
            _newTbtcVault,
            _newTbtcToken,
            block.timestamp
        );
        /* solhint-enable not-rely-on-time */
    }

    /// @notice Finalizes the pending infrastructure update. Changing Bank or
    ///         TBTC is allowed only after the corresponding old balance has
    ///         moved. Changing only the vault remains possible with a non-zero
    ///         Bank balance so a failed/stale vault can be recovered.
    function finalizeInfrastructureUpdate() external onlyOwner {
        GovernanceUtils.onlyAfterGovernanceDelay(
            infrastructureChangeInitiated,
            governanceDelay
        );
        if (
            address(newBank) != address(bank) &&
            bank.balanceOf(address(this)) != 0
        ) {
            revert BankBalanceNotMigrated();
        }
        if (
            address(newTbtcToken) != address(tbtcToken) &&
            tbtcToken.balanceOf(address(this)) != 0
        ) {
            revert TbtcBalanceNotMigrated();
        }
        bank = newBank;
        tbtcVault = newTbtcVault;
        tbtcToken = newTbtcToken;
        emit InfrastructureUpdated(
            address(bank),
            address(tbtcVault),
            address(tbtcToken)
        );
        infrastructureChangeInitiated = 0;
        newBank = IFeeRouterBank(address(0));
        newTbtcVault = IFeeRouterTbtcVault(address(0));
        newTbtcToken = IERC20Upgradeable(address(0));
    }

    /// @notice Distributes all revenue currently held by the router.
    ///         Permissionless. Three steps:
    ///         (1) if the router holds a Bank balance, converts it into TBTC
    ///         through `tbtcVault.mint` (1 satoshi -> 1e10 TBTC wei);
    ///         (2) splits the router's full TBTC balance: `rewardShareBps`
    ///         to the rewards distributor (transferred first, then accounted
    ///         via `notifyReward`), remainder to the DAO treasury;
    ///         ETH is deliberately handled by the independent
    ///         `distributeEth` entrypoint so a reverting treasury can never
    ///         freeze Bank conversion or TBTC distribution.
    /// @dev OM-deprecation variant: there is no separate optimistic-minting
    ///      fee leg; any TBTC arriving directly at the router is still
    ///      picked up by step (2).
    function distribute() external {
        // (1) Convert the Bank satoshi balance into TBTC. `mint` takes the
        // amount in TBTC precision and pulls the corresponding satoshis via
        // the Bank allowance approved just before. The allowance is consumed
        // exactly, so it is zero again after the call and the Bank's
        // non-atomic allowance rule does not block future distributions.
        uint256 satoshis = bank.balanceOf(address(this));
        if (satoshis > 0) {
            bank.approveBalance(address(tbtcVault), satoshis);
            tbtcVault.mint(satoshis * SATOSHI_MULTIPLIER);
        }

        // (2) Split the TBTC balance between the rewards distributor and
        // the DAO treasury.
        uint256 tbtcBalance = tbtcToken.balanceOf(address(this));
        uint256 rewardShare = 0;
        uint256 treasuryShare = 0;
        if (tbtcBalance > 0) {
            rewardShare = (tbtcBalance * rewardShareBps) / 10000;
            treasuryShare = tbtcBalance - rewardShare;
            if (rewardShare > 0) {
                tbtcToken.safeTransfer(
                    address(rewardsDistributor),
                    rewardShare
                );
                rewardsDistributor.notifyReward(rewardShare);
            }
            if (treasuryShare > 0) {
                tbtcToken.safeTransfer(daoTreasury, treasuryShare);
            }
        }

        if (satoshis > 0 || tbtcBalance > 0) {
            emit RevenueDistributed(satoshis, rewardShare, treasuryShare, 0);
        }
    }

    /// @notice Permissionlessly forwards the router's full ETH balance to the
    ///         DAO treasury. A failure affects only this ETH attempt; TBTC
    ///         distribution remains independently callable.
    function distributeEth() external {
        uint256 ethBalance = address(this).balance;
        if (ethBalance == 0) return;
        // slither-disable-next-line arbitrary-send-eth,low-level-calls
        (bool success, ) = daoTreasury.call{value: ethBalance}(""); // solhint-disable-line avoid-low-level-calls
        if (!success) revert EthTransferFailed();
        emit EthDistributed(daoTreasury, ethBalance);
    }
}
