// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.15;

import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/IERC721Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "./legacy/OptimismMintableUpgradableERC20.sol";

/// @title OptimismMintableUpgradableTBTC
/// @notice Canonical L2/sidechain token implementation. tBTC token is minted on
///         L1 and locked there to be moved to L2/sidechain. By deploying
///         a canonical token on each L2/sidechain, we can ensure the supply of
///         tBTC remains sacrosanct, while enabling quick, interoperable
///         cross-chain bridges and localizing ecosystem risk.
///
///         This contract is flexible enough to:
///         - Delegate minting authority to a native bridge on the chain, if
///           present.
///         - Delegate minting authority to a short list of ecosystem bridges.
///         - Have mints and burns paused by any one of n guardians, allowing
///           avoidance of contagion in case of a chain- or bridge-specific
///           incident.
///         - Be governed and upgradeable.
///
///         The token is burnable by the token holder and supports EIP2612
///         permits. Token holder can authorize a transfer of their token with
///         a signature conforming EIP712 standard instead of an on-chain
///         transaction from their address. Anyone can submit this signature on
///         the user's behalf by calling the permit function, paying gas fees,
///         and possibly performing other actions in the same transaction.
///         The governance can recover ERC20 and ERC721 tokens sent mistakenly
///         to OptimismMintableUpgradableTBTC token contract.
/// @custom:oz-upgrades-from OptimismMintableUpgradableERC20
contract OptimismMintableUpgradableTBTC is
    OptimismMintableUpgradableERC20,
    OwnableUpgradeable,
    PausableUpgradeable
{
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @notice Indicates if the given address is a minter. Only minters can
    ///         mint the token.
    mapping(address => bool) public isMinter;

    /// @notice List of all minters.
    address[] public minters;

    /// @notice Indicates if the given address is a guardian. Only guardians can
    ///         pause token mints and burns.
    mapping(address => bool) public isGuardian;

    /// @notice List of all guardians.
    address[] public guardians;

    /// @notice Tracks the remaining capacity for legacy bridge operations.
    ///         Incremented on bridge mints, decremented on bridge burns.
    uint256 public legacyCapRemaining;

    /// @dev This empty reserved space is put in place to allow future versions to add new
    ///      variables without shifting down storage in the inheritance chain.
    ///      See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
    // slither-disable-next-line unused-state
    uint256[45] private __gap;

    event MinterAdded(address indexed minter);
    event MinterRemoved(address indexed minter);

    event GuardianAdded(address indexed guardian);
    event GuardianRemoved(address indexed guardian);

    /// @dev Modifier to make a function callable only when the contract is not paused.
    /// @dev Requirements:
    ///      - The contract must not be paused.
    modifier onlyMinter() {
        require(isMinter[msg.sender], "Caller is not a minter");
        _;
    }

    /// @dev Modifier to make a function callable only when the contract is not paused.
    /// @dev Requirements:
    ///      - The contract must not be paused.
    modifier onlyGuardian() {
        require(isGuardian[msg.sender], "Caller is not a guardian");
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Adds the address to the minters list.
    /// @dev Requirements:
    ///      - The caller must be the contract owner.
    ///      - `minter` must not be a minter address already.
    /// @param minter The address to be added as a minter.
    function addMinter(address minter) external onlyOwner {
        require(!isMinter[minter], "This address is already a minter");
        isMinter[minter] = true;
        minters.push(minter);
        emit MinterAdded(minter);
    }

    /// @notice Removes the address from the minters list.
    /// @dev Requirements:
    ///      - The caller must be the contract owner.
    ///      - `minter` must be a minter address.
    /// @param minter The address to be removed from the minters list.
    function removeMinter(address minter) external onlyOwner {
        require(isMinter[minter], "This address is not a minter");
        delete isMinter[minter];

        // We do not expect too many minters so a simple loop is safe.
        for (uint256 i = 0; i < minters.length; i++) {
            if (minters[i] == minter) {
                minters[i] = minters[minters.length - 1];
                // slither-disable-next-line costly-loop
                minters.pop();
                break;
            }
        }

        emit MinterRemoved(minter);
    }

    /// @notice Adds the address to the guardians list.
    /// @dev Requirements:
    ///      - The caller must be the contract owner.
    ///      - `guardian` must not be a guardian address already.
    /// @param guardian The address to be added as a guardian.
    function addGuardian(address guardian) external onlyOwner {
        require(!isGuardian[guardian], "This address is already a guardian");
        isGuardian[guardian] = true;
        guardians.push(guardian);
        emit GuardianAdded(guardian);
    }

    /// @notice Removes the address from the guardians list.
    /// @dev Requirements:
    ///      - The caller must be the contract owner.
    ///      - `guardian` must be a guardian address.
    /// @param guardian The address to be removed from the guardians list.
    function removeGuardian(address guardian) external onlyOwner {
        require(isGuardian[guardian], "This address is not a guardian");
        delete isGuardian[guardian];

        // We do not expect too many guardians so a simple loop is safe.
        for (uint256 i = 0; i < guardians.length; i++) {
            if (guardians[i] == guardian) {
                guardians[i] = guardians[guardians.length - 1];
                // slither-disable-next-line costly-loop
                guardians.pop();
                break;
            }
        }

        emit GuardianRemoved(guardian);
    }

    /// @notice Allows the governance of the token contract to recover any ERC20
    ///         sent mistakenly to the token contract address.
    /// @param token The address of the token to be recovered.
    /// @param recipient The token recipient address that will receive recovered
    ///        tokens.
    /// @param amount The amount to be recovered.
    function recoverERC20(
        IERC20Upgradeable token,
        address recipient,
        uint256 amount
    ) external onlyOwner {
        token.safeTransfer(recipient, amount);
    }

    /// @notice Allows the governance of the token contract to recover any
    ///         ERC721 sent mistakenly to the token contract address.
    /// @param token The address of the token to be recovered.
    /// @param recipient The token recipient address that will receive the
    ///        recovered token.
    /// @param tokenId The ID of the ERC721 token to be recovered.
    function recoverERC721(
        IERC721Upgradeable token,
        address recipient,
        uint256 tokenId,
        bytes calldata data
    ) external onlyOwner {
        token.safeTransferFrom(address(this), recipient, tokenId, data);
    }

    /// @notice Allows one of the guardians to pause mints and burns allowing
    ///         avoidance of contagion in case of a chain- or bridge-specific
    ///         incident.
    /// @dev Requirements:
    ///      - The caller must be a guardian.
    ///      - The contract must not be already paused.
    function pause() external onlyGuardian {
        _pause();
    }

    /// @notice Allows the governance to unpause mints and burns previously
    ///         paused by one of the guardians.
    /// @dev Requirements:
    ///      - The caller must be the contract owner.
    ///      - The contract must be paused.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Allows one of the minters to mint `amount` tokens and assign
    ///         them to `account`, increasing the total supply. Emits
    ///         a `Transfer` event with `from` set to the zero address.
    /// @dev Requirements:
    ///      - The caller must be a minter.
    ///      - `account` must not be the zero address.
    /// @param account The address to receive tokens.
    /// @param amount The amount of token to be minted.
    function mint(
        address account,
        uint256 amount
    ) external virtual override whenNotPaused onlyMinter {
        _mint(account, amount);

        // If the minter is the standard bridge, increment legacyCapRemaining
        if (msg.sender == BRIDGE) {
            legacyCapRemaining += amount;
        }

        emit Mint(account, amount);
    }

    /// @notice Allows the StandardBridge on this network to burn tokens.
    /// @dev This overrides the burn function from OptimismMintableUpgradableERC20.
    ///      Requirements:
    ///      - The caller must be the bridge.
    ///      - legacyCapRemaining must be greater than 0.
    /// @param _from Address to burn tokens from.
    /// @param _amount Amount of tokens to burn.
    function burn(
        address _from,
        uint256 _amount
    )
        external
        virtual
        override(OptimismMintableUpgradableERC20)
        onlyBridge
        whenNotPaused
    {
        require(legacyCapRemaining > 0, "Legacy cap exhausted");
        require(
            _amount <= legacyCapRemaining,
            "Amount exceeds legacy cap remaining"
        );

        _burn(_from, _amount);

        // Decrement legacyCapRemaining on bridge burns
        legacyCapRemaining -= _amount;

        emit Burn(_from, _amount);
    }

    /// @notice Allows to fetch a list of all minters.
    function getMinters() external view returns (address[] memory) {
        return minters;
    }

    /// @notice Allows to fetch a list of all guardians.
    function getGuardians() external view returns (address[] memory) {
        return guardians;
    }

    /// @notice Allows to fetch the remaining capacity for legacy bridge operations.
    function getLegacyCapRemaining() external view returns (uint256) {
        return legacyCapRemaining;
    }

    /// @notice Destroys `amount` tokens from `account`, deducting from the
    ///         caller's allowance. Emits a `Transfer` event with `to` set to
    ///         the zero address.
    /// @dev Requirements:
    ///      - The che caller must have allowance for `accounts`'s tokens of at
    ///        least `amount`.
    ///      - `account` must not be the zero address.
    ///      - `account` must have at least `amount` tokens.
    ///      - If legacyCapRemaining > 0, only the standard bridge can burn.
    /// @param account The address owning tokens to be burned.
    /// @param amount The amount of token to be burned.
    function burnFrom(
        address account,
        uint256 amount
    ) public virtual whenNotPaused {
        // If legacyCapRemaining is above zero, only standard bridge can perform the burn
        if (legacyCapRemaining > 0) {
            require(
                msg.sender == BRIDGE,
                "Only bridge can burn while legacy cap remains"
            );
            require(
                amount <= legacyCapRemaining,
                "Amount exceeds legacy cap remaining"
            );
            legacyCapRemaining -= amount;
        }

        _spendAllowance(account, msg.sender, amount);
        _burn(account, amount);
        emit Burn(account, amount);
    }

    /// @notice Destroys `amount` tokens from the caller. Emits a `Transfer`
    ///         event with `to` set to the zero address.
    /// @dev Requirements:
    ///      - The caller must have at least `amount` tokens.
    /// @param amount The amount of token to be burned.
    function burn(uint256 amount) public virtual whenNotPaused {
        _burn(msg.sender, amount);
        emit Burn(msg.sender, amount);
    }

    /// @notice Initialize v2 of the contract with new functionality
    /// @custom:oz-upgrades-validate-as-initializer
    function initializeV2() public reinitializer(2) {
        __Ownable_init();
        __Pausable_init();

        // Set legacyCapRemaining to current total supply
        legacyCapRemaining = totalSupply();

        // Add the standard bridge as a minter
        if (!isMinter[BRIDGE]) {
            isMinter[BRIDGE] = true;
            minters.push(BRIDGE);
            emit MinterAdded(BRIDGE);
        }
    }
}
