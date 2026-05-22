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

import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

import "../cross-chain/AbstractL1BTCDepositor.sol";
import "../cross-chain/utils/Crosschain.sol";
import "./IRebateStaking.sol";

/// @title NativeBTCDepositor
/// @notice This contract is part of the direct bridging mechanism allowing
///         users to obtain ERC20 tBTC on the destination chain, without the need
///         to interact with the L1 tBTC ledger chain where minting occurs.
contract NativeBTCDepositor is AbstractL1BTCDepositor {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @notice Optional rebate staking contract consulted to gate the deposit
    ///         transaction max fee reimbursement on the receiver's T stake.
    ///         When unset, the staking gate is disabled and the reimbursement
    ///         falls back to the parent's balance-only check.
    IRebateStaking public rebateStaking;

    /// @notice Minimum T stake (in T's smallest unit) the deposit receiver
    ///         must hold to qualify for the deposit transaction max fee
    ///         reimbursement. Only consulted when `rebateStaking` is set.
    ///         A value of zero means any non-zero stake qualifies.
    uint96 public minStakeForWaiver;

    /// @notice Emitted when the rebate staking contract is updated by the owner.
    event RebateStakingUpdated(address rebateStaking);

    /// @notice Emitted when the minimum stake threshold is updated by the owner.
    event MinStakeForWaiverUpdated(uint96 minStakeForWaiver);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _tbtcBridge, address _tbtcVault)
        external
        initializer
    {
        __AbstractL1BTCDepositor_initialize(_tbtcBridge, _tbtcVault);
        __Ownable_init();
    }

    /// @notice Sets the rebate staking contract used to gate the deposit
    ///         transaction max fee reimbursement. Set to the zero address to
    ///         disable the staking gate entirely (the parent's balance-only
    ///         best-effort check then applies).
    /// @param _rebateStaking Address of the rebate staking contract.
    function setRebateStaking(address _rebateStaking) external onlyOwner {
        rebateStaking = IRebateStaking(_rebateStaking);
        emit RebateStakingUpdated(_rebateStaking);
    }

    /// @notice Sets the minimum T stake (raw `stakedAmount` reported by the
    ///         rebate staking contract) required of the deposit receiver to
    ///         qualify for the deposit transaction max fee reimbursement.
    /// @param _minStakeForWaiver Minimum stake threshold.
    function setMinStakeForWaiver(uint96 _minStakeForWaiver)
        external
        onlyOwner
    {
        minStakeForWaiver = _minStakeForWaiver;
        emit MinStakeForWaiverUpdated(_minStakeForWaiver);
    }

    /// @notice Quotes the payment that must be attached to the `finalizeDeposit`
    ///         function call.
    /// @dev This implementation requires no relayer payment; tBTC is transferred
    ///      directly on Ethereum L1 to the receiver address encoded in bytes32.
    /// @return cost Always 0 for this implementation (in WEI).
    function quoteFinalizeDeposit() external pure returns (uint256 cost) {
        cost = 0;
    }

    /// @notice Transfers ERC20 L1 tBTC directly to the Ethereum L1 receiver address.
    /// @param amount Amount of tBTC L1 ERC20 to transfer (1e18 precision).
    /// @param ethereumReceiverBytes32 Ethereum receiver address encoded as 32 bytes (left-padded).
    function _transferTbtc(uint256 amount, bytes32 ethereumReceiverBytes32)
        internal
        override
    {
        require(amount > 0, "Amount too low to transfer");
        require(
            ethereumReceiverBytes32 != bytes32(0),
            "Receiver cannot be zero"
        );

        address ethereumReceiver = CrosschainUtils.bytes32ToAddress(
            ethereumReceiverBytes32
        );

        tbtcToken.safeTransfer(ethereumReceiver, amount);
    }

    /// @dev Gates the deposit transaction max fee reimbursement on the
    ///      receiver's T stake recorded in the rebate staking contract.
    ///      When `rebateStaking` is unset, eligibility passes through to
    ///      `true` and the parent's balance-only check decides whether the
    ///      reimbursement is paid. The receiver is the L1 address encoded in
    ///      `destinationChainDepositOwner`.
    function _isTxMaxFeeReimbursementEligible(
        bytes32 destinationChainDepositOwner,
        uint256 txMaxFee
    ) internal view override returns (bool) {
        txMaxFee;
        IRebateStaking _rebateStaking = rebateStaking;
        if (address(_rebateStaking) == address(0)) {
            return true;
        }
        address receiver = CrosschainUtils.bytes32ToAddress(
            destinationChainDepositOwner
        );
        uint96 stake = _rebateStaking.getStake(receiver);
        return stake > 0 && stake >= minStakeForWaiver;
    }
}
