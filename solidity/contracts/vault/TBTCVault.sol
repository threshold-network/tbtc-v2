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
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import "./IVault.sol";
import "./IAccountControlRedemptionNotifier.sol";
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
contract TBTCVault is IVault, Ownable, ReentrancyGuard, TBTCOptimisticMinting {
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

    /// @notice Optional Account Control redemption notifier. When set, every
    ///         `unmintAndRedeem` redemption reconciles AC minted exposure
    ///         through it before the redemption completes, and reverts if the
    ///         AC accounting update cannot be made. Plain `unmint` never calls
    ///         the notifier, regardless of this setting — see
    ///         `accountControlReconciliationRequired`. When unset (the
    ///         default), the `unmintAndRedeem` path behaves exactly as before.
    IAccountControlRedemptionNotifier public accountControlRedemptionNotifier;

    /// @notice When true, a legacy redemption may not proceed unless an Account
    ///         Control redemption notifier is configured, so AC-origin supply
    ///         cannot be redeemed through the legacy path without reconciliation.
    ///         Defaults to false, preserving the legacy behavior for non-AC
    ///         deployments. An Account Control deployment sets this to true once
    ///         the notifier is wired, turning the "no notifier" case from a
    ///         silent success into a revert. Set independently of the notifier
    ///         so activation is explicit and cannot be bypassed by unsetting the
    ///         notifier while the requirement stays on.
    bool public accountControlReconciliationRequired;

    event Minted(address indexed to, uint256 amount);
    event Unminted(address indexed from, uint256 amount);

    event UpgradeInitiated(address newVault, uint256 timestamp);
    event UpgradeFinalized(address newVault);

    event AccountControlRedemptionNotifierUpdated(address notifier);

    event AccountControlReconciliationRequirementUpdated(bool required);

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

    /// @notice Sets the Account Control redemption notifier used to reconcile
    ///         AC minted exposure on `unmintAndRedeem` redemptions. Set to the
    ///         zero address to disable reconciliation (the default).
    /// @param notifier Address of the notifier, or the zero address to disable.
    /// @dev Only the owner can call. The notifier is a trusted, fail-closed
    ///      protocol dependency called before every burn routed through
    ///      `unmintAndRedeem` or `receiveApproval` with redemption data. Any
    ///      notifier call failure — including a reverting implementation or an
    ///      address with no code — blocks those two entry points. This is
    ///      intentional: continuing would burn TBTC without reconciling AC
    ///      minted exposure. Plain `unmint` (and `receiveApproval` without
    ///      redemption data) never calls the notifier at all — once
    ///      `accountControlReconciliationRequired` is set, that path is
    ///      blocked outright regardless of notifier health, not conditioned on
    ///      a notifier call failing. Governance must validate, monitor, and
    ///      replace the notifier if it becomes unavailable; disabling
    ///      reconciliation is an explicit emergency acceptance of accounting
    ///      divergence, not the normal recovery path.
    function setAccountControlRedemptionNotifier(address notifier)
        external
        onlyOwner
    {
        accountControlRedemptionNotifier = IAccountControlRedemptionNotifier(
            notifier
        );
        emit AccountControlRedemptionNotifierUpdated(notifier);
    }

    /// @notice Sets whether a legacy redemption requires a configured Account
    ///         Control redemption notifier. When enabled, legacy redemptions
    ///         revert unless the notifier is set, so AC-origin supply cannot be
    ///         redeemed without reconciliation.
    /// @param required True to require the notifier, false to allow the legacy
    ///        path without one (the default).
    /// @dev Only the owner can call. Intended to be enabled by an Account
    ///      Control deployment once the notifier is wired.
    function setAccountControlReconciliationRequired(bool required)
        external
        onlyOwner
    {
        // Requiring reconciliation without a configured notifier would make
        // every legacy redemption revert. Only allow enabling the requirement
        // when a notifier is already wired; disabling it is always allowed.
        require(
            !required ||
                address(accountControlRedemptionNotifier) != address(0),
            "Notifier required to require reconciliation"
        );
        accountControlReconciliationRequired = required;
        emit AccountControlReconciliationRequirementUpdated(required);
    }

    /// @notice Activates Account Control reconciliation for `unmintAndRedeem`
    ///         redemptions in a single, safe step: wires the redemption
    ///         notifier and marks reconciliation as required. After this call
    ///         every `unmintAndRedeem` redemption reconciles AC minted
    ///         exposure (or reverts), and plain `unmint` is blocked outright,
    ///         so AC-origin supply can never be redeemed through the legacy
    ///         path without reconciliation.
    /// @param notifier Address of the Account Control redemption notifier. Must
    ///        be nonzero.
    /// @dev Only the owner can call. This is the activation entry point an
    ///      Account Control deployment must invoke before any AC-origin supply
    ///      can exist, so the finding's exploit path (redeeming AC-origin supply
    ///      through the legacy route while `AccountControlState.minted` stays
    ///      unchanged) is closed. Requiring a nonzero notifier makes activation
    ///      atomic and correct-by-construction: unlike calling the two setters
    ///      separately, it cannot leave the vault in the inconsistent
    ///      "required but no notifier" state that reverts every
    ///      `unmintAndRedeem` redemption. Once active, unsetting the notifier
    ///      later keeps the requirement on, so those redemptions revert rather
    ///      than silently bypassing AC accounting, while plain `unmint` stays
    ///      blocked regardless.
    function activateAccountControlReconciliation(address notifier)
        external
        onlyOwner
    {
        require(
            notifier != address(0),
            "Notifier required to activate reconciliation"
        );

        accountControlRedemptionNotifier = IAccountControlRedemptionNotifier(
            notifier
        );
        accountControlReconciliationRequired = true;

        emit AccountControlRedemptionNotifierUpdated(notifier);
        emit AccountControlReconciliationRequirementUpdated(true);
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
    // reason: parameter name `owner` follows ERC-20 approval convention; it intentionally shadows Ownable.owner() with no re-entrance risk
    // slither-disable-next-line shadowing-local
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
            // Sweep proceeds repay optimistic debt first, then migration debt.
            // Any remainder is minted as TBTC for the depositor.
            uint256 amountAfterOptimisticDebt = repayOptimisticMintingDebt(
                depositor,
                satoshis * SATOSHI_MULTIPLIER
            );
            _mint(
                depositor,
                repayMigrationDebt(depositor, amountAfterOptimisticDebt)
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
    function unmint(uint256 amount) external nonReentrant {
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
        nonReentrant
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
    ) external nonReentrant {
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
    /// @dev Reverts when this vault is the canonical migration debt vault and
    ///      still has outstanding migration debt. The new vault is a fresh
    ///      contract that starts with empty `migrationDebt`,
    ///      `pendingMigrationSweepCompletion`, `migrationSweepReserve`,
    ///      `isMigrationRevealer`, and `_outstandingMigrationDebtCount`
    ///      state. Transferring TBTC ownership and the Bank balance while
    ///      this state is non-empty would orphan the in-flight migration
    ///      accounting on the old vault — revealers' debt would be lost,
    ///      pending sweep callbacks would never land, and the Bridge's
    ///      canonical-vault assumptions would break. Governance must drain
    ///      migration debt (via the normal repayment / `clearMigrationDebt`
    ///      flow) and rotate the canonical pointer
    ///      (`Bridge.rotateMigrationDebtVault`) before finalizing the
    ///      upgrade.
    function finalizeUpgrade()
        external
        onlyOwner
        onlyAfterGovernanceDelay(upgradeInitiatedTimestamp)
    {
        require(
            !hasOutstandingMigrationDebt(),
            "Cannot finalize upgrade with outstanding migration debt"
        );

        // Optimistic minting debt is per-depositor local vault state repaid
        // from future sweep proceeds routed through the vault callback.
        // Transferring TBTC ownership and the Bank balance while optimistic
        // debt is outstanding would strand that debt on the old vault: a
        // deposit revealed for the old vault cannot repay the debt on the new
        // vault (sweep validation pins the recorded vault), and if the old
        // vault is later untrusted the sweep proceeds bypass the repayment
        // callback entirely, enabling a second mint for the same deposit.
        require(
            !hasOutstandingOptimisticMintingDebt(),
            "Cannot finalize upgrade with outstanding optimistic minting debt"
        );

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

    /// @notice Reconciles Account Control (AC) minted exposure for supply that
    ///         is about to be burned by the irreversible legacy redemption,
    ///         before the burn happens, so AC-origin supply can never leave AC
    ///         accounting through `_unmintAndRedeem` while
    ///         `AccountControlState.minted` stays unchanged.
    /// @dev When a notifier is configured it identifies the AC reserve behind
    ///      `redeemer` and decrements that reserve's minted exposure, reverting
    ///      the whole operation if the accounting update cannot be made. It is a
    ///      no-op for redeemers with no AC exposure, so regular unminting and
    ///      redemption are unaffected. When no notifier is configured the legacy
    ///      behaviour is preserved, unless reconciliation has been made
    ///      mandatory (an Account Control deployment), in which case the legacy
    ///      operation reverts rather than silently bypassing AC accounting.
    ///      Only called from `_unmintAndRedeem` — see `_unmint` for why plain
    ///      unmint does not call this.
    /// @param redeemer The address whose TBTC is being burned.
    /// @param amount The TBTC amount being burned, in 1e18 precision.
    function _reconcileAccountControlRedemption(
        address redeemer,
        uint256 amount
    ) internal {
        IAccountControlRedemptionNotifier notifier = (
            accountControlRedemptionNotifier
        );
        if (address(notifier) != address(0)) {
            notifier.notifyLegacyRedemption(redeemer, amount);
        } else {
            require(
                !accountControlReconciliationRequired,
                "Account Control reconciliation required"
            );
        }
    }

    /// @dev `amount` MUST be divisible by SATOSHI_MULTIPLIER with no change.
    ///      Shared by the `unmint` entry point and the empty-`extraData`
    ///      branch of `receiveApproval`.
    function _unmint(address unminter, uint256 amount) internal {
        // Unminting returns fungible Bank balance to `unminter`, and Bank
        // balance is transferable: `unminter` could hand it to another address
        // via `Bank.transferBalance`/`transferBalanceFrom`, which could then
        // remint it as TBTC through `mint`/`receiveBalanceApproval`. There is
        // no way to tag that Bank balance with the AC decrement it should owe,
        // so once reconciliation is required, a *reversible* per-unmint AC
        // decrement here could be detached from the balance it was meant to
        // track and never restored — permanently understating AC exposure.
        // Block plain unmint outright instead; `_unmintAndRedeem` remains the
        // irreversible, reconciled exit for AC-origin supply.
        require(
            !accountControlReconciliationRequired,
            "Unmint unavailable while Account Control reconciliation is required"
        );

        // Emit before the external burn/transfer calls so the event is never
        // logged after an external call. Re-entry through the vault's unmint
        // entry points is prevented by their `nonReentrant` guard.
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
        // Reconcile Account Control minted exposure for the redeemed supply
        // before it is burned, so AC-origin supply cannot be redeemed through
        // the legacy path while `AccountControlState.minted` stays unchanged.
        // Emit before the external reconciliation and burn calls so the event
        // is never logged after an external call. Reconciliation runs before
        // the burn by design; re-entry through the vault's unmint entry points
        // is prevented by their `nonReentrant` guard.
        emit Unminted(redeemer, amount);
        _reconcileAccountControlRedemption(redeemer, amount);
        tbtcToken.burnFrom(redeemer, amount);
        bank.approveBalanceAndCall(
            address(bridge),
            amount / SATOSHI_MULTIPLIER,
            redemptionData
        );
    }
}
