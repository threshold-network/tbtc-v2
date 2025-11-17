// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@thesis/solidity-contracts/contracts/token/IReceiveApproval.sol";

import "../token/TBTC.sol";
import "../GovernanceUtils.sol";

/// @title TBTC v2 Vending Machine
/// @notice The Vending Machine is the owner of TBTC v2 token and can mint
///         TBTC v2 tokens in 1:1 ratio from TBTC v1 tokens with TBTC v1
///         deposited in the contract as collateral. TBTC v2 can be
///         unminted back to TBTC v1 with or without a fee - fee parameter is
///         controlled by the Governance. This implementation acts as a bridge
///         between TBTC v1 and TBTC v2 token, allowing to mint TBTC v2 before
///         the system is ready and fully operational without sacrificing any
///         security guarantees and decentralization of the project.
///         Vending Machine can be upgraded in a two-step, governance-controlled
///         process. The new version of the Vending Machine will receive the
///         ownership of TBTC v2 token and entire TBTC v1 balance stored as
///         collateral. It is expected that this process will be executed before
///         the v2 system launch. There is an optional unmint fee with a value
///         that can be updated in a two-step, governance-controlled process.
///         All governable parameters are controlled by two roles: update
///         initiator and finalizer. There is a separate initiator role for
///         unmint fee update and vending machine upgrade. The initiator
///         proposes the change by initiating the update and the finalizer
///         (contract owner) may approve it by finalizing the change after the
///         governance delay passes.
contract VendingMachine is Ownable, IReceiveApproval {
    using SafeERC20 for IERC20;
    using SafeERC20 for TBTC;

    /// @notice The time delay that needs to pass between initializing and
    ///         finalizing update of any governable parameter in this contract.
    uint256 public constant GOVERNANCE_DELAY = 7 days;

    /// @notice Divisor for precision purposes. Used to represent fractions
    ///         in parameter values.
    uint256 public constant FLOATING_POINT_DIVISOR = 1e18;

    IERC20 public immutable tbtcV1;
    TBTC public immutable tbtcV2;

    /// @notice The fee for unminting TBTC v2 back into TBTC v1 represented as
    ///         1e18 precision fraction. The fee is proportional to the amount
    ///         being unminted and added on the top of the amount being unminted.
    ///         To calculate the fee value, the amount being unminted needs
    ///         to be multiplied by `unmintFee` and divided by 1e18.
    ///         For example, `unmintFee` set to 1000000000000000
    ///         means that 0.001 of the amount being unminted needs to be paid
    ///         to the `VendingMachine` as an unminting fee on the top of the
    ///         amount being unminted.
    uint256 public unmintFee;
    uint256 public newUnmintFee;
    uint256 public unmintFeeUpdateInitiatedTimestamp;
    address public unmintFeeUpdateInitiator;

    /// @notice The address of a new vending machine. Set only when the upgrade
    ///         process is pending. Once the upgrade gets finalized, the new
    ///         vending machine will become an owner of TBTC v2 token.
    address public newVendingMachine;
    uint256 public vendingMachineUpgradeInitiatedTimestamp;
    address public vendingMachineUpgradeInitiator;

    event UnmintFeeUpdateInitiated(uint256 newUnmintFee, uint256 timestamp);
    event UnmintFeeUpdated(uint256 newUnmintFee);

    event VendingMachineUpgradeInitiated(
        address newVendingMachine,
        uint256 timestamp
    );
    event VendingMachineUpgraded(address newVendingMachine);

    event Minted(address indexed recipient, uint256 amount);
    event Unminted(address indexed recipient, uint256 amount, uint256 fee);

    modifier only(address authorizedCaller) {
        require(msg.sender == authorizedCaller, "Caller is not authorized");
        _;
    }

    modifier onlyAfterGovernanceDelay(uint256 changeInitiatedTimestamp) {
        GovernanceUtils.onlyAfterGovernanceDelay(
            changeInitiatedTimestamp,
            GOVERNANCE_DELAY
        );
        _;
    }

    constructor(
        IERC20 _tbtcV1,
        TBTC _tbtcV2,
        uint256 _unmintFee
    ) {
        tbtcV1 = _tbtcV1;
        tbtcV2 = _tbtcV2;
        unmintFee = _unmintFee;

        unmintFeeUpdateInitiator = msg.sender;
        vendingMachineUpgradeInitiator = msg.sender;
    }

    /// @notice Mints TBTC v2 to the caller from TBTC v1 with 1:1 ratio.
    ///         The caller needs to have at least `amount` of TBTC v1 balance
    ///         approved for transfer to the `VendingMachine` before calling
    ///         this function.
    /// @param amount The amount of TBTC v2 to mint from TBTC v1
    function mint(uint256 amount) external {
        _mint(msg.sender, amount);
    }

    /// @notice Mints TBTC v2 to `from` address from TBTC v1 with 1:1 ratio.
    ///         `from` address needs to have at least `amount` of TBTC v1
    ///         balance approved for transfer to the `VendingMachine` before
    ///         calling this function.
    /// @dev This function is a shortcut for approve + mint. Only TBTC v1
    ///      caller is allowed and only TBTC v1 is allowed as a token to
    ///      transfer.
    /// @param from TBTC v1 token holder minting TBTC v2 tokens
    /// @param amount The amount of TBTC v2 to mint from TBTC v1
    /// @param token TBTC v1 token address
    function receiveApproval(
        address from,
        uint256 amount,
        address token,
        bytes calldata
    ) external override {
        require(token == address(tbtcV1), "Token is not TBTC v1");
        require(msg.sender == address(tbtcV1), "Only TBTC v1 caller allowed");
        _mint(from, amount);
    }

    /// @notice Unmints TBTC v2 from the caller into TBTC v1. Depending on
    ///         `unmintFee` value, may require paying an additional unmint fee
    ///         in TBTC v2 in addition to the amount being unminted. To see
    ///         what is the value of the fee, please call `unmintFeeFor(amount)`
    ///         function. The caller needs to have at least
    ///         `amount + unmintFeeFor(amount)` of TBTC v2 balance approved for
    ///         transfer to the `VendingMachine` before calling this function.
    /// @param amount The amount of TBTC v2 to unmint to TBTC v1
    function unmint(uint256 amount) external {
        uint256 fee = unmintFeeFor(amount);
        emit Unminted(msg.sender, amount, fee);

        require(
            tbtcV2.balanceOf(msg.sender) >= amount + fee,
            "Amount + fee exceeds TBTC v2 balance"
        );

        tbtcV2.safeTransferFrom(msg.sender, address(this), fee);
        tbtcV2.burnFrom(msg.sender, amount);
        tbtcV1.safeTransfer(msg.sender, amount);
    }

    /// @notice Allows the Governance to withdraw unmint fees accumulated by
    ///         `VendingMachine`.
    /// @param recipient The address receiving the fees
    /// @param amount The amount of fees in TBTC v2 to withdraw
    function withdrawFees(address recipient, uint256 amount)
        external
        onlyOwner
    {
        tbtcV2.safeTransfer(recipient, amount);
    }

    /// @notice Initiates unmint fee update process. The update process needs to
    ///         be finalized with a call to `finalizeUnmintFeeUpdate` function
    ///         after the `GOVERNANCE_DELAY` passes. Only unmint fee update
    ///         initiator role can initiate the update.
    /// @param _newUnmintFee The new unmint fee
    function initiateUnmintFeeUpdate(uint256 _newUnmintFee)
        external
        only(unmintFeeUpdateInitiator)
    {
        /* solhint-disable-next-line not-rely-on-time */
        emit UnmintFeeUpdateInitiated(_newUnmintFee, block.timestamp);
        newUnmintFee = _newUnmintFee;
        /* solhint-disable-next-line not-rely-on-time */
        unmintFeeUpdateInitiatedTimestamp = block.timestamp;
    }

    /// @notice Allows the contract owner to finalize unmint fee update process.
    ///         The update process needs to be first initiated with a call to
    ///         `initiateUnmintFeeUpdate` and the `GOVERNANCE_DELAY` needs to
    ///         pass.
    function finalizeUnmintFeeUpdate()
        external
        onlyOwner
        onlyAfterGovernanceDelay(unmintFeeUpdateInitiatedTimestamp)
    {
        emit UnmintFeeUpdated(newUnmintFee);
        unmintFee = newUnmintFee;
        newUnmintFee = 0;
        unmintFeeUpdateInitiatedTimestamp = 0;
    }

    /// @notice Initiates vending machine upgrade process. The upgrade process
    ///          needs to be finalized with a call to
    ///         `finalizeVendingMachineUpgrade` function after the
    ///         `GOVERNANCE_DELAY` passes. Only vending machine upgrade
    ///         initiator role can initiate the upgrade.
    /// @param _newVendingMachine The new vending machine address
    function initiateVendingMachineUpgrade(address _newVendingMachine)
        external
        only(vendingMachineUpgradeInitiator)
    {
        require(
            _newVendingMachine != address(0),
            "New VendingMachine cannot be zero address"
        );

        emit VendingMachineUpgradeInitiated(
            _newVendingMachine,
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp
        );
        newVendingMachine = _newVendingMachine;
        /* solhint-disable-next-line not-rely-on-time */
        vendingMachineUpgradeInitiatedTimestamp = block.timestamp;
    }

    /// @notice Allows the contract owner to finalize vending machine upgrade
    ///         process. The upgrade process needs to be first initiated with a
    ///         call to `initiateVendingMachineUpgrade` and the `GOVERNANCE_DELAY`
    ///         needs to pass. Once the upgrade is finalized, the new vending
    ///         machine will become an owner of TBTC v2 token and all TBTC v1
    ///         held by this contract will be transferred to the new vending
    ///         machine.
    function finalizeVendingMachineUpgrade()
        external
        onlyOwner
        onlyAfterGovernanceDelay(vendingMachineUpgradeInitiatedTimestamp)
    {
        emit VendingMachineUpgraded(newVendingMachine);
        //slither-disable-next-line reentrancy-no-eth
        tbtcV2.transferOwnership(newVendingMachine);
        tbtcV1.safeTransfer(newVendingMachine, tbtcV1.balanceOf(address(this)));
        newVendingMachine = address(0);
        vendingMachineUpgradeInitiatedTimestamp = 0;
    }

    /// @notice Transfers unmint fee update initiator role to another address.
    ///         Can be called only by the current unmint fee update initiator.
    /// @param newInitiator The new unmint fee update initiator
    function transferUnmintFeeUpdateInitiatorRole(address newInitiator)
        external
        only(unmintFeeUpdateInitiator)
    {
        require(
            newInitiator != address(0),
            "New initiator must not be zero address"
        );
        unmintFeeUpdateInitiator = newInitiator;
    }

    /// @notice Transfers vending machine upgrade initiator role to another
    ///         address. Can be called only by the current vending machine
    ///         upgrade initiator.
    /// @param newInitiator The new vending machine upgrade initiator
    function transferVendingMachineUpgradeInitiatorRole(address newInitiator)
        external
        only(vendingMachineUpgradeInitiator)
    {
        require(
            newInitiator != address(0),
            "New initiator must not be zero address"
        );
        vendingMachineUpgradeInitiator = newInitiator;
    }

    /// @notice Get the remaining time that needs to pass until unmint fee
    ///         update can be finalized by the Governance. If the update has
    ///         not been initiated, the function reverts.
    function getRemainingUnmintFeeUpdateTime() external view returns (uint256) {
        return
            GovernanceUtils.getRemainingGovernanceDelay(
                unmintFeeUpdateInitiatedTimestamp,
                GOVERNANCE_DELAY
            );
    }

    /// @notice Get the remaining time that needs to pass until vending machine
    ///         upgrade can be finalized by the Governance. If the upgrade has
    ///         not been initiated, the function reverts.
    function getRemainingVendingMachineUpgradeTime()
        external
        view
        returns (uint256)
    {
        return
            GovernanceUtils.getRemainingGovernanceDelay(
                vendingMachineUpgradeInitiatedTimestamp,
                GOVERNANCE_DELAY
            );
    }

    /// @notice Calculates the fee that needs to be paid to the `VendingMachine`
    ///         to unmint the given amount of TBTC v2 back into TBTC v1.
    function unmintFeeFor(uint256 amount) public view returns (uint256) {
        return (amount * unmintFee) / FLOATING_POINT_DIVISOR;
    }

    function _mint(address tokenOwner, uint256 amount) internal {
        emit Minted(tokenOwner, amount);
        tbtcV1.safeTransferFrom(tokenOwner, address(this), amount);
        tbtcV2.mint(tokenOwner, amount);
    }
}
