// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";

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
 * @notice Upgradeable version of Chainlink CCIP BurnMintTokenPool with core functionality
 * @dev This contract provides burn/mint functionality for cross-chain token transfers with upgradeability
 */
contract BurnFromMintTokenPoolUpgradeable is
    Initializable,
    OwnableUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable
{
    // ================================================================
    // │                        ERRORS                                │
    // ================================================================

    error ZeroAddressNotAllowed();
    error Unauthorized(address caller);

    // ================================================================
    // │                        EVENTS                                │
    // ================================================================

    event Burned(address indexed sender, uint256 amount);
    event Minted(
        address indexed sender,
        address indexed recipient,
        uint256 amount
    );
    event RouterUpdated(address oldRouter, address newRouter);

    // ================================================================
    // │                    STATE VARIABLES                           │
    // ================================================================

    /// @dev The bridgeable token that is managed by this pool
    IBurnMintERC20 internal token;
    /// @dev The number of decimals of the token managed by this pool
    uint8 internal tokenDecimals;
    /// @dev The address of the RMN proxy
    address internal rmnProxy;
    /// @dev The address of the router
    address internal router;

    /// @notice Type and version identifier
    string public constant typeAndVersion =
        "BurnFromMintTokenPoolUpgradeable 1.5.1";

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
     * @param _rmnProxy The address of the Risk Management Network proxy
     * @param _router The address of the router contract
     */
    function initialize(
        address _token,
        uint8 _localTokenDecimals,
        address[] memory /* _allowlist */,
        address _rmnProxy,
        address _router
    ) public initializer {
        if (_token == address(0)) revert ZeroAddressNotAllowed();
        if (_rmnProxy == address(0)) revert ZeroAddressNotAllowed();
        if (_router == address(0)) revert ZeroAddressNotAllowed();

        __Ownable_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        token = IBurnMintERC20(_token);
        rmnProxy = _rmnProxy;
        router = _router;
        tokenDecimals = _localTokenDecimals;
    }

    // ================================================================
    // │                    CCIP OPERATIONS                           │
    // ================================================================

    /**
     * @notice Burns tokens from the pool
     * @param amount The amount to burn
     */
    function lockOrBurn(uint256 amount) external nonReentrant {
        // Basic validation
        if (amount == 0) revert("Amount must be greater than 0");

        // Burn tokens from the sender
        token.burnFrom(msg.sender, amount);

        emit Burned(msg.sender, amount);
    }

    /**
     * @notice Mints tokens to the receiver
     * @param receiver The recipient address
     * @param amount The amount to mint
     */
    function releaseOrMint(
        address receiver,
        uint256 amount
    ) external nonReentrant {
        if (receiver == address(0)) revert ZeroAddressNotAllowed();
        if (amount == 0) revert("Amount must be greater than 0");

        // Mint tokens to the recipient
        token.mint(receiver, amount);

        emit Minted(msg.sender, receiver, amount);
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
     * @notice Gets the IBurnMintERC20 token that this pool can burn or mint.
     * @return token The IBurnMintERC20 token representation.
     */
    function getToken() external view returns (IBurnMintERC20) {
        return token;
    }

    /**
     * @notice Gets the RMN proxy address
     * @return rmnProxy The RMN proxy address
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
     * @notice Gets the IBurnMintERC20 token decimals on the local chain
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

    /**
     * @notice Gets the pool version
     * @return version The pool version
     */
    function version() external pure returns (string memory) {
        return "1.5.1-upgradeable";
    }
}
