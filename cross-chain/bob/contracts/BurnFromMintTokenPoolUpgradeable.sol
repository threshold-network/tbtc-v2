// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.19;

import "./interfaces/IBurnMintERC20Upgradeable.sol";
import "./interfaces/ITypeAndVersion.sol";

import "./libraries/Pool.sol";
import "./TokenPoolUpgradeable.sol";

import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

/// @title BurnFromMintTokenPoolUpgradeable
/// @notice Upgradeable version of Chainlink CCIP BurnMintTokenPool with full functionality
/// @dev This contract provides burn/mint functionality for cross-chain token transfers with upgradeability
/// and inherits all CCIP features from TokenPoolUpgradeable
contract BurnFromMintTokenPoolUpgradeable is
    TokenPoolUpgradeable,
    ITypeAndVersion
{
    using SafeERC20Upgradeable for IBurnMintERC20Upgradeable;

    string public constant override typeAndVersion =
        "BurnFromMintTokenPool 1.6.0";

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes the contract with the given parameters
    /// @param _token The token this pool will manage
    /// @param _localTokenDecimals The number of decimals the token uses
    /// @param _allowlist The list of allowed addresses (if empty, pool is permissionless)
    /// @param _rmnProxy The address of the Risk Management Network proxy
    /// @param _router The address of the router contract
    function initialize(
        address _token,
        uint8 _localTokenDecimals,
        address[] memory _allowlist,
        address _rmnProxy,
        address _router
    ) public initializer {
        _initializeTokenPool(
            IBurnMintERC20Upgradeable(_token),
            _localTokenDecimals,
            _allowlist,
            _rmnProxy,
            _router
        );

        // Some tokens allow burning from the sender without approval, but not all do.
        // To be safe, we approve the pool to burn from the pool.
        IBurnMintERC20Upgradeable(_token).safeIncreaseAllowance(
            address(this),
            type(uint256).max
        );
    }

    /// @notice Burns tokens from the pool using CCIP struct format
    /// @param lockOrBurnIn The CCIP lock or burn input struct
    /// @return lockOrBurnOut The CCIP lock or burn output struct
    function lockOrBurn(
        Pool.LockOrBurnInV1 calldata lockOrBurnIn
    ) external virtual override returns (Pool.LockOrBurnOutV1 memory) {
        _validateLockOrBurn(lockOrBurnIn);

        // Burn tokens from the sender
        IBurnMintERC20Upgradeable(address(token)).burnFrom(
            address(this),
            lockOrBurnIn.amount
        );

        emit Burned(msg.sender, lockOrBurnIn.amount);

        return
            Pool.LockOrBurnOutV1({
                destTokenAddress: getRemoteToken(
                    lockOrBurnIn.remoteChainSelector
                ),
                destPoolData: _encodeLocalDecimals()
            });
    }

    /// @notice Mint tokens from the pool to the recipient
    /// @dev The _validateReleaseOrMint check is an essential security check
    /// @param releaseOrMintIn The CCIP release or mint input struct
    /// @return releaseOrMintOut The CCIP release or mint output struct
    function releaseOrMint(
        Pool.ReleaseOrMintInV1 calldata releaseOrMintIn
    ) public virtual override returns (Pool.ReleaseOrMintOutV1 memory) {
        _validateReleaseOrMint(releaseOrMintIn);

        // Calculate the local amount
        uint256 localAmount = _calculateLocalAmount(
            releaseOrMintIn.amount,
            _parseRemoteDecimals(releaseOrMintIn.sourcePoolData)
        );

        // Mint tokens to the recipient
        IBurnMintERC20Upgradeable(address(token)).mint(
            releaseOrMintIn.receiver,
            localAmount
        );

        emit Minted(msg.sender, releaseOrMintIn.receiver, localAmount);

        return Pool.ReleaseOrMintOutV1({destinationAmount: localAmount});
    }

    /// @dev Reserved storage space to allow for layout changes in the future.
    // slither-disable-next-line unused-state
    uint256[50] private __gap;
}
