// SPDX-License-Identifier: MIT
pragma solidity 0.8.15;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";

/**
 * @title LockReleaseTokenPoolUpgradeable
 * @notice Upgradeable version of Chainlink CCIP LockReleaseTokenPool with core functionality
 * @dev This contract provides the core functionality for lock/release token pools with upgradeability
 */
contract LockReleaseTokenPoolUpgradeable is
    Initializable,
    OwnableUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20Upgradeable for IERC20Upgradeable;

    // ================================================================
    // │                        ERRORS                                │
    // ================================================================

    error ZeroAddressNotAllowed();
    error Unauthorized(address caller);
    error InsufficientLiquidity();
    error LiquidityNotAccepted();

    // ================================================================
    // │                        EVENTS                                │
    // ================================================================

    event Locked(address indexed sender, uint256 amount);
    event Released(
        address indexed sender,
        address indexed recipient,
        uint256 amount
    );
    event LiquidityAdded(address indexed provider, uint256 amount);
    event LiquidityRemoved(address indexed provider, uint256 amount);
    event LiquidityTransferred(address indexed from, uint256 amount);
    event RebalancerSet(address indexed rebalancer);
    event RouterUpdated(address oldRouter, address newRouter);

    // ================================================================
    // │                    STATE VARIABLES                           │
    // ================================================================

    /// @dev The bridgeable token that is managed by this pool
    IERC20Upgradeable internal token;

    /// @dev The number of decimals of the token managed by this pool
    uint8 internal tokenDecimals;

    /// @dev The address of the RMN proxy
    address internal rmnProxy;

    /// @dev The address of the router
    address internal router;

    /// @dev Whether or not the pool accepts liquidity
    bool internal acceptLiquidity;

    /// @notice The address of the rebalancer
    address internal rebalancer;

    /// @notice Type and version identifier
    string public constant typeAndVersion =
        "LockReleaseTokenPoolUpgradeable 2.0.0";

    // ================================================================
    // │                    INITIALIZATION                            │
    // ================================================================

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _token,
        uint8 _localTokenDecimals,
        address[] memory /* _allowlist */,
        address _rmnProxy,
        bool _acceptLiquidity,
        address _router
    ) public initializer {
        if (_token == address(0)) revert ZeroAddressNotAllowed();
        if (_rmnProxy == address(0)) revert ZeroAddressNotAllowed();
        if (_router == address(0)) revert ZeroAddressNotAllowed();

        __Ownable_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        token = IERC20Upgradeable(_token);
        rmnProxy = _rmnProxy;
        acceptLiquidity = _acceptLiquidity;
        router = _router;
        tokenDecimals = _localTokenDecimals;
    }

    // ================================================================
    // │                    CCIP OPERATIONS                           │
    // ================================================================

    /**
     * @notice Locks the token in the pool
     * @param amount The amount to lock
     */
    function lockOrBurn(uint256 amount) external nonReentrant {
        // Basic validation
        if (amount == 0) revert("Amount must be greater than 0");

        // Transfer tokens from sender to pool
        token.safeTransferFrom(msg.sender, address(this), amount);

        emit Locked(msg.sender, amount);
    }

    /**
     * @notice Release tokens from the pool to the recipient
     * @param receiver The recipient address
     * @param amount The amount to release
     */
    function releaseOrMint(
        address receiver,
        uint256 amount
    ) external nonReentrant {
        if (receiver == address(0)) revert ZeroAddressNotAllowed();
        if (amount == 0) revert("Amount must be greater than 0");

        // Release to the recipient
        token.safeTransfer(receiver, amount);

        emit Released(msg.sender, receiver, amount);
    }

    // ================================================================
    // │                LIQUIDITY MANAGEMENT                          │
    // ================================================================

    /**
     * @notice Adds liquidity to the pool. The tokens should be approved first.
     * @param amount The amount of liquidity to provide.
     */
    function provideLiquidity(uint256 amount) external nonReentrant {
        if (!acceptLiquidity) revert LiquidityNotAccepted();
        if (rebalancer != address(0) && msg.sender != rebalancer)
            revert Unauthorized(msg.sender);

        token.safeTransferFrom(msg.sender, address(this), amount);
        emit LiquidityAdded(msg.sender, amount);
    }

    /**
     * @notice Removed liquidity to the pool. The tokens will be sent to msg.sender.
     * @param amount The amount of liquidity to remove.
     */
    function withdrawLiquidity(uint256 amount) external nonReentrant {
        if (rebalancer != address(0) && msg.sender != rebalancer)
            revert Unauthorized(msg.sender);

        if (token.balanceOf(address(this)) < amount)
            revert InsufficientLiquidity();
        token.safeTransfer(msg.sender, amount);
        emit LiquidityRemoved(msg.sender, amount);
    }

    /**
     * @notice This function can be used to transfer liquidity from an older version of the pool to this pool
     * @param from The address of the old pool
     * @param amount The amount of liquidity to transfer
     */
    function transferLiquidity(
        address from,
        uint256 amount
    ) external onlyOwner nonReentrant {
        LockReleaseTokenPoolUpgradeable(from).withdrawLiquidity(amount);
        emit LiquidityTransferred(from, amount);
    }

    // ================================================================
    // │                REBALANCER MANAGEMENT                         │
    // ================================================================

    /**
     * @notice Gets rebalancer, can be address(0) if none is configured
     * @return The current liquidity manager
     */
    function getRebalancer() external view returns (address) {
        return rebalancer;
    }

    /**
     * @notice Sets the rebalancer address
     * @param _rebalancer The new rebalancer address (zero address disables rebalancer)
     * @dev Zero address is intentionally allowed to disable rebalancer functionality.
     *      When rebalancer is zero address, anyone can provide/withdraw liquidity (if enabled).
     *      When rebalancer is set, only the rebalancer can manage liquidity.
     */
    function setRebalancer(address _rebalancer) external onlyOwner {
        rebalancer = _rebalancer;
        emit RebalancerSet(_rebalancer);
    }

    /**
     * @notice Checks if the pool can accept liquidity
     * @return true if the pool can accept liquidity, false otherwise
     */
    function canAcceptLiquidity() external view returns (bool) {
        return acceptLiquidity;
    }

    // ================================================================
    // │                    INTERFACE SUPPORT                         │
    // ================================================================

    /**
     * @notice Check if the token is supported
     * @param _token The token address to check
     * @return bool True if the token is supported
     */
    function isSupportedToken(address _token) external view returns (bool) {
        return _token == address(token);
    }

    /**
     * @notice Gets the IERC20 token that this pool can lock or burn
     * @return token The IERC20 token representation
     */
    function getToken() external view returns (IERC20Upgradeable) {
        return token;
    }

    /**
     * @notice Get RMN proxy address
     * @return rmnProxy Address of RMN proxy
     */
    function getRmnProxy() external view returns (address) {
        return rmnProxy;
    }

    /**
     * @notice Gets the pool's Router
     * @return router The pool's Router
     */
    function getRouter() external view returns (address) {
        return router;
    }

    /**
     * @notice Sets the pool's Router
     * @param newRouter The new Router
     */
    function setRouter(address newRouter) external onlyOwner {
        if (newRouter == address(0)) revert ZeroAddressNotAllowed();
        address oldRouter = router;
        router = newRouter;
        emit RouterUpdated(oldRouter, newRouter);
    }

    /**
     * @notice Gets the IERC20 token decimals on the local chain
     */
    function getTokenDecimals() external view returns (uint8) {
        return tokenDecimals;
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

    function version() external pure returns (string memory) {
        return "2.0.0-upgradeable";
    }
}
