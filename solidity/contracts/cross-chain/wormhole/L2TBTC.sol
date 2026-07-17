// SPDX-License-Identifier: GPL-3.0-only

// ██████████████     ▐████▌     ██████████████
// ██████████████     ▐████▌     ██████████████
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
// ██████████████     ▐████▌     ██████████████
// ██████████████     ▐████▌     ██████████████
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌
//               ▐████▌    ▐████▌

pragma solidity ^0.8.17;

import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/draft-ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/IERC721Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";

/// @title L2TBTC
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
///         to L2TBTC token contract.
contract L2TBTC is
    ERC20Upgradeable,
    ERC20BurnableUpgradeable,
    ERC20PermitUpgradeable,
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

    event MinterAdded(address indexed minter);
    event MinterRemoved(address indexed minter);

    event GuardianAdded(address indexed guardian);
    event GuardianRemoved(address indexed guardian);

    modifier onlyMinter() {
        require(isMinter[msg.sender], "Caller is not a minter");
        _;
    }

    modifier onlyGuardian() {
        require(isGuardian[msg.sender], "Caller is not a guardian");
        _;
    }

    /// @notice Initializes the token contract.
    /// @param _name The name of the token.
    /// @param _symbol The symbol of the token, usually a shorter version of the
    ///        name.
    function initialize(string memory _name, string memory _symbol)
        external
        initializer
    {
        // OpenZeppelin upgradeable contracts documentation says:
        //
        // "Use with multiple inheritance requires special care. Initializer
        // functions are not linearized by the compiler like constructors.
        // Because of this, each __{ContractName}_init function embeds the
        // linearized calls to all parent initializers. As a consequence,
        // calling two of these init functions can potentially initialize the
        // same contract twice."
        //
        // Note that ERC20 extensions do not linearize calls to ERC20Upgradeable
        // initializer so we call all extension initializers individually. At
        // the same time, ERC20PermitUpgradeable does linearize the call to
        // EIP712Upgradeable so we are not using the unchained initializer
        // versions.
        __ERC20_init(_name, _symbol);
        __ERC20Burnable_init();
        __ERC20Permit_init(_name);
        __Ownable_init();
        __Pausable_init();
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
    function mint(address account, uint256 amount)
        external
        whenNotPaused
        onlyMinter
    {
        _mint(account, amount);
    }

    /// @notice Destroys `amount` tokens from the caller. Emits a `Transfer`
    ///         event with `to` set to the zero address.
    /// @dev Requirements:
    ///      - The caller must have at least `amount` tokens.
    /// @param amount The amount of token to be burned.
    function burn(uint256 amount) public override whenNotPaused {
        super.burn(amount);
    }

    /// @notice Destroys `amount` tokens from `account`, deducting from the
    ///         caller's allowance. Emits a `Transfer` event with `to` set to
    ///         the zero address.
    /// @dev Requirements:
    ///      - The che caller must have allowance for `accounts`'s tokens of at
    ///        least `amount`.
    ///      - `account` must not be the zero address.
    ///      - `account` must have at least `amount` tokens.
    /// @param account The address owning tokens to be burned.
    /// @param amount The amount of token to be burned.
    function burnFrom(address account, uint256 amount)
        public
        override
        whenNotPaused
    {
        super.burnFrom(account, amount);
    }

    /// @notice Allows to fetch a list of all minters.
    function getMinters() external view returns (address[] memory) {
        return minters;
    }

    /// @notice Allows to fetch a list of all guardians.
    function getGuardians() external view returns (address[] memory) {
        return guardians;
    }
}
