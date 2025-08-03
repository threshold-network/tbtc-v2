// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.19;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";

import "./TokenPoolMutable.sol";
import "./interfaces/ITypeAndVersion.sol";

/// @notice Interface for burn/mint ERC20 tokens
interface IBurnMintERC20 is IERC20Upgradeable {
    /// @notice Mints new tokens for a given address.
    /// @param account The address to mint the new tokens to.
    /// @param amount The number of tokens to be minted.
    /// @dev this function increases the total supply.
    function mint(address account, uint256 amount) external;

    /// @notice Burns tokens from the sender.
    /// @param amount The number of tokens to be burned.
    /// @dev this function decreases the total supply.
    function burn(uint256 amount) external;

    /// @notice Burns tokens from a given address.
    /// @param account The address to burn tokens from.
    /// @param amount The number of tokens to be burned.
    /// @dev this function decreases the total supply.
    function burnFrom(address account, uint256 amount) external;
}

/**
 * @title BurnFromMintTokenPoolUpgradeable
 * @notice Upgradeable version of Chainlink CCIP BurnMintTokenPool with full functionality
 * @dev This contract provides burn/mint functionality for cross-chain token transfers with upgradeability
 * and inherits all CCIP features from TokenPoolMutable
 */
contract BurnFromMintTokenPoolUpgradeable is
    TokenPoolMutable,
    UUPSUpgradeable,
    ITypeAndVersion
{
    // ================================================================
    // │                        EVENTS                                │
    // ================================================================

    // Events are inherited from TokenPoolMutable

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
     * @param _router The address of the router contract
     */
    function initialize(
        address _token,
        uint8 _localTokenDecimals,
        address[] memory _allowlist,
        address _rmnProxy,
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
    }

    // ================================================================
    // │                    UPGRADEABILITY                            │
    // ================================================================

    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyOwner {}

    // ================================================================
    // │                    CCIP OPERATIONS                           │
    // ================================================================

    /**
     * @notice Burns tokens from the pool using CCIP struct format
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

        // Burn tokens from the sender
        IBurnMintERC20(address(token)).burnFrom(
            lockOrBurnIn.originalSender,
            lockOrBurnIn.amount
        );

        emit Burned(lockOrBurnIn.originalSender, lockOrBurnIn.amount);

        return
            Pool.LockOrBurnOutV1({
                destTokenAddress: getRemoteToken(
                    lockOrBurnIn.remoteChainSelector
                ),
                destPoolData: _encodeLocalDecimals()
            });
    }

    /**
     * @notice Mints tokens to the receiver using CCIP struct format
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

        // Mint tokens to the recipient
        IBurnMintERC20(address(token)).mint(
            releaseOrMintIn.receiver,
            localAmount
        );

        emit Minted(msg.sender, releaseOrMintIn.receiver, localAmount);

        return Pool.ReleaseOrMintOutV1({destinationAmount: localAmount});
    }

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
        return "BurnFromMintTokenPoolUpgradeable 1.5.1";
    }
}
