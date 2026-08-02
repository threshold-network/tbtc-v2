// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../staking/api/ISignerRegistry.sol";

/// @dev Test helper implementing `ISignerRegistry` with directly settable
///      state. Used by the staking module unit tests.
contract MockSignerRegistry is ISignerRegistry {
    mapping(address => OperatorStatus) public override operatorStatus;
    mapping(address => address) public override nodeOperatorOf;
    mapping(address => address) public override stakingProviderOf;
    mapping(address => address payable) internal beneficiaries;
    mapping(address => uint16) public override commissionBpsOf;

    function setOperatorStatus(address stakingProvider, OperatorStatus status)
        external
    {
        operatorStatus[stakingProvider] = status;
    }

    function setNodeOperator(address stakingProvider, address nodeOperator)
        external
    {
        nodeOperatorOf[stakingProvider] = nodeOperator;
        stakingProviderOf[nodeOperator] = stakingProvider;
    }

    function setBeneficiary(
        address stakingProvider,
        address payable beneficiary
    ) external {
        beneficiaries[stakingProvider] = beneficiary;
    }

    function setCommissionBps(address stakingProvider, uint16 commissionBps)
        external
    {
        commissionBpsOf[stakingProvider] = commissionBps;
    }

    function isActive(address stakingProvider)
        external
        view
        override
        returns (bool)
    {
        return operatorStatus[stakingProvider] == OperatorStatus.Active;
    }

    function beneficiaryOf(address stakingProvider)
        external
        view
        override
        returns (address payable)
    {
        return beneficiaries[stakingProvider];
    }

    function commissionScheduleOf(address stakingProvider)
        external
        view
        override
        returns (
            uint16,
            uint16,
            uint64
        )
    {
        return (commissionBpsOf[stakingProvider], 0, 0);
    }
}
