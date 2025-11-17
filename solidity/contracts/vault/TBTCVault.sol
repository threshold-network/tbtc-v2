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

import "./IVault.sol";
import "./TBTCOptimisticMinting.sol";
import "../bank/Bank.sol";
import "../token/TBTC.sol";

/// @title TBTC application vault
/// @notice TBTC is a fully Bitcoin-backed ERC-20 token pegged to the price of
///         Bitcoin. It facilitates Bitcoin holders to act on the Ethereum
///         blockchain and access the decentralized finance (DeFi) ecosystem.
///         TBTC Vault mints and unmints TBTC based on Bitcoin balances in the
///         Bank.
/// @dev TBTC Vault is the owner of TBTC token contract and is the only contract
///      minting the token.
contract TBTCVault is IVault, Ownable, TBTCOptimisticMinting {
    using SafeERC20 for IERC20;

    Bank public immutable bank;
    TBTC public immutable tbtcToken;

    /// @notice The address of a new TBTC vault. Set only when the upgrade
    ///         process is pending. Once the upgrade gets finalized, the new
    ///         TBTC vault will become an owner of TBTC token.
    address public newVault;
    /// @notice The timestamp at which an upgrade to a new TBTC vault was
    ///         initiated. Set only when the upgrade process is pending.
    uint256 public upgradeInitiatedTimestamp;

    event Minted(address indexed to, uint256 amount);
    event Unminted(address indexed from, uint256 amount);

    event UpgradeInitiated(address newVault, uint256 timestamp);
    event UpgradeFinalized(address newVault);

    modifier onlyBank() {
        require(msg.sender == address(bank), "Caller is not the Bank");
        _;
    }

    constructor(
        Bank _bank,
        TBTC _tbtcToken,
        Bridge _bridge
    ) TBTCOptimisticMinting(_bridge) {
        require(
            address(_bank) != address(0),
            "Bank can not be the zero address"
        );

        require(
            address(_tbtcToken) != address(0),
            "TBTC token can not be the zero address"
        );

        bank = _bank;
        tbtcToken = _tbtcToken;
    }

    /// @notice Mints the given `amount` of TBTC to the caller previously
    ///         transferring `amount / SATOSHI_MULTIPLIER` of the Bank balance
    ///         from caller to TBTC Vault. If `amount` is not divisible by
    ///         SATOSHI_MULTIPLIER, the remainder is left on the caller's
    ///         Bank balance.
    /// @dev TBTC Vault must have an allowance for caller's balance in the
    ///      Bank for at least `amount / SATOSHI_MULTIPLIER`.
    /// @param amount Amount of TBTC to mint.
    function mint(uint256 amount) external {
        (uint256 convertibleAmount, , uint256 satoshis) = amountToSatoshis(
            amount
        );

        require(
            bank.balanceOf(msg.sender) >= satoshis,
            "Amount exceeds balance in the bank"
        );
        _mint(msg.sender, convertibleAmount);
        bank.transferBalanceFrom(msg.sender, address(this), satoshis);
    }

    /// @notice Transfers `satoshis` of the Bank balance from the caller
    ///         to TBTC Vault and mints `satoshis * SATOSHI_MULTIPLIER` of TBTC
    ///         to the caller.
    /// @dev Can only be called by the Bank via `approveBalanceAndCall`.
    /// @param owner The owner who approved their Bank balance.
    /// @param satoshis Amount of satoshis used to mint TBTC.
    function receiveBalanceApproval(
        address owner,
        uint256 satoshis,
        bytes calldata
    ) external override onlyBank {
        require(
            bank.balanceOf(owner) >= satoshis,
            "Amount exceeds balance in the bank"
        );
        _mint(owner, satoshis * SATOSHI_MULTIPLIER);
        bank.transferBalanceFrom(owner, address(this), satoshis);
    }

    /// @notice Mints the same amount of TBTC as the deposited satoshis amount
    ///         multiplied by SATOSHI_MULTIPLIER for each depositor in the array.
    ///         Can only be called by the Bank after the Bridge swept deposits
    ///         and Bank increased balance for the vault.
    /// @dev Fails if `depositors` array is empty. Expects the length of
    ///      `depositors` and `depositedSatoshiAmounts` is the same.
    function receiveBalanceIncrease(
        address[] calldata depositors,
        uint256[] calldata depositedSatoshiAmounts
    ) external override onlyBank {
        require(depositors.length != 0, "No depositors specified");
        for (uint256 i = 0; i < depositors.length; i++) {
            address depositor = depositors[i];
            uint256 satoshis = depositedSatoshiAmounts[i];
            _mint(
                depositor,
                repayOptimisticMintingDebt(
                    depositor,
                    satoshis * SATOSHI_MULTIPLIER
                )
            );
        }
    }

    /// @notice Burns `amount` of TBTC from the caller's balance and transfers
    ///         `amount / SATOSHI_MULTIPLIER` back to the caller's balance in
    ///         the Bank. If `amount` is not divisible by SATOSHI_MULTIPLIER,
    ///         the remainder is left on the caller's account.
    /// @dev Caller must have at least `amount` of TBTC approved to
    ///       TBTC Vault.
    /// @param amount Amount of TBTC to unmint.
    function unmint(uint256 amount) external {
        (uint256 convertibleAmount, , ) = amountToSatoshis(amount);

        _unmint(msg.sender, convertibleAmount);
    }

    /// @notice Burns `amount` of TBTC from the caller's balance and transfers
    ///        `amount / SATOSHI_MULTIPLIER` of Bank balance to the Bridge
    ///         requesting redemption based on the provided `redemptionData`.
    ///         If `amount` is not divisible by SATOSHI_MULTIPLIER, the
    ///         remainder is left on the caller's account.
    /// @dev Caller must have at least `amount` of TBTC approved to
    ///       TBTC Vault.
    /// @param amount Amount of TBTC to unmint and request to redeem in Bridge.
    /// @param redemptionData Redemption data in a format expected from
    ///        `redemptionData` parameter of Bridge's `receiveBalanceApproval`
    ///        function.
    function unmintAndRedeem(uint256 amount, bytes calldata redemptionData)
        external
    {
        (uint256 convertibleAmount, , ) = amountToSatoshis(amount);

        _unmintAndRedeem(msg.sender, convertibleAmount, redemptionData);
    }

    /// @notice Burns `amount` of TBTC from the caller's balance. If `extraData`
    ///         is empty, transfers `amount` back to the caller's balance in the
    ///         Bank. If `extraData` is not empty, requests redemption in the
    ///         Bridge using the `extraData` as a `redemptionData` parameter to
    ///         Bridge's `receiveBalanceApproval` function.
    ///         If `amount` is not divisible by SATOSHI_MULTIPLIER, the
    ///         remainder is left on the caller's account. Note that it may
    ///         left a token approval equal to the remainder.
    /// @dev This function is doing the same as `unmint` or `unmintAndRedeem`
    ///      (depending on `extraData` parameter) but it allows to execute
    ///      unminting without a separate approval transaction. The function can
    ///      be called only via `approveAndCall` of TBTC token.
    /// @param from TBTC token holder executing unminting.
    /// @param amount Amount of TBTC to unmint.
    /// @param token TBTC token address.
    /// @param extraData Redemption data in a format expected from
    ///        `redemptionData` parameter of Bridge's `receiveBalanceApproval`
    ///        function. If empty, `receiveApproval` is not requesting a
    ///        redemption of Bank balance but is instead performing just TBTC
    ///        unminting to a Bank balance.
    function receiveApproval(
        address from,
        uint256 amount,
        address token,
        bytes calldata extraData
    ) external {
        require(token == address(tbtcToken), "Token is not TBTC");
        require(msg.sender == token, "Only TBTC caller allowed");
        (uint256 convertibleAmount, , ) = amountToSatoshis(amount);
        if (extraData.length == 0) {
            _unmint(from, convertibleAmount);
        } else {
            _unmintAndRedeem(from, convertibleAmount, extraData);
        }
    }

    /// @notice Initiates vault upgrade process. The upgrade process needs to be
    ///         finalized with a call to `finalizeUpgrade` function after the
    ///         `UPGRADE_GOVERNANCE_DELAY` passes. Only the governance can
    ///         initiate the upgrade.
    /// @param _newVault The new vault address.
    function initiateUpgrade(address _newVault) external onlyOwner {
        require(_newVault != address(0), "New vault address cannot be zero");
        /* solhint-disable-next-line not-rely-on-time */
        emit UpgradeInitiated(_newVault, block.timestamp);
        /* solhint-disable-next-line not-rely-on-time */
        upgradeInitiatedTimestamp = block.timestamp;
        newVault = _newVault;
    }

    /// @notice Allows the governance to finalize vault upgrade process. The
    ///         upgrade process needs to be first initiated with a call to
    ///         `initiateUpgrade` and the `GOVERNANCE_DELAY` needs to pass.
    ///         Once the upgrade is finalized, the new vault becomes the owner
    ///         of the TBTC token and receives the whole Bank balance of this
    ///         vault.
    function finalizeUpgrade()
        external
        onlyOwner
        onlyAfterGovernanceDelay(upgradeInitiatedTimestamp)
    {
        emit UpgradeFinalized(newVault);
        // slither-disable-next-line reentrancy-no-eth
        tbtcToken.transferOwnership(newVault);
        bank.transferBalance(newVault, bank.balanceOf(address(this)));
        newVault = address(0);
        upgradeInitiatedTimestamp = 0;
    }

    /// @notice Allows the governance of the TBTCVault to recover any ERC20
    ///         token sent mistakenly to the TBTC token contract address.
    /// @param token Address of the recovered ERC20 token contract.
    /// @param recipient Address the recovered token should be sent to.
    /// @param amount Recovered amount.
    function recoverERC20FromToken(
        IERC20 token,
        address recipient,
        uint256 amount
    ) external onlyOwner {
        tbtcToken.recoverERC20(token, recipient, amount);
    }

    /// @notice Allows the governance of the TBTCVault to recover any ERC721
    ///         token sent mistakenly to the TBTC token contract address.
    /// @param token Address of the recovered ERC721 token contract.
    /// @param recipient Address the recovered token should be sent to.
    /// @param tokenId Identifier of the recovered token.
    /// @param data Additional data.
    function recoverERC721FromToken(
        IERC721 token,
        address recipient,
        uint256 tokenId,
        bytes calldata data
    ) external onlyOwner {
        tbtcToken.recoverERC721(token, recipient, tokenId, data);
    }

    /// @notice Allows the governance of the TBTCVault to recover any ERC20
    ///         token sent - mistakenly or not - to the vault address. This
    ///         function should be used to withdraw TBTC v1 tokens transferred
    ///         to TBTCVault as a result of VendingMachine > TBTCVault upgrade.
    /// @param token Address of the recovered ERC20 token contract.
    /// @param recipient Address the recovered token should be sent to.
    /// @param amount Recovered amount.
    function recoverERC20(
        IERC20 token,
        address recipient,
        uint256 amount
    ) external onlyOwner {
        token.safeTransfer(recipient, amount);
    }

    /// @notice Allows the governance of the TBTCVault to recover any ERC721
    ///         token sent mistakenly to the vault address.
    /// @param token Address of the recovered ERC721 token contract.
    /// @param recipient Address the recovered token should be sent to.
    /// @param tokenId Identifier of the recovered token.
    /// @param data Additional data.
    function recoverERC721(
        IERC721 token,
        address recipient,
        uint256 tokenId,
        bytes calldata data
    ) external onlyOwner {
        token.safeTransferFrom(address(this), recipient, tokenId, data);
    }

    /// @notice Returns the amount of TBTC to be minted/unminted, the remainder,
    ///         and the Bank balance to be transferred for the given mint/unmint.
    ///         Note that if the `amount` is not divisible by SATOSHI_MULTIPLIER,
    ///         the remainder is left on the caller's account when minting or
    ///         unminting.
    /// @return convertibleAmount Amount of TBTC to be minted/unminted.
    /// @return remainder Not convertible remainder if amount is not divisible
    ///         by SATOSHI_MULTIPLIER.
    /// @return satoshis Amount in satoshis - the Bank balance to be transferred
    ///         for the given mint/unmint
    function amountToSatoshis(uint256 amount)
        public
        view
        returns (
            uint256 convertibleAmount,
            uint256 remainder,
            uint256 satoshis
        )
    {
        remainder = amount % SATOSHI_MULTIPLIER;
        convertibleAmount = amount - remainder;
        satoshis = convertibleAmount / SATOSHI_MULTIPLIER;
    }

    // slither-disable-next-line calls-loop
    function _mint(address minter, uint256 amount) internal override {
        emit Minted(minter, amount);
        tbtcToken.mint(minter, amount);
    }

    /// @dev `amount` MUST be divisible by SATOSHI_MULTIPLIER with no change.
    function _unmint(address unminter, uint256 amount) internal {
        emit Unminted(unminter, amount);
        tbtcToken.burnFrom(unminter, amount);
        bank.transferBalance(unminter, amount / SATOSHI_MULTIPLIER);
    }

    /// @dev `amount` MUST be divisible by SATOSHI_MULTIPLIER with no change.
    function _unmintAndRedeem(
        address redeemer,
        uint256 amount,
        bytes calldata redemptionData
    ) internal {
        emit Unminted(redeemer, amount);
        tbtcToken.burnFrom(redeemer, amount);
        bank.approveBalanceAndCall(
            address(bridge),
            amount / SATOSHI_MULTIPLIER,
            redemptionData
        );
    }
}
