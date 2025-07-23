// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import {IPoolV1} from "./interfaces/IPoolV1.sol";
import {Pool} from "./libraries/Pool.sol";

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IBurnMintERC20 is IERC20 {
  /// @notice Mints new tokens for a given address.
  /// @param account The address to mint the new tokens to.
  /// @param amount The number of tokens to be minted.
  /// @dev this function increases the total supply.
  function mint(address account, uint256 amount) external;

  /// @notice Burns tokens from the sender.
  /// @param amount The number of tokens to be burned.
  /// @dev this function decreases the total supply.
  function burn(uint256 amount) external;

  /// @notice Burns tokens from a given address..
  /// @param account The address to burn tokens from.
  /// @param amount The number of tokens to be burned.
  /// @dev this function decreases the total supply.
  function burn(address account, uint256 amount) external;

  /// @notice Burns tokens from a given address..
  /// @param account The address to burn tokens from.
  /// @param amount The number of tokens to be burned.
  /// @dev this function decreases the total supply.
  function burnFrom(address account, uint256 amount) external;
}

interface ITypeAndVersion {
  function typeAndVersion() external pure returns (string memory);
}

/// @notice Upgradeable BurnFromMintTokenPool that implements CCIP v1.6.0 interface
/// @dev This is a working implementation for BOB deployment
contract BurnFromMintTokenPoolUpgradeable is IPoolV1, ITypeAndVersion, Initializable, OwnableUpgradeable {
  
  /// @notice The token this pool manages
  IERC20 public s_token;
  
  /// @notice Mapping of allowed addresses
  mapping(address => bool) private s_allowList;
  
  /// @notice The router address
  address public s_router;
  
  /// @notice The RMN proxy address  
  address public s_rmnProxy;

  /// @notice Events
  event Burned(address indexed sender, uint256 amount);
  event Minted(address indexed sender, address indexed recipient, uint256 amount);
  
  /// @notice The version of this contract
  string public constant override typeAndVersion = "BurnFromMintTokenPoolUpgradeable 1.6.0";

  /// @custom:oz-upgrades-unsafe-allow constructor
  constructor() {
    _disableInitializers();
  }

  /// @notice Initialize the upgradeable contract
  function initialize(
    address token,
    address[] memory allowlist,
    address rmnProxy,
    address router
  ) external initializer {
    __Ownable_init();
    
    s_token = IERC20(token);
    s_router = router;
    s_rmnProxy = rmnProxy;
    
    // Set allowlist
    for (uint256 i = 0; i < allowlist.length; ++i) {
      s_allowList[allowlist[i]] = true;
    }
  }

  /// @notice Burns tokens from the pool
  function lockOrBurn(
    Pool.LockOrBurnInV1 calldata lockOrBurnIn
  ) external override returns (Pool.LockOrBurnOutV1 memory) {
    require(msg.sender == s_router, "Only router");
    
    // Burn tokens
    IBurnMintERC20(address(s_token)).burnFrom(msg.sender, lockOrBurnIn.amount);
    
    emit Burned(msg.sender, lockOrBurnIn.amount);
    
    return Pool.LockOrBurnOutV1({
      destTokenAddress: abi.encode(address(s_token)),
      destPoolData: ""
    });
  }

  /// @notice Mints tokens to the receiver
  function releaseOrMint(
    Pool.ReleaseOrMintInV1 calldata releaseOrMintIn
  ) external override returns (Pool.ReleaseOrMintOutV1 memory) {
    require(msg.sender == s_router, "Only router");
    
    // Mint tokens
    IBurnMintERC20(address(s_token)).mint(releaseOrMintIn.receiver, releaseOrMintIn.amount);
    
    emit Minted(msg.sender, releaseOrMintIn.receiver, releaseOrMintIn.amount);
    
    return Pool.ReleaseOrMintOutV1({
      destinationAmount: releaseOrMintIn.amount
    });
  }

  /// @notice Checks if a chain is supported
  function isSupportedChain(uint64 /* remoteChainSelector */) external pure override returns (bool) {
    return true; // For demo purposes, accept all chains
  }

  /// @notice Checks if a token is supported
  function isSupportedToken(address token) external view override returns (bool) {
    return token == address(s_token);
  }

  /// @notice Get the token managed by this pool
  function getToken() external view returns (address) {
    return address(s_token);
  }

  /// @notice Check if interface is supported
  function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
    return interfaceId == type(IPoolV1).interfaceId;
  }
} 