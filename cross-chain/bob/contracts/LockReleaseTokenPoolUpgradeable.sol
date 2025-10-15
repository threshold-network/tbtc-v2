// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.19;

import "./interfaces/ILiquidityContainer.sol";
import "./interfaces/ITypeAndVersion.sol";

import "./libraries/Pool.sol";
import "./TokenPoolUpgradeable.sol";

import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

/// @title LockReleaseTokenPoolUpgradeable
/// @notice Upgradeable version of Chainlink CCIP LockReleaseTokenPool with full functionality
/// @dev This contract provides lock/release functionality for cross-chain token transfers with upgradeability
/// and inherits all CCIP features from TokenPoolUpgradeable
contract LockReleaseTokenPoolUpgradeable is
    TokenPoolUpgradeable,
    ILiquidityContainer,
    ITypeAndVersion
{
    using SafeERC20Upgradeable for IERC20Upgradeable;

    error InsufficientLiquidity();
    error LiquidityNotAccepted();

    event LiquidityTransferred(address indexed from, uint256 amount);

    string public constant override typeAndVersion =
        "LockReleaseTokenPool 1.6.0";

    /// @dev Flag indicating if the pool can accept external liquidity
    bool internal acceptLiquidity;
    /// @dev Address of the re'balancer that can manage liquidity
    address internal rebalancer;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes the contract with the given parameters
    /// @param _token The token this pool will manage
    /// @param _localTokenDecimals The number of decimals the token uses
    /// @param _allowlist The list of allowed addresses (if empty, pool is permissionless)
    /// @param _rmnProxy The address of the Risk Management Network proxy
    /// @param _acceptLiquidity Whether the pool can accept external liquidity
    /// @param _router The address of the router contract
    function initialize(
        address _token,
        uint8 _localTokenDecimals,
        address[] memory _allowlist,
        address _rmnProxy,
        bool _acceptLiquidity,
        address _router
    ) public initializer {
        _initializeTokenPool(
            IERC20Upgradeable(_token),
            _localTokenDecimals,
            _allowlist,
            _rmnProxy,
            _router
        );
        acceptLiquidity = _acceptLiquidity;
    }

    /// @notice Locks tokens in the pool using CCIP struct format
    /// @param lockOrBurnIn The CCIP lock or burn input struct
    /// @return lockOrBurnOut The CCIP lock or burn output struct
    function lockOrBurn(
        Pool.LockOrBurnInV1 calldata lockOrBurnIn
    ) external virtual override returns (Pool.LockOrBurnOutV1 memory) {
        _validateLockOrBurn(lockOrBurnIn);

        emit Locked(msg.sender, lockOrBurnIn.amount);

        return
            Pool.LockOrBurnOutV1({
                destTokenAddress: getRemoteToken(
                    lockOrBurnIn.remoteChainSelector
                ),
                destPoolData: _encodeLocalDecimals()
            });
    }

    /// @notice Releases tokens from the pool using CCIP struct format
    /// @param releaseOrMintIn The CCIP release or mint input struct
    /// @return releaseOrMintOut The CCIP release or mint output struct
    function releaseOrMint(
        Pool.ReleaseOrMintInV1 calldata releaseOrMintIn
    ) external virtual override returns (Pool.ReleaseOrMintOutV1 memory) {
        _validateReleaseOrMint(releaseOrMintIn);

        // Calculate the local amount
        uint256 localAmount = _calculateLocalAmount(
            releaseOrMintIn.amount,
            _parseRemoteDecimals(releaseOrMintIn.sourcePoolData)
        );

        // Release to the recipient
        getToken().safeTransfer(releaseOrMintIn.receiver, localAmount);

        emit Released(msg.sender, releaseOrMintIn.receiver, localAmount);

        return Pool.ReleaseOrMintOutV1({destinationAmount: localAmount});
    }

    /// @notice Checks if the contract supports an interface
    /// @param interfaceId The interface identifier
    /// @return True if the contract supports the interface, false otherwise
    function supportsInterface(
        bytes4 interfaceId
    ) public pure virtual override returns (bool) {
        return
            interfaceId == type(ILiquidityContainer).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    /// @notice Gets rebalancer, can be address(0) if none is configured.
    /// @return The current liquidity manager.
    function getRebalancer() external view returns (address) {
        return rebalancer;
    }

    /// @notice Sets the LiquidityManager address.
    /// @dev Only callable by the owner.
    function setRebalancer(address _rebalancer) external onlyOwner {
        rebalancer = _rebalancer;
    }

    /// @notice Checks if the pool can accept liquidity.
    /// @return true if the pool can accept liquidity, false otherwise.
    function canAcceptLiquidity() external view returns (bool) {
        return acceptLiquidity;
    }

    /// @notice Provides liquidity to the pool
    /// @param amount The amount of tokens to provide
    function provideLiquidity(uint256 amount) external {
        if (!acceptLiquidity) revert LiquidityNotAccepted();
        if (rebalancer != msg.sender) revert Unauthorized(msg.sender);

        token.safeTransferFrom(msg.sender, address(this), amount);
        emit LiquidityAdded(msg.sender, amount);
    }

    /// @notice Withdraws liquidity from the pool
    /// @param amount The amount of tokens to withdraw
    function withdrawLiquidity(uint256 amount) external {
        if (rebalancer != msg.sender) revert Unauthorized(msg.sender);

        if (token.balanceOf(address(this)) < amount)
            revert InsufficientLiquidity();
        token.safeTransfer(msg.sender, amount);
        emit LiquidityRemoved(msg.sender, amount);
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
    function transferLiquidity(
        address from,
        uint256 amount
    ) external onlyOwner {
        LockReleaseTokenPoolUpgradeable(from).withdrawLiquidity(amount);

        emit LiquidityTransferred(from, amount);
    }

    /// @dev Reserved storage space to allow for layout changes in the future.
    // slither-disable-next-line unused-state
    uint256[50] private __gap;
}
