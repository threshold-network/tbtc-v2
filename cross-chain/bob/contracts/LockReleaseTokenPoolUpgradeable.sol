// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import {IPoolV1} from "./interfaces/IPoolV1.sol";
import {Pool} from "./libraries/Pool.sol";

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ITypeAndVersion } from "./interfaces/ITypeAndVersion.sol";

/// @notice Upgradeable LockReleaseTokenPool that implements CCIP v1.6.0 interface
/// @dev This is a working implementation for BOB deployment
contract LockReleaseTokenPoolUpgradeable is
    IPoolV1,
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

    /// @notice Whether this pool accepts external liquidity
    bool public s_acceptLiquidity;

    /// @notice Events
    event Locked(address indexed sender, uint256 amount);
    event Released(
        address indexed sender,
        address indexed recipient,
        uint256 amount
    );

    /// @notice The version of this contract
    string public constant override typeAndVersion =
        "LockReleaseTokenPoolUpgradeable 1.6.0";

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
        address router
    ) external initializer {
        require(router != address(0), "Router cannot be zero address");
        require(rmnProxy != address(0), "RMN proxy cannot be zero address");
        __Ownable_init();

        s_token = IERC20(token);
        s_router = router;
        s_rmnProxy = rmnProxy;
        s_acceptLiquidity = acceptLiquidity;

        // Set allowlist
        for (uint256 i = 0; i < allowlist.length; ++i) {
            s_allowList[allowlist[i]] = true;
        }
    }

    /// @notice Locks tokens in the pool
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
    function releaseOrMint(
        Pool.ReleaseOrMintInV1 calldata releaseOrMintIn
    ) external override returns (Pool.ReleaseOrMintOutV1 memory) {
        require(msg.sender == s_router, "Only router");

        emit Released(
            msg.sender,
            releaseOrMintIn.receiver,
            releaseOrMintIn.amount
        );
        // Release tokens by transferring from this contract
        s_token.safeTransfer(releaseOrMintIn.receiver, releaseOrMintIn.amount);

        return
            Pool.ReleaseOrMintOutV1({
                destinationAmount: releaseOrMintIn.amount
            });
    }

    /// @notice Checks if a chain is supported
    function isSupportedChain(
        uint64 /* remoteChainSelector */
    ) external pure override returns (bool) {
        return true; // For demo purposes, accept all chains
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

    /// @notice Check if interface is supported
    function supportsInterface(
        bytes4 interfaceId
    ) external pure returns (bool) {
        return interfaceId == type(IPoolV1).interfaceId;
    }
}
