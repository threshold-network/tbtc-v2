// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import {IPoolV1} from "./interfaces/IPoolV1.sol";
import {ILiquidityContainer} from "./interfaces/ILiquidityContainer.sol";
import {Pool} from "./libraries/Pool.sol";

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ITypeAndVersion} from "./interfaces/ITypeAndVersion.sol";

/// @notice Upgradeable LockReleaseTokenPool that implements CCIP v1.6.0 interface
/// @dev This is a working implementation for BOB deployment
contract LockReleaseTokenPoolUpgradeable is
    IPoolV1,
    ILiquidityContainer,
    ITypeAndVersion,
    Initializable,
    OwnableUpgradeable
{
    using SafeERC20 for IERC20;

    /// @notice The token this pool manages
    IERC20 public s_token;

    /// @notice Mapping of allowed addresses
    mapping(address => bool) private s_allowList;

    /// @notice The router address
    address public s_router;

    /// @notice The RMN proxy address
    address public s_rmnProxy;

    /// @notice The single supported remote chain selector
    uint64 public s_supportedRemoteChainId;

    /// @notice Whether this pool accepts external liquidity
    bool public s_acceptLiquidity;

    /// @notice The address of the rebalancer
    address public s_rebalancer;

    /// @notice The version of this contract
    string public constant override typeAndVersion =
        "LockReleaseTokenPoolUpgradeable 1.6.0";

    /// @notice Errors
    error InsufficientLiquidity();
    error LiquidityNotAccepted();
    error Unauthorized(address caller);

    /// @notice Events
    event Locked(address indexed sender, uint256 amount);
    event Released(
        address indexed sender,
        address indexed recipient,
        uint256 amount
    );

    event LiquidityTransferred(address indexed from, uint256 amount);
    event RebalancerSet(address indexed rebalancer);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the upgradeable contract
    function initialize(
        address token,
        address[] memory allowlist,
        address rmnProxy,
        bool acceptLiquidity,
        address router,
        uint64 supportedRemoteChainId
    ) external initializer {
        require(router != address(0), "Router cannot be zero address");
        require(rmnProxy != address(0), "RMN proxy cannot be zero address");
        __Ownable_init();

        s_token = IERC20(token);
        s_router = router;
        s_rmnProxy = rmnProxy;
        s_acceptLiquidity = acceptLiquidity;
        s_supportedRemoteChainId = supportedRemoteChainId;

        // Set allowlist
        for (uint256 i = 0; i < allowlist.length; ++i) {
            s_allowList[allowlist[i]] = true;
        }
    }

    /// @notice Locks tokens in the pool
    /// @dev The router validation check is an essential security check
    function lockOrBurn(
        Pool.LockOrBurnInV1 calldata lockOrBurnIn
    ) external override returns (Pool.LockOrBurnOutV1 memory) {
        require(msg.sender == s_router, "Only router");

        emit Locked(msg.sender, lockOrBurnIn.amount);
        
        // Lock tokens by transferring to this contract
        s_token.safeTransferFrom(
            msg.sender,
            address(this),
            lockOrBurnIn.amount
        );

        return
            Pool.LockOrBurnOutV1({
                destTokenAddress: abi.encode(address(s_token)),
                destPoolData: ""
            });
    }

    /// @notice Releases tokens from the pool
    /// @dev The router validation check is an essential security check
    function releaseOrMint(
        Pool.ReleaseOrMintInV1 calldata releaseOrMintIn
    ) external override returns (Pool.ReleaseOrMintOutV1 memory) {
        require(msg.sender == s_router, "Only router");

        // Check if pool has sufficient liquidity
        if (s_token.balanceOf(address(this)) < releaseOrMintIn.amount) {
            revert InsufficientLiquidity();
        }

        // CEI pattern: Checks done above, Effects (event) before Interactions
        emit Released(
            msg.sender,
            releaseOrMintIn.receiver,
            releaseOrMintIn.amount
        );

        // Interactions last
        s_token.safeTransfer(releaseOrMintIn.receiver, releaseOrMintIn.amount);

        return
            Pool.ReleaseOrMintOutV1({
                destinationAmount: releaseOrMintIn.amount
            });
    }

    /// @notice Checks if a token is supported
    function isSupportedToken(
        address token
    ) external view override returns (bool) {
        return token == address(s_token);
    }

    /// @notice Get the token managed by this pool
    function getToken() external view returns (address) {
        return address(s_token);
    }

    /// @notice Check if this pool accepts external liquidity
    function canAcceptLiquidity() external view returns (bool) {
        return s_acceptLiquidity;
    }

    /// @notice Checks if a chain is supported
    function isSupportedChain(
        uint64 remoteChainSelector
    ) external view override returns (bool) {
        return remoteChainSelector == s_supportedRemoteChainId;
    }

    /// @notice Check if interface is supported
    function supportsInterface(
        bytes4 interfaceId
    ) external pure returns (bool) {
        return 
            interfaceId == type(IPoolV1).interfaceId ||
            interfaceId == type(ILiquidityContainer).interfaceId ||
            interfaceId == type(IERC165).interfaceId;
    }

    /// @notice Gets rebalancer, can be address(0) if none is configured.
    /// @return The current liquidity manager.
    function getRebalancer() external view returns (address) {
        return s_rebalancer;
    }



    /// @notice Sets the rebalancer address.
    /// @dev Only callable by the owner.
    function setRebalancer(address rebalancer) external virtual onlyOwner {
        // Zero address is intentionally allowed to disable rebalancer functionality
        // This is a valid use case for disabling the rebalancer
        s_rebalancer = rebalancer;
        emit RebalancerSet(rebalancer);
    }

    /// @notice Adds liquidity to the pool. The tokens should be approved first.
    /// @param amount The amount of liquidity to provide.
    function provideLiquidity(uint256 amount) external {
        if (!s_acceptLiquidity) revert LiquidityNotAccepted();
        if (s_rebalancer != msg.sender) revert Unauthorized(msg.sender);

        // CEI pattern: Checks done above, Effects (event) before Interactions
        emit LiquidityAdded(msg.sender, amount);
        
        // Interactions last
        s_token.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Removes liquidity from the pool. The tokens will be sent to msg.sender.
    /// @param amount The amount of liquidity to remove.
    function withdrawLiquidity(uint256 amount) external {
        if (s_rebalancer != msg.sender) revert Unauthorized(msg.sender);

        if (s_token.balanceOf(address(this)) < amount) revert InsufficientLiquidity();
        
        // CEI pattern: Checks done above, Effects (event) before Interactions
        emit LiquidityRemoved(msg.sender, amount);
        
        // Interactions last
        s_token.safeTransfer(msg.sender, amount);
    }

    /// @notice This function can be used to transfer liquidity from an older version of the pool to this pool. To do so
    /// this pool will have to be set as the rebalancer in the older version of the pool. This allows it to transfer the
    /// funds in the old pool to the new pool.
    /// @dev When upgrading a LockRelease pool, this function can be called at the same time as the pool is changed in the
    /// TokenAdminRegistry. This allows for a smooth transition of both liquidity and transactions to the new pool.
    /// Alternatively, when no multicall is available, a portion of the funds can be transferred to the new pool before
    /// changing which pool CCIP uses, to ensure both pools can operate. Then the pool should be changed in the
    /// TokenAdminRegistry, which will activate the new pool. All new transactions will use the new pool and its
    /// liquidity. Finally, the remaining liquidity can be transferred to the new pool using this function one more time.
    /// @param from The address of the old pool.
    /// @param amount The amount of liquidity to transfer.
    function transferLiquidity(address from, uint256 amount) external onlyOwner {
        require(from != address(0), "From address cannot be zero");
        require(amount > 0, "Amount must be greater than zero");
        
        // CEI pattern: Checks done above, Effects (event) before Interactions
        emit LiquidityTransferred(from, amount);
        
        // Interactions last
        LockReleaseTokenPoolUpgradeable(from).withdrawLiquidity(amount);
    }
}
