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

pragma solidity 0.8.17;

import "@openzeppelin/contracts/access/Ownable.sol";

import "./IReceiveBalanceApproval.sol";
import "../vault/IVault.sol";

/// @title Bitcoin Bank
/// @notice Bank is a central component tracking Bitcoin balances. Balances can
///         be transferred between balance owners, and balance owners can
///         approve their balances to be spent by others. Balances in the Bank
///         are updated for depositors who deposited their Bitcoin into the
///         Bridge and only the Bridge can increase balances.
/// @dev Bank is a governable contract and the Governance can upgrade the Bridge
///      address.
contract Bank is Ownable {
    address public bridge;

    /// @notice The balance of the given account in the Bank. Zero by default.
    mapping(address => uint256) public balanceOf;

    /// @notice The remaining amount of balance a spender will be
    ///         allowed to transfer on behalf of an owner using
    ///         `transferBalanceFrom`. Zero by default.
    mapping(address => mapping(address => uint256)) public allowance;

    /// @notice Returns the current nonce for an EIP2612 permission for the
    ///         provided balance owner to protect against replay attacks. Used
    ///         to construct an EIP2612 signature provided to the `permit`
    ///         function.
    mapping(address => uint256) public nonces;

    uint256 public immutable cachedChainId;
    bytes32 public immutable cachedDomainSeparator;

    /// @notice Returns an EIP2612 Permit message hash. Used to construct
    ///         an EIP2612 signature provided to the `permit` function.
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256(
            "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
        );

    event BalanceTransferred(
        address indexed from,
        address indexed to,
        uint256 amount
    );

    event BalanceApproved(
        address indexed owner,
        address indexed spender,
        uint256 amount
    );

    event BalanceIncreased(address indexed owner, uint256 amount);

    event BalanceDecreased(address indexed owner, uint256 amount);

    event BridgeUpdated(address newBridge);

    modifier onlyBridge() {
        require(msg.sender == address(bridge), "Caller is not the bridge");
        _;
    }

    constructor() {
        cachedChainId = block.chainid;
        cachedDomainSeparator = buildDomainSeparator();
    }

    /// @notice Allows the Governance to upgrade the Bridge address.
    /// @dev The function does not implement any governance delay and does not
    ///      check the status of the Bridge. The Governance implementation needs
    ///      to ensure all requirements for the upgrade are satisfied before
    ///      executing this function.
    ///      Requirements:
    ///      - The new Bridge address must not be zero.
    /// @param _bridge The new Bridge address.
    function updateBridge(address _bridge) external onlyOwner {
        require(_bridge != address(0), "Bridge address must not be 0x0");
        bridge = _bridge;
        emit BridgeUpdated(_bridge);
    }

    /// @notice Moves the given `amount` of balance from the caller to
    ///         `recipient`.
    /// @dev Requirements:
    ///       - `recipient` cannot be the zero address,
    ///       - the caller must have a balance of at least `amount`.
    /// @param recipient The recipient of the balance.
    /// @param amount The amount of the balance transferred.
    function transferBalance(address recipient, uint256 amount) external {
        _transferBalance(msg.sender, recipient, amount);
    }

    /// @notice Sets `amount` as the allowance of `spender` over the caller's
    ///         balance. Does not allow updating an existing allowance to
    ///         a value that is non-zero to avoid someone using both the old and
    ///         the new allowance by unfortunate transaction ordering. To update
    ///         an allowance to a non-zero value please set it to zero first or
    ///         use `increaseBalanceAllowance` or `decreaseBalanceAllowance` for
    ///         an atomic update.
    /// @dev If the `amount` is set to `type(uint256).max`,
    ///      `transferBalanceFrom` will not reduce an allowance.
    /// @param spender The address that will be allowed to spend the balance.
    /// @param amount The amount the spender is allowed to spend.
    function approveBalance(address spender, uint256 amount) external {
        require(
            amount == 0 || allowance[msg.sender][spender] == 0,
            "Non-atomic allowance change not allowed"
        );
        _approveBalance(msg.sender, spender, amount);
    }

    /// @notice Sets the `amount` as an allowance of a smart contract `spender`
    ///         over the caller's balance and calls the `spender` via
    ///         `receiveBalanceApproval`.
    /// @dev If the `amount` is set to `type(uint256).max`, the potential
    ///     `transferBalanceFrom` executed in `receiveBalanceApproval` of
    ///      `spender` will not reduce an allowance. Beware that changing an
    ///      allowance with this function brings the risk that `spender` may use
    ///      both the old and the new allowance by unfortunate transaction
    ///      ordering. Please use `increaseBalanceAllowance` and
    ///      `decreaseBalanceAllowance` to eliminate the risk.
    /// @param spender The smart contract that will be allowed to spend the
    ///        balance.
    /// @param amount The amount the spender contract is allowed to spend.
    /// @param extraData Extra data passed to the `spender` contract via
    ///        `receiveBalanceApproval` call.
    function approveBalanceAndCall(
        address spender,
        uint256 amount,
        bytes calldata extraData
    ) external {
        _approveBalance(msg.sender, spender, amount);
        IReceiveBalanceApproval(spender).receiveBalanceApproval(
            msg.sender,
            amount,
            extraData
        );
    }

    /// @notice Atomically increases the caller's balance allowance granted to
    ///         `spender` by the given `addedValue`.
    /// @param spender The spender address for which the allowance is increased.
    /// @param addedValue The amount by which the allowance is increased.
    function increaseBalanceAllowance(address spender, uint256 addedValue)
        external
    {
        _approveBalance(
            msg.sender,
            spender,
            allowance[msg.sender][spender] + addedValue
        );
    }

    /// @notice Atomically decreases the caller's balance allowance granted to
    ///         `spender` by the given `subtractedValue`.
    /// @dev Requirements:
    ///      - `spender` must not be the zero address,
    ///      - the current allowance for `spender` must not be lower than
    ///        the `subtractedValue`.
    /// @param spender The spender address for which the allowance is decreased.
    /// @param subtractedValue The amount by which the allowance is decreased.
    function decreaseBalanceAllowance(address spender, uint256 subtractedValue)
        external
    {
        uint256 currentAllowance = allowance[msg.sender][spender];
        require(
            currentAllowance >= subtractedValue,
            "Can not decrease balance allowance below zero"
        );
        unchecked {
            _approveBalance(
                msg.sender,
                spender,
                currentAllowance - subtractedValue
            );
        }
    }

    /// @notice Moves `amount` of balance from `spender` to `recipient` using the
    ///         allowance mechanism. `amount` is then deducted from the caller's
    ///         allowance unless the allowance was made for `type(uint256).max`.
    /// @dev Requirements:
    ///      - `recipient` cannot be the zero address,
    ///      - `spender` must have a balance of at least `amount`,
    ///      - the caller must have an allowance for `spender`'s balance of at
    ///        least `amount`.
    /// @param spender The address from which the balance is transferred.
    /// @param recipient The address to which the balance is transferred.
    /// @param amount The amount of balance that is transferred.
    function transferBalanceFrom(
        address spender,
        address recipient,
        uint256 amount
    ) external {
        uint256 currentAllowance = allowance[spender][msg.sender];
        if (currentAllowance != type(uint256).max) {
            require(
                currentAllowance >= amount,
                "Transfer amount exceeds allowance"
            );
            unchecked {
                _approveBalance(spender, msg.sender, currentAllowance - amount);
            }
        }
        _transferBalance(spender, recipient, amount);
    }

    /// @notice An EIP2612 approval made with secp256k1 signature. Users can
    ///         authorize a transfer of their balance with a signature
    ///         conforming to the EIP712 standard, rather than an on-chain
    ///         transaction from their address. Anyone can submit this signature
    ///         on the user's behalf by calling the `permit` function, paying
    ///         gas fees, and possibly performing other actions in the same
    ///         transaction.
    /// @dev The deadline argument can be set to `type(uint256).max to create
    ///      permits that effectively never expire.  If the `amount` is set
    ///      to `type(uint256).max` then `transferBalanceFrom` will not
    ///      reduce an allowance. Beware that changing an allowance with this
    ///      function brings the risk that someone may use both the old and the
    ///      new allowance by unfortunate transaction ordering. Please use
    ///      `increaseBalanceAllowance` and `decreaseBalanceAllowance` to
    ///      eliminate the risk.
    /// @param owner The balance owner who signed the permission.
    /// @param spender The address that will be allowed to spend the balance.
    /// @param amount The amount the spender is allowed to spend.
    /// @param deadline The UNIX time until which the permit is valid.
    /// @param v V part of the permit signature.
    /// @param r R part of the permit signature.
    /// @param s S part of the permit signature.
    function permit(
        address owner,
        address spender,
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        /* solhint-disable-next-line not-rely-on-time */
        require(deadline >= block.timestamp, "Permission expired");

        // Validate `s` and `v` values for a malleability concern described in EIP2.
        // Only signatures with `s` value in the lower half of the secp256k1
        // curve's order and `v` value of 27 or 28 are considered valid.
        require(
            uint256(s) <=
                0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0,
            "Invalid signature 's' value"
        );
        require(v == 27 || v == 28, "Invalid signature 'v' value");

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        PERMIT_TYPEHASH,
                        owner,
                        spender,
                        amount,
                        nonces[owner]++,
                        deadline
                    )
                )
            )
        );
        address recoveredAddress = ecrecover(digest, v, r, s);
        require(
            recoveredAddress != address(0) && recoveredAddress == owner,
            "Invalid signature"
        );
        _approveBalance(owner, spender, amount);
    }

    /// @notice Increases balances of the provided `recipients` by the provided
    ///         `amounts`. Can only be called by the Bridge.
    /// @dev Requirements:
    ///       - length of `recipients` and `amounts` must be the same,
    ///       - none of `recipients` addresses must point to the Bank.
    /// @param recipients Balance increase recipients.
    /// @param amounts Amounts by which balances are increased.
    function increaseBalances(
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external onlyBridge {
        require(
            recipients.length == amounts.length,
            "Arrays must have the same length"
        );
        for (uint256 i = 0; i < recipients.length; i++) {
            _increaseBalance(recipients[i], amounts[i]);
        }
    }

    /// @notice Increases balance of the provided `recipient` by the provided
    ///         `amount`. Can only be called by the Bridge.
    /// @dev Requirements:
    ///      - `recipient` address must not point to the Bank.
    /// @param recipient Balance increase recipient.
    /// @param amount Amount by which the balance is increased.
    function increaseBalance(address recipient, uint256 amount)
        external
        onlyBridge
    {
        _increaseBalance(recipient, amount);
    }

    /// @notice Increases the given smart contract `vault`'s balance and
    ///         notifies the `vault` contract about it.
    ///         Can be called only by the Bridge.
    /// @dev Requirements:
    ///       - `vault` must implement `IVault` interface,
    ///       - length of `recipients` and `amounts` must be the same.
    /// @param vault Address of `IVault` recipient contract.
    /// @param recipients Balance increase recipients.
    /// @param amounts Amounts by which balances are increased.
    function increaseBalanceAndCall(
        address vault,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external onlyBridge {
        require(
            recipients.length == amounts.length,
            "Arrays must have the same length"
        );
        uint256 totalAmount = 0;
        for (uint256 i = 0; i < amounts.length; i++) {
            totalAmount += amounts[i];
        }
        _increaseBalance(vault, totalAmount);
        IVault(vault).receiveBalanceIncrease(recipients, amounts);
    }

    /// @notice Decreases caller's balance by the provided `amount`. There is no
    ///         way to restore the balance so do not call this function unless
    ///         you really know what you are doing!
    /// @dev Requirements:
    ///      - The caller must have a balance of at least `amount`.
    /// @param amount The amount by which the balance is decreased.
    function decreaseBalance(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        emit BalanceDecreased(msg.sender, amount);
    }

    /// @notice Returns hash of EIP712 Domain struct with `TBTC Bank` as
    ///         a signing domain and Bank contract as a verifying contract.
    ///         Used to construct an EIP2612 signature provided to the `permit`
    ///         function.
    /* solhint-disable-next-line func-name-mixedcase */
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        // As explained in EIP-2612, if the DOMAIN_SEPARATOR contains the
        // chainId and is defined at contract deployment instead of
        // reconstructed for every signature, there is a risk of possible replay
        // attacks between chains in the event of a future chain split.
        // To address this issue, we check the cached chain ID against the
        // current one and in case they are different, we build domain separator
        // from scratch.
        if (block.chainid == cachedChainId) {
            return cachedDomainSeparator;
        } else {
            return buildDomainSeparator();
        }
    }

    function _increaseBalance(address recipient, uint256 amount) internal {
        require(
            recipient != address(this),
            "Can not increase balance for Bank"
        );
        balanceOf[recipient] += amount;
        emit BalanceIncreased(recipient, amount);
    }

    function _transferBalance(
        address spender,
        address recipient,
        uint256 amount
    ) private {
        require(
            recipient != address(0),
            "Can not transfer to the zero address"
        );
        require(
            recipient != address(this),
            "Can not transfer to the Bank address"
        );

        uint256 spenderBalance = balanceOf[spender];
        require(spenderBalance >= amount, "Transfer amount exceeds balance");
        unchecked {
            balanceOf[spender] = spenderBalance - amount;
        }
        balanceOf[recipient] += amount;
        emit BalanceTransferred(spender, recipient, amount);
    }

    function _approveBalance(
        address owner,
        address spender,
        uint256 amount
    ) private {
        require(spender != address(0), "Can not approve to the zero address");
        allowance[owner][spender] = amount;
        emit BalanceApproved(owner, spender, amount);
    }

    function buildDomainSeparator() private view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256(
                        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                    ),
                    keccak256(bytes("TBTC Bank")),
                    keccak256(bytes("1")),
                    block.chainid,
                    address(this)
                )
            );
    }
}
