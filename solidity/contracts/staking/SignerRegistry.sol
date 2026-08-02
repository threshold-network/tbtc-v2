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

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import "../GovernanceUtils.sol";
import "./api/ISignerRegistry.sol";
import "./api/ISeatAllocator.sol";

/// @title SignerRegistry
/// @notice Governance-curated registry of signer operators for the delegated
///         staking module. Maps each staking provider to an immutable node
///         operator address (1:1) and a beneficiary, tracks the operator
///         lifecycle (`None` -> `Active` -> `Deactivating` / `Ejected`), and
///         manages time-noticed commission declarations.
/// @dev Operator addition and deactivation are two-step, governance-delayed
///      actions following the begin/finalize idiom. Ejection is the only
///      instant status change, reserved for emergencies. After every
///      finalized status change the registry pokes the seat allocator (if
///      wired) so the FROST wallet registry's view of the operator's
///      authorization weight is refreshed promptly; a zero allocator address
///      is tolerated to support phased rollout.
contract SignerRegistry is Initializable, OwnableUpgradeable, ISignerRegistry {
    struct Operator {
        OperatorStatus status;
        address nodeOperator;
        address payable beneficiary;
        uint16 commissionBps;
        uint16 pendingCommissionBps;
        uint64 commissionEffectiveAt;
        uint64 statusChangeInitiated;
    }

    /// @notice Operator records keyed by staking provider address. For a
    ///         provider with `status == None` and a non-zero `nodeOperator`,
    ///         the record represents a pending, not-yet-finalized addition.
    mapping(address => Operator) public operators;

    /// @notice Reverse lookup: node operator address to the staking provider
    ///         it is registered under. Populated at addition finalization;
    ///         each node operator address can serve at most one staking
    ///         provider, forever (the mapping is never cleared).
    mapping(address => address) internal providerByNodeOperator;

    /// @notice Seat allocator poked after status changes. Set-once wiring.
    ISeatAllocator public seatAllocator;

    /// @notice Delay between beginning and finalizing operator addition and
    ///         deactivation.
    uint64 public governanceDelay;

    /// @notice Notice period before a declared commission change becomes
    ///         effective.
    uint64 public commissionNoticePeriod;

    /// @notice Upper bound for operator commission, in basis points.
    uint16 public maxCommissionBps;

    /// @notice Maximum allowed commission increase per declaration, in basis
    ///         points. Decreases are not step-limited (they favor
    ///         delegators).
    uint16 public maxCommissionStepBps;

    // Reserved storage space in case we need to add more variables.
    // The convention from OpenZeppelin suggests the storage space should
    // add up to 50 slots.
    // See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
    // slither-disable-next-line unused-state
    uint256[47] private __gap;

    event OperatorAdditionBegan(
        address indexed stakingProvider,
        address indexed nodeOperator,
        address beneficiary,
        uint16 commissionBps
    );
    event OperatorAdded(
        address indexed stakingProvider,
        address indexed nodeOperator,
        address beneficiary,
        uint16 commissionBps
    );
    event OperatorDeactivationBegan(address indexed stakingProvider);
    event OperatorDeactivated(address indexed stakingProvider);
    event OperatorEjected(address indexed stakingProvider);
    event CommissionDeclared(
        address indexed stakingProvider,
        uint16 commissionBps,
        uint64 effectiveAt
    );
    event SeatAllocatorSet(address seatAllocator);

    error ZeroAddress();
    error MaxCommissionExceedsHundredPercent();
    error OperatorAlreadyExists();
    error NodeOperatorAlreadyUsed();
    error NoPendingAddition();
    error NotActiveOperator();
    error NoPendingDeactivation();
    error OperatorNotEjectable();
    error CommissionExceedsMax();
    error CommissionStepTooBig();
    error SeatAllocatorAlreadySet();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @dev Initializes the upgradeable contract on deployment.
    /// @param _governanceDelay Delay for two-step operator lifecycle actions.
    /// @param _commissionNoticePeriod Notice period for commission changes
    ///        (30 days on production deployments).
    /// @param _maxCommissionBps Commission upper bound (2500 = 25%).
    /// @param _maxCommissionStepBps Maximum commission increase per
    ///        declaration (500 = 5%).
    function initialize(
        uint64 _governanceDelay,
        uint64 _commissionNoticePeriod,
        uint16 _maxCommissionBps,
        uint16 _maxCommissionStepBps
    ) external initializer {
        if (_maxCommissionBps > 10000) {
            revert MaxCommissionExceedsHundredPercent();
        }

        governanceDelay = _governanceDelay;
        commissionNoticePeriod = _commissionNoticePeriod;
        maxCommissionBps = _maxCommissionBps;
        maxCommissionStepBps = _maxCommissionStepBps;

        __Ownable_init();
    }

    /// @notice Wires the seat allocator address. Set-once: reverts if the
    ///         allocator was already set.
    /// @param _seatAllocator Address of the seat allocator.
    /// @dev Requirements:
    ///      - The caller must be the contract owner,
    ///      - The seat allocator must not have been set before,
    ///      - The new address must not be zero.
    function setSeatAllocator(address _seatAllocator) external onlyOwner {
        if (_seatAllocator == address(0)) {
            revert ZeroAddress();
        }
        if (address(seatAllocator) != address(0)) {
            revert SeatAllocatorAlreadySet();
        }

        seatAllocator = ISeatAllocator(_seatAllocator);
        emit SeatAllocatorSet(_seatAllocator);
    }

    /// @notice Begins addition of a new signer operator. Records the pending
    ///         operator data and starts the governance delay. Calling again
    ///         for the same staking provider before finalization overwrites
    ///         the pending data and restarts the delay.
    /// @param stakingProvider Address of the staking provider being added.
    /// @param nodeOperator Node operator address; must not be in use by any
    ///        other staking provider.
    /// @param beneficiary Address receiving the operator commission.
    /// @param commissionBps Initial commission in basis points, effective
    ///        immediately at finalization.
    /// @dev Requirements:
    ///      - The caller must be the contract owner,
    ///      - The staking provider status must be `None`,
    ///      - No address parameter can be zero,
    ///      - The commission cannot exceed `maxCommissionBps`.
    function beginOperatorAddition(
        address stakingProvider,
        address nodeOperator,
        address payable beneficiary,
        uint16 commissionBps
    ) external onlyOwner {
        if (
            stakingProvider == address(0) ||
            nodeOperator == address(0) ||
            beneficiary == address(0)
        ) {
            revert ZeroAddress();
        }
        if (commissionBps > maxCommissionBps) {
            revert CommissionExceedsMax();
        }

        Operator storage operator = operators[stakingProvider];
        if (operator.status != OperatorStatus.None) {
            revert OperatorAlreadyExists();
        }
        if (providerByNodeOperator[nodeOperator] != address(0)) {
            revert NodeOperatorAlreadyUsed();
        }

        operator.nodeOperator = nodeOperator;
        operator.beneficiary = beneficiary;
        operator.commissionBps = commissionBps;
        /* solhint-disable-next-line not-rely-on-time */
        operator.statusChangeInitiated = uint64(block.timestamp);

        emit OperatorAdditionBegan(
            stakingProvider,
            nodeOperator,
            beneficiary,
            commissionBps
        );
    }

    /// @notice Finalizes a pending operator addition after the governance
    ///         delay. Activates the operator and claims the node operator
    ///         address.
    /// @param stakingProvider Address of the staking provider being added.
    /// @dev Requirements:
    ///      - The caller must be the contract owner,
    ///      - An addition must have been begun for the staking provider,
    ///      - The governance delay must have elapsed,
    ///      - The node operator address must still be unused (it could have
    ///        been claimed by another addition finalized in the meantime).
    function finalizeOperatorAddition(address stakingProvider)
        external
        onlyOwner
    {
        Operator storage operator = operators[stakingProvider];
        if (
            operator.status != OperatorStatus.None ||
            operator.nodeOperator == address(0)
        ) {
            revert NoPendingAddition();
        }

        GovernanceUtils.onlyAfterGovernanceDelay(
            operator.statusChangeInitiated,
            governanceDelay
        );

        if (providerByNodeOperator[operator.nodeOperator] != address(0)) {
            revert NodeOperatorAlreadyUsed();
        }

        operator.status = OperatorStatus.Active;
        operator.statusChangeInitiated = 0;
        providerByNodeOperator[operator.nodeOperator] = stakingProvider;

        emit OperatorAdded(
            stakingProvider,
            operator.nodeOperator,
            operator.beneficiary,
            operator.commissionBps
        );

        notifySeatAllocator(stakingProvider);
    }

    /// @notice Begins deactivation of an active operator, starting the
    ///         governance delay. Calling again restarts the delay.
    /// @param stakingProvider Address of the staking provider.
    /// @dev Requirements:
    ///      - The caller must be the contract owner,
    ///      - The operator must be `Active`.
    function beginDeactivation(address stakingProvider) external onlyOwner {
        Operator storage operator = operators[stakingProvider];
        if (operator.status != OperatorStatus.Active) {
            revert NotActiveOperator();
        }

        /* solhint-disable-next-line not-rely-on-time */
        operator.statusChangeInitiated = uint64(block.timestamp);

        emit OperatorDeactivationBegan(stakingProvider);
    }

    /// @notice Finalizes a pending deactivation after the governance delay.
    ///         The operator becomes `Deactivating`: it keeps that status
    ///         until a later lifecycle drain, carries zero authorization
    ///         weight for future wallets, and accepts no new stake.
    /// @param stakingProvider Address of the staking provider.
    /// @dev Requirements:
    ///      - The caller must be the contract owner,
    ///      - The operator must be `Active` with a begun deactivation,
    ///      - The governance delay must have elapsed.
    function finalizeDeactivation(address stakingProvider) external onlyOwner {
        Operator storage operator = operators[stakingProvider];
        if (operator.status != OperatorStatus.Active) {
            revert NotActiveOperator();
        }
        if (operator.statusChangeInitiated == 0) {
            revert NoPendingDeactivation();
        }

        GovernanceUtils.onlyAfterGovernanceDelay(
            operator.statusChangeInitiated,
            governanceDelay
        );

        operator.status = OperatorStatus.Deactivating;
        operator.statusChangeInitiated = 0;

        emit OperatorDeactivated(stakingProvider);

        notifySeatAllocator(stakingProvider);
    }

    /// @notice Instantly ejects an operator. Emergency-only governance
    ///         action; the operator's weight resolves to zero for future
    ///         wallets while its live wallets drain via existing lifecycle
    ///         triggers. `Ejected` is terminal.
    /// @param stakingProvider Address of the staking provider.
    /// @dev Requirements:
    ///      - The caller must be the contract owner,
    ///      - The operator must be `Active` or `Deactivating`.
    function ejectOperator(address stakingProvider) external onlyOwner {
        Operator storage operator = operators[stakingProvider];
        if (
            operator.status != OperatorStatus.Active &&
            operator.status != OperatorStatus.Deactivating
        ) {
            revert OperatorNotEjectable();
        }

        operator.status = OperatorStatus.Ejected;
        operator.statusChangeInitiated = 0;

        emit OperatorEjected(stakingProvider);

        notifySeatAllocator(stakingProvider);
    }

    /// @notice Declares a new commission for the calling staking provider.
    ///         The new value becomes effective after the notice period.
    ///         Declaring again overwrites a not-yet-effective pending value
    ///         and restarts the notice period; the step limit is always
    ///         checked against the currently effective commission.
    /// @param newCommissionBps New commission in basis points.
    /// @dev Requirements:
    ///      - The caller must be an `Active` staking provider,
    ///      - The commission cannot exceed `maxCommissionBps`,
    ///      - An increase over the currently effective commission cannot
    ///        exceed `maxCommissionStepBps`; decreases are not step-limited.
    function declareCommission(uint16 newCommissionBps) external {
        Operator storage operator = operators[msg.sender];
        if (operator.status != OperatorStatus.Active) {
            revert NotActiveOperator();
        }
        if (newCommissionBps > maxCommissionBps) {
            revert CommissionExceedsMax();
        }

        uint16 currentBps = effectiveCommissionBps(operator);
        if (
            newCommissionBps > currentBps &&
            newCommissionBps - currentBps > maxCommissionStepBps
        ) {
            revert CommissionStepTooBig();
        }

        // A previous pending rate may already have matured. Checkpoint it
        // before overwriting the schedule so rewards on the two sides of its
        // effective timestamp can never be charged at the new declaration.
        ISeatAllocator allocator = seatAllocator;
        if (address(allocator) != address(0)) {
            allocator.checkpointRewards(msg.sender);
        }

        // Settle a matured pending commission into storage before
        // overwriting the pending slot so the previously declared value is
        // not lost.
        operator.commissionBps = currentBps;
        operator.pendingCommissionBps = newCommissionBps;
        /* solhint-disable-next-line not-rely-on-time */
        uint64 effectiveAt = uint64(block.timestamp) + commissionNoticePeriod;
        operator.commissionEffectiveAt = effectiveAt;

        emit CommissionDeclared(msg.sender, newCommissionBps, effectiveAt);
    }

    /// @notice Returns the lifecycle status of the given staking provider.
    /// @param stakingProvider Address of the staking provider.
    /// @return Current `OperatorStatus`; `None` for unknown providers.
    function operatorStatus(address stakingProvider)
        external
        view
        override
        returns (OperatorStatus)
    {
        return operators[stakingProvider].status;
    }

    /// @notice Returns true if the given staking provider's status is
    ///         `Active`.
    /// @param stakingProvider Address of the staking provider.
    /// @return True if the operator is `Active`.
    function isActive(address stakingProvider)
        external
        view
        override
        returns (bool)
    {
        return operators[stakingProvider].status == OperatorStatus.Active;
    }

    /// @notice Returns the node operator address registered for the given
    ///         staking provider.
    /// @param stakingProvider Address of the staking provider.
    /// @return Node operator address; zero address if none registered.
    function nodeOperatorOf(address stakingProvider)
        external
        view
        override
        returns (address)
    {
        return operators[stakingProvider].nodeOperator;
    }

    /// @notice Returns the staking provider a node operator address is
    ///         registered under.
    /// @param nodeOperator Address of the node operator.
    /// @return Staking provider address; zero address if none registered.
    function stakingProviderOf(address nodeOperator)
        external
        view
        override
        returns (address)
    {
        return providerByNodeOperator[nodeOperator];
    }

    /// @notice Returns the beneficiary address receiving the operator
    ///         commission for the given staking provider.
    /// @param stakingProvider Address of the staking provider.
    /// @return Payable beneficiary address.
    function beneficiaryOf(address stakingProvider)
        external
        view
        override
        returns (address payable)
    {
        return operators[stakingProvider].beneficiary;
    }

    /// @notice Returns the effective commission of the given staking
    ///         provider, in basis points. A declared pending commission is
    ///         returned only once its notice period elapsed
    ///         (`block.timestamp >= commissionEffectiveAt`); before that the
    ///         previously effective value is returned.
    /// @param stakingProvider Address of the staking provider.
    /// @return Effective commission in basis points.
    function commissionBpsOf(address stakingProvider)
        external
        view
        override
        returns (uint16)
    {
        return effectiveCommissionBps(operators[stakingProvider]);
    }

    /// @notice See {ISignerRegistry-commissionScheduleOf}.
    function commissionScheduleOf(address stakingProvider)
        external
        view
        override
        returns (
            uint16 commissionBps,
            uint16 pendingCommissionBps,
            uint64 effectiveAt
        )
    {
        Operator storage operator = operators[stakingProvider];
        return (
            operator.commissionBps,
            operator.pendingCommissionBps,
            operator.commissionEffectiveAt
        );
    }

    /// @dev Pokes the seat allocator, if wired, so the registry-side
    ///      authorization weight of the staking provider is refreshed after
    ///      a status change. A zero allocator address is tolerated (phased
    ///      rollout wiring).
    function notifySeatAllocator(address stakingProvider) internal {
        ISeatAllocator allocator = seatAllocator;
        if (address(allocator) != address(0)) {
            allocator.refreshAuthorization(stakingProvider);
        }
    }

    /// @dev Resolves the effective commission: the pending value once its
    ///      notice period elapsed, the stored current value otherwise.
    function effectiveCommissionBps(Operator storage operator)
        internal
        view
        returns (uint16)
    {
        if (
            operator.commissionEffectiveAt != 0 &&
            /* solhint-disable-next-line not-rely-on-time */
            block.timestamp >= operator.commissionEffectiveAt
        ) {
            return operator.pendingCommissionBps;
        }
        return operator.commissionBps;
    }
}
