// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../integrator/IBank.sol";

/// @notice Minimal mock of `bridge/RedemptionWatchtower.sol`, exposing only
///         the `withdrawVetoedFunds` behavior needed to test
///         `L1BTCRedeemerWormhole.withdrawVetoedFunds`. Mirrors the real
///         contract's caller/amount checks; veto proposals are configured
///         directly via `setVetoProposal` instead of being derived from a
///         full veto-and-freeze-period flow.
contract MockRedemptionWatchtower {
    IBank public immutable bank;

    struct VetoProposal {
        address redeemer;
        uint64 withdrawableAmount;
    }

    mapping(uint256 => VetoProposal) public vetoProposals;

    event VetoedFundsWithdrawn(
        uint256 indexed redemptionKey,
        address indexed redeemer,
        uint64 amount
    );

    constructor(address _bank) {
        bank = IBank(_bank);
    }

    /// @notice Test helper that configures a finalized veto with a
    ///         withdrawable amount for `redeemer`, as if the real
    ///         contract's freeze period had already elapsed.
    function setVetoProposal(
        uint256 redemptionKey,
        address redeemer,
        uint64 withdrawableAmount
    ) external {
        vetoProposals[redemptionKey] = VetoProposal({
            redeemer: redeemer,
            withdrawableAmount: withdrawableAmount
        });
    }

    function withdrawVetoedFunds(uint256 redemptionKey) external {
        VetoProposal storage veto = vetoProposals[redemptionKey];

        require(msg.sender == veto.redeemer, "Caller is not the redeemer");
        require(veto.withdrawableAmount > 0, "No funds to withdraw");

        uint64 amount = veto.withdrawableAmount;
        veto.withdrawableAmount = 0;

        emit VetoedFundsWithdrawn(redemptionKey, msg.sender, amount);

        bank.transferBalance(msg.sender, amount);
    }
}
