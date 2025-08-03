// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.19;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";

import "./TokenPoolMutable.sol";
import "./interfaces/ITypeAndVersion.sol";
import "./interfaces/ILiquidityContainer.sol";

/**
 * @title LockReleaseTokenPoolUpgradeable
 * @notice Upgradeable version of Chainlink CCIP LockReleaseTokenPool with full functionality
 * @dev This contract provides lock/release functionality for cross-chain token transfers with upgradeability
 * and inherits all CCIP features from TokenPoolMutable
 */
contract LockReleaseTokenPoolUpgradeable is
    TokenPoolMutable,
    UUPSUpgradeable,
    ITypeAndVersion,
    ILiquidityContainer
{
    // ================================================================
    // │                        ERRORS                                │
    // ================================================================

    error CannotAcceptLiquidity();
    error InsufficientLiquidity();
    error RebalancerNotSet();

    // ================================================================
    // │                        EVENTS                                │
    // ================================================================

    // Core events are inherited from TokenPoolMutable
    event LiquidityProvided(address indexed provider, uint256 amount);
    event LiquidityWithdrawn(address indexed rebalancer, uint256 amount);
    event LiquidityTransferred(
        address indexed from,
        address indexed to,
        uint256 amount
    );
    event RebalancerSet(
        address indexed oldRebalancer,
        address indexed newRebalancer
    );

    // ================================================================
    // │                    STATE VARIABLES                           │
    // ================================================================

    /// @dev Flag indicating if the pool can accept external liquidity
    bool internal acceptsLiquidity;
    /// @dev Address of the rebalancer that can manage liquidity
    address internal rebalancer;

    // ================================================================
    // │                    INITIALIZATION                            │
    // ================================================================

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the contract with the given parameters
     * @param _token The token this pool will manage
     * @param _localTokenDecimals The number of decimals the token uses
     * @param _allowlist The list of allowed addresses (if empty, pool is permissionless)
     * @param _rmnProxy The address of the Risk Management Network proxy
     * @param _canAcceptLiquidity Whether the pool can accept external liquidity
     * @param _router The address of the router contract
     */
    function initialize(
        address _token,
        uint8 _localTokenDecimals,
        address[] memory _allowlist,
        address _rmnProxy,
        bool _canAcceptLiquidity,
        address _router
    ) public initializer {
        __Ownable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        _initializeTokenPool(
            _token,
            _localTokenDecimals,
            _allowlist,
            _rmnProxy,
            _router
        );
        acceptsLiquidity = _canAcceptLiquidity;
    }

    // ================================================================
    // │                    CCIP OPERATIONS                           │
    // ================================================================

    /**
     * @notice Locks tokens in the pool using CCIP struct format
     * @param lockOrBurnIn The CCIP lock or burn input struct
     * @return lockOrBurnOut The CCIP lock or burn output struct
     */
    function lockOrBurn(
        Pool.LockOrBurnInV1 calldata lockOrBurnIn
    )
        external
        virtual
        override
        nonReentrant
        returns (Pool.LockOrBurnOutV1 memory)
    {
        _validateLockOrBurn(lockOrBurnIn);

        // Transfer tokens from the sender to this pool
        IERC20Upgradeable(address(token)).transferFrom(
            lockOrBurnIn.originalSender,
            address(this),
            lockOrBurnIn.amount
        );

        emit Locked(lockOrBurnIn.originalSender, lockOrBurnIn.amount);

        return
            Pool.LockOrBurnOutV1({
                destTokenAddress: getRemoteToken(
                    lockOrBurnIn.remoteChainSelector
                ),
                destPoolData: _encodeLocalDecimals()
            });
    }

    /**
     * @notice Releases tokens from the pool using CCIP struct format
     * @param releaseOrMintIn The CCIP release or mint input struct
     * @return releaseOrMintOut The CCIP release or mint output struct
     */
    function releaseOrMint(
        Pool.ReleaseOrMintInV1 calldata releaseOrMintIn
    )
        public
        virtual
        override
        nonReentrant
        returns (Pool.ReleaseOrMintOutV1 memory)
    {
        _validateReleaseOrMint(releaseOrMintIn);

        // Calculate the local amount
        uint256 localAmount = _calculateLocalAmount(
            releaseOrMintIn.amount,
            _parseRemoteDecimals(releaseOrMintIn.sourcePoolData)
        );

        // Transfer tokens from this pool to the recipient
        IERC20Upgradeable(address(token)).transfer(
            releaseOrMintIn.receiver,
            localAmount
        );

        emit Released(msg.sender, releaseOrMintIn.receiver, localAmount);

        return Pool.ReleaseOrMintOutV1({destinationAmount: localAmount});
    }

    // ================================================================
    // │                    LIQUIDITY MANAGEMENT                       │
    // ================================================================

    /**
     * @notice Provides liquidity to the pool
     * @param amount The amount of tokens to provide
     */
    function provideLiquidity(uint256 amount) external nonReentrant {
        if (!acceptsLiquidity) revert CannotAcceptLiquidity();
        if (amount == 0) revert("Amount must be greater than 0");

        IERC20Upgradeable(address(token)).transferFrom(
            msg.sender,
            address(this),
            amount
        );
        emit LiquidityProvided(msg.sender, amount);
    }

    /**
     * @notice Withdraws liquidity from the pool
     * @param amount The amount of tokens to withdraw
     */
    function withdrawLiquidity(uint256 amount) external nonReentrant {
        if (msg.sender != rebalancer) revert RebalancerNotSet();
        if (amount == 0) revert("Amount must be greater than 0");

        uint256 balance = IERC20Upgradeable(address(token)).balanceOf(
            address(this)
        );
        if (balance < amount) revert InsufficientLiquidity();

        IERC20Upgradeable(address(token)).transfer(rebalancer, amount);
        emit LiquidityWithdrawn(rebalancer, amount);
    }

    /**
     * @notice Transfers liquidity from another pool
     * @param from The pool to transfer liquidity from
     * @param amount The amount of tokens to transfer
     */
    function transferLiquidity(
        address from,
        uint256 amount
    ) external nonReentrant {
        if (msg.sender != rebalancer) revert RebalancerNotSet();
        if (amount == 0) revert("Amount must be greater than 0");

        IERC20Upgradeable(address(token)).transferFrom(
            from,
            address(this),
            amount
        );
        emit LiquidityTransferred(from, address(this), amount);
    }

    /**
     * @notice Sets the rebalancer address
     * @param _rebalancer The new rebalancer address (can be zero to disable)
     */
    function setRebalancer(address _rebalancer) external onlyOwner {
        // Allow setting to zero address to disable rebalancer
        address oldRebalancer = rebalancer;
        rebalancer = _rebalancer;
        emit RebalancerSet(oldRebalancer, _rebalancer);
    }

    // ================================================================
    // │                    VIEW FUNCTIONS                            │
    // ================================================================

    /**
     * @notice Gets the rebalancer address
     * @return The rebalancer address
     */
    function getRebalancer() external view returns (address) {
        return rebalancer;
    }

    /**
     * @notice Checks if the pool can accept external liquidity
     * @return True if the pool can accept external liquidity
     */
    /**
     * @notice Checks if the pool can accept external liquidity (ILiquidityContainer interface)
     * @return True if the pool can accept external liquidity
     */
    function canAcceptLiquidity() external view returns (bool) {
        return acceptsLiquidity;
    }

    // ================================================================
    // │                    UPGRADEABILITY                            │
    // ================================================================

    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyOwner {}

    // ================================================================
    // │                    UTILITY FUNCTIONS                         │
    // ================================================================

    /**
     * @notice Gets the pool version
     * @return version The pool version
     */
    function version() external pure returns (string memory) {
        return "1.5.1-upgradeable";
    }

    /**
     * @notice Gets the type and version identifier
     * @return typeAndVersion The type and version string
     */
    function typeAndVersion() external pure returns (string memory) {
        return "LockReleaseTokenPoolUpgradeable 1.5.1";
    }
}
