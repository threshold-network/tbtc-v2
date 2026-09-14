// SPDX-License-Identifier: GPL-3.0-only
//
// ▓▓▌ ▓▓ ▐▓▓ ▓▓▓▓▓▓▓▓▓▓▌▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▄
// ▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▌▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
//   ▓▓▓▓▓▓    ▓▓▓▓▓▓▓▀    ▐▓▓▓▓▓▓    ▐▓▓▓▓▓   ▓▓▓▓▓▓     ▓▓▓▓▓   ▐▓▓▓▓▓▌   ▐▓▓▓▓▓▓
//   ▓▓▓▓▓▓▄▄▓▓▓▓▓▓▓▀      ▐▓▓▓▓▓▓▄▄▄▄         ▓▓▓▓▓▓▄▄▄▄         ▐▓▓▓▓▓▌   ▐▓▓▓▓▓▓
//   ▓▓▓▓▓▓▓▓▓▓▓▓▓▀        ▐▓▓▓▓▓▓▓▓▓▓         ▓▓▓▓▓▓▓▓▓▓         ▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
//   ▓▓▓▓▓▓▀▀▓▓▓▓▓▓▄       ▐▓▓▓▓▓▓▀▀▀▀         ▓▓▓▓▓▓▀▀▀▀         ▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▀
//   ▓▓▓▓▓▓   ▀▓▓▓▓▓▓▄     ▐▓▓▓▓▓▓     ▓▓▓▓▓   ▓▓▓▓▓▓     ▓▓▓▓▓   ▐▓▓▓▓▓▌
// ▓▓▓▓▓▓▓▓▓▓ █▓▓▓▓▓▓▓▓▓ ▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  ▓▓▓▓▓▓▓▓▓▓
// ▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓ ▐▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  ▓▓▓▓▓▓▓▓▓▓
//
//
//

pragma solidity 0.8.17;

import "@keep-network/sortition-pools/contracts/SortitionPool.sol";
import "../api/IFrostAuthorizationSource.sol";

/// @notice Library managing operator authorizations for the FROST registry and
///         the presence of operators in the sortition pool based on their
///         authorization weight.
library FrostAuthorization {
    struct Parameters {
        // The minimum authorization required by the FROST application so that
        // an operator can join the sortition pool and do the work.
        uint96 minimumAuthorization;
        // Authorization decrease delay in seconds between the time
        // authorization decrease is requested and the time the authorization
        // decrease can be approved. It is always the same value, no matter if
        // authorization decrease amount is small, significant, or if it is
        // a decrease to zero.
        uint64 authorizationDecreaseDelay;
        // The time period before the authorization decrease delay end,
        // during which the authorization decrease request can be overwritten.
        //
        // When the request is overwritten, the authorization decrease delay is
        // reset.
        //
        // For example, if `authorizationDecraseChangePeriod` is set to 4
        // days, `authorizationDecreaseDelay` is set to 14 days, and someone
        // requested authorization decrease, it means they can not
        // request another decrease for the first 10 days. After 10 days pass,
        // they can request again and overwrite the previous authorization
        // decrease request. The delay time will reset for them and they
        // will have to wait another 10 days to alter it and 14 days to
        // approve it.
        //
        // This value protects against malicious operators who manipulate
        // their weight by overwriting authorization decrease request.
        //
        // If set to a value equal to `authorizationDecreaseDelay, it means
        // that authorization decrease request can be always overwritten.
        // If set to zero, it means authorization decrease request can not be
        // overwritten until the delay end, and one needs to wait for the entire
        // authorization decrease delay to approve their decrease and request
        // for another one or to overwrite the pending one.
        //
        //   (1) authorization decrease requested timestamp
        //   (2) from this moment authorization decrease request can be
        //       overwritten
        //   (3) from this moment authorization decrease request can be
        //       approved, assuming it was NOT overwritten in (2)
        //
        //  (1)                            (2)                        (3)
        // --x------------------------------x--------------------------x---->
        //   |                               \________________________/
        //   |                             authorizationDecreaseChangePeriod
        //    \______________________________________________________/
        //                   authorizationDecreaseDelay
        //
        uint64 authorizationDecreaseChangePeriod;
        // This struct doesn't contain `__gap` property as the structure is
        // stored inside `Data` struct, that already have a gap that can be used
        // on upgrade.
    }

    struct AuthorizationDecrease {
        uint96 decreasingBy; // amount
        uint64 decreasingAt; // timestamp
    }

    struct Data {
        Parameters parameters;
        mapping(address => address) stakingProviderToOperator;
        mapping(address => address) operatorToStakingProvider;
        mapping(address => AuthorizationDecrease) pendingDecreases;
        // Reserved storage space in case we need to add more variables.
        // See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
        // slither-disable-next-line unused-state
        uint256[46] __gap;
    }

    event OperatorRegistered(
        address indexed stakingProvider,
        address indexed operator
    );

    event AuthorizationIncreased(
        address indexed stakingProvider,
        address indexed operator,
        uint96 fromAmount,
        uint96 toAmount
    );

    event AuthorizationDecreaseRequested(
        address indexed stakingProvider,
        address indexed operator,
        uint96 fromAmount,
        uint96 toAmount,
        uint64 decreasingAt
    );

    event AuthorizationDecreaseApproved(address indexed stakingProvider);

    event InvoluntaryAuthorizationDecreaseFailed(
        address indexed stakingProvider,
        address indexed operator,
        uint96 fromAmount,
        uint96 toAmount
    );

    event OperatorJoinedSortitionPool(
        address indexed stakingProvider,
        address indexed operator
    );

    event OperatorStatusUpdated(
        address indexed stakingProvider,
        address indexed operator
    );

    /// @notice Sets the minimum authorization for the FROST application.
    ///         Without at least the minimum authorization, the provider is not
    ///         eligible to join and operate in the network.
    function setMinimumAuthorization(
        Data storage self,
        uint96 _minimumAuthorization
    ) internal {
        self.parameters.minimumAuthorization = _minimumAuthorization;
    }

    /// @notice Sets the authorization decrease delay. It is the time in seconds
    ///         that needs to pass between the time authorization decrease is
    ///         requested and the time the authorization decrease can be
    ///         approved, no matter the authorization decrease amount.
    function setAuthorizationDecreaseDelay(
        Data storage self,
        uint64 _authorizationDecreaseDelay
    ) internal {
        self
            .parameters
            .authorizationDecreaseDelay = _authorizationDecreaseDelay;
    }

    /// @notice Sets the authorization decrease change period. It is the time
    ///         period before the authorization decrease delay end,
    ///         during which the authorization decrease request can be
    ///         overwritten.
    function setAuthorizationDecreaseChangePeriod(
        Data storage self,
        uint64 _authorizationDecreaseChangePeriod
    ) internal {
        self
            .parameters
            .authorizationDecreaseChangePeriod = _authorizationDecreaseChangePeriod;
    }

    /// @notice Used by an operator provider to set the operator address that
    ///         will operate a FROST node. The provider can set the operator
    ///         address only one time. The operator address can not be changed
    ///         and must be unique. Reverts if the operator is already set for
    ///         the provider or if the operator address is already in use.
    ///         Reverts if there is a pending authorization decrease for the
    ///         provider.
    function registerOperator(Data storage self, address operator) internal {
        address stakingProvider = msg.sender;

        require(operator != address(0), "Operator can not be zero address");
        require(
            self.stakingProviderToOperator[stakingProvider] == address(0),
            "Operator already set for the staking provider"
        );
        require(
            self.operatorToStakingProvider[operator] == address(0),
            "Operator address already in use"
        );

        // Authorization request for a provider who has not yet
        // registered their operator can be approved immediately.
        // We need to make sure that the approval happens before operator
        // is registered to do not let the operator join the sortition pool
        // with an unresolved authorization decrease request that can be
        // approved at any point.
        AuthorizationDecrease storage decrease = self.pendingDecreases[
            stakingProvider
        ];
        require(
            decrease.decreasingAt == 0,
            "There is a pending authorization decrease request"
        );

        emit OperatorRegistered(stakingProvider, operator);

        self.stakingProviderToOperator[stakingProvider] = operator;
        self.operatorToStakingProvider[operator] = stakingProvider;
    }

    /// @notice Used by the authorization source to inform the registry that
    ///         the authorization weight for the given provider increased.
    ///
    ///         Reverts if the authorization amount is below the minimum.
    ///
    ///         The function is not updating the sortition pool. Sortition pool
    ///         state needs to be updated by the operator with a call to
    ///         `joinSortitionPool` or `updateOperatorStatus`.
    ///
    /// @dev Should only be callable by the configured authorization source.
    function authorizationIncreased(
        Data storage self,
        address stakingProvider,
        uint96 fromAmount,
        uint96 toAmount
    ) internal {
        require(
            toAmount >= self.parameters.minimumAuthorization,
            "Authorization below the minimum"
        );

        // Note that this function does not require the operator address to be
        // set for the given provider. This allows the authorization source to
        // increase authorization before the provider sets the operator.

        address operator = self.stakingProviderToOperator[stakingProvider];
        emit AuthorizationIncreased(
            stakingProvider,
            operator,
            fromAmount,
            toAmount
        );
    }

    /// @notice Used by the authorization source to inform the registry that an
    ///         authorization weight decrease for the given provider has been
    ///         requested.
    ///
    ///         Reverts if the amount after deauthorization would be non-zero
    ///         and lower than the minimum authorization.
    ///
    ///         Reverts if another authorization decrease request is pending for
    ///         the provider and not enough time passed since the original
    ///         request (see `authorizationDecreaseChangePeriod`).
    ///
    ///         If the operator is not known (`registerOperator` was not called)
    ///         it lets to `approveAuthorizationDecrease` immediately. If the
    ///         operator is known (`registerOperator` was called), the operator
    ///         needs to update state of the sortition pool with a call to
    ///         `joinSortitionPool` or `updateOperatorStatus`. After the
    ///         sortition pool state is in sync, authorization decrease delay
    ///         starts.
    ///
    ///         After authorization decrease delay passes, authorization
    ///         decrease request needs to be approved with a call to
    ///         `approveAuthorizationDecrease` function.
    ///
    ///         If there is a pending authorization decrease request, it is
    ///         overwritten, but only if enough time passed since the original
    ///         request. Otherwise, the function reverts.
    ///
    /// @dev Should only be callable by the configured authorization source.
    function authorizationDecreaseRequested(
        Data storage self,
        address stakingProvider,
        uint96 fromAmount,
        uint96 toAmount
    ) internal {
        require(
            toAmount == 0 || toAmount >= self.parameters.minimumAuthorization,
            "Authorization amount should be 0 or above the minimum"
        );

        address operator = self.stakingProviderToOperator[stakingProvider];

        uint64 decreasingAt;

        if (operator == address(0)) {
            // Operator is not known. It means `registerOperator` was not
            // called yet, and there is no chance the operator could
            // call `joinSortitionPool`. We can let to approve authorization
            // decrease immediately because that operator was never in the
            // sortition pool.

            // solhint-disable-next-line not-rely-on-time
            decreasingAt = uint64(block.timestamp);
        } else {
            // Operator is known. It means that this operator is or was in
            // the sortition pool. Before authorization decrease delay starts,
            // the operator needs to update the state of the sortition pool
            // with a call to `joinSortitionPool` or `updateOperatorStatus`.
            // For now, we set `decreasingAt` as "never decreasing" and let
            // it be updated by `joinSortitionPool` or `updateOperatorStatus`
            // once we know the sortition pool is in sync.
            decreasingAt = type(uint64).max;
        }

        uint96 decreasingBy = fromAmount - toAmount;

        AuthorizationDecrease storage decreaseRequest = self.pendingDecreases[
            stakingProvider
        ];

        uint64 pendingDecreaseAt = decreaseRequest.decreasingAt;
        if (pendingDecreaseAt != 0 && pendingDecreaseAt != type(uint64).max) {
            // If there is already a pending authorization decrease request for
            // this provider and that request has been activated
            // (sortition pool was updated), require enough time to pass before
            // it can be overwritten.
            require(
                // solhint-disable-next-line not-rely-on-time
                block.timestamp >=
                    pendingDecreaseAt -
                        self.parameters.authorizationDecreaseChangePeriod,
                "Not enough time passed since the original request"
            );
        }

        decreaseRequest.decreasingBy = decreasingBy;
        decreaseRequest.decreasingAt = decreasingAt;

        emit AuthorizationDecreaseRequested(
            stakingProvider,
            operator,
            fromAmount,
            toAmount,
            decreasingAt
        );
    }

    /// @notice Approves the previously registered authorization decrease
    ///         request. Reverts if authorization decrease delay have not passed
    ///         yet or if the authorization decrease was not requested for the
    ///         given provider.
    function approveAuthorizationDecrease(
        Data storage self,
        IFrostAuthorizationSource authorizationSource,
        address stakingProvider
    ) internal {
        AuthorizationDecrease storage decrease = self.pendingDecreases[
            stakingProvider
        ];
        require(
            decrease.decreasingAt > 0,
            "Authorization decrease not requested"
        );
        require(
            decrease.decreasingAt != type(uint64).max,
            "Authorization decrease request not activated"
        );
        require(
            // solhint-disable-next-line not-rely-on-time
            block.timestamp >= decrease.decreasingAt,
            "Authorization decrease delay not passed"
        );

        emit AuthorizationDecreaseApproved(stakingProvider);

        // Clear the pending decrease before the external call so a
        // future bonded `IFrostAuthorizationSource` implementation
        // cannot re-enter with a stale state.
        delete self.pendingDecreases[stakingProvider];
        // slither-disable-next-line unused-return
        authorizationSource.approveAuthorizationDecrease(stakingProvider);
    }

    /// @notice Compatibility callback for involuntary authorization decreases.
    ///         Under the current allowlist source, authorization changes are
    ///         governance-controlled rather than token-slashing-controlled.
    ///
    ///         If the operator is not known (`registerOperator` was not called)
    ///         the function does nothing. The operator was never in a sortition
    ///         pool so there is nothing to update.
    ///
    ///         If the operator is known, sortition pool is unlocked, and the
    ///         operator is in the sortition pool, the sortition pool state is
    ///         updated. If the sortition pool is locked, update needs to be
    ///         postponed. Every other operator provider is incentivized to call
    ///         `updateOperatorStatus` for the problematic operator to increase
    ///         their own rewards in the pool.
    ///
    /// @dev Should only be callable by the configured authorization source.
    function involuntaryAuthorizationDecrease(
        Data storage self,
        IFrostAuthorizationSource authorizationSource,
        SortitionPool sortitionPool,
        address stakingProvider,
        uint96 fromAmount,
        uint96 toAmount
    ) internal {
        address operator = self.stakingProviderToOperator[stakingProvider];

        if (operator == address(0)) {
            // Operator is not known. It means `registerOperator` was not
            // called yet, and there is no chance the operator could
            // call `joinSortitionPool`. We can just ignore this update because
            // operator was never in the sortition pool.
            return;
        } else {
            // Operator is known. It means that this operator is or was in the
            // sortition pool and the sortition pool may need to be updated.
            //
            // If the sortition pool is not locked and the operator is in the
            // sortition pool, we are updating it.
            //
            // If the authorization source reduces an operator's weight while
            // the sortition pool is unlocked, update the operator immediately.
            // If the pool is locked, the update is deferred and anyone can
            // later call `updateOperatorStatus` once the pool is unlocked.
            if (sortitionPool.isOperatorInPool(operator)) {
                if (sortitionPool.isLocked()) {
                    emit InvoluntaryAuthorizationDecreaseFailed(
                        stakingProvider,
                        operator,
                        fromAmount,
                        toAmount
                    );
                } else {
                    updateOperatorStatus(
                        self,
                        authorizationSource,
                        sortitionPool,
                        operator
                    );
                }
            }
        }
    }

    /// @notice Lets the operator join the sortition pool. The operator address
    ///         must be known - before calling this function, it has to be
    ///         appointed by the staking provider by calling `registerOperator`.
    ///         Also, the operator must have the minimum authorization required
    ///         by FROST. Function reverts if the operator has no eligible
    ///         authorization or if the operator is not known. If there was an
    ///         authorization decrease requested, it is activated by starting
    ///         the authorization decrease delay.
    function joinSortitionPool(
        Data storage self,
        IFrostAuthorizationSource authorizationSource,
        SortitionPool sortitionPool
    ) internal {
        address operator = msg.sender;

        address stakingProvider = self.operatorToStakingProvider[operator];
        require(stakingProvider != address(0), "Unknown operator");

        AuthorizationDecrease storage decrease = self.pendingDecreases[
            stakingProvider
        ];

        uint96 eligibleWeight = eligibleStake(
            self,
            authorizationSource,
            stakingProvider,
            decrease.decreasingBy
        );

        require(eligibleWeight != 0, "Authorization below the minimum");

        emit OperatorJoinedSortitionPool(stakingProvider, operator);

        sortitionPool.insertOperator(operator, eligibleWeight);

        // If there is a pending authorization decrease request, activate it.
        // At this point, the sortition pool state is up to date so the
        // authorization decrease delay can start counting.
        if (decrease.decreasingAt == type(uint64).max) {
            decrease.decreasingAt =
                // solhint-disable-next-line not-rely-on-time
                uint64(block.timestamp) +
                self.parameters.authorizationDecreaseDelay;
        }
    }

    /// @notice Updates status of the operator in the sortition pool. If there
    ///         was an authorization decrease requested, it is activated by
    ///         starting the authorization decrease delay.
    ///         Function reverts if the operator is not known.
    function updateOperatorStatus(
        Data storage self,
        IFrostAuthorizationSource authorizationSource,
        SortitionPool sortitionPool,
        address operator
    ) internal {
        address stakingProvider = self.operatorToStakingProvider[operator];
        require(stakingProvider != address(0), "Unknown operator");

        AuthorizationDecrease storage decrease = self.pendingDecreases[
            stakingProvider
        ];

        emit OperatorStatusUpdated(stakingProvider, operator);

        if (sortitionPool.isOperatorInPool(operator)) {
            uint96 eligibleWeight = eligibleStake(
                self,
                authorizationSource,
                stakingProvider,
                decrease.decreasingBy
            );

            sortitionPool.updateOperatorStatus(operator, eligibleWeight);
        }

        // If there is a pending authorization decrease request, activate it.
        // At this point, the sortition pool state is up to date so the
        // authorization decrease delay can start counting.
        if (decrease.decreasingAt == type(uint64).max) {
            decrease.decreasingAt =
                // solhint-disable-next-line not-rely-on-time
                uint64(block.timestamp) +
                self.parameters.authorizationDecreaseDelay;
        }
    }

    /// @notice Checks if the operator's authorization is in sync with the
    ///         operator's weight in the sortition pool.
    ///         If the operator is not in the sortition pool and their
    ///         authorization weight is non-zero, function returns false.
    function isOperatorUpToDate(
        Data storage self,
        IFrostAuthorizationSource authorizationSource,
        SortitionPool sortitionPool,
        address operator
    ) internal view returns (bool) {
        address stakingProvider = self.operatorToStakingProvider[operator];
        require(stakingProvider != address(0), "Unknown operator");

        AuthorizationDecrease storage decrease = self.pendingDecreases[
            stakingProvider
        ];

        uint96 eligibleWeight = eligibleStake(
            self,
            authorizationSource,
            stakingProvider,
            decrease.decreasingBy
        );

        if (!sortitionPool.isOperatorInPool(operator)) {
            return eligibleWeight == 0;
        } else {
            return sortitionPool.isOperatorUpToDate(operator, eligibleWeight);
        }
    }

    /// @notice Returns the current value of the provider's eligible
    ///         authorization. Eligible authorization is defined as the current
    ///         authorization weight minus the pending authorization decrease.
    ///         This value is used for the operator's weight in the pool. If it
    ///         is below the minimum authorization, eligible authorization is 0.
    /// @dev This function can be exposed to the public in contrast to the
    ///      second variant accepting `decreasingBy` as a parameter.
    function eligibleStake(
        Data storage self,
        IFrostAuthorizationSource authorizationSource,
        address stakingProvider
    ) internal view returns (uint96) {
        return
            eligibleStake(
                self,
                authorizationSource,
                stakingProvider,
                pendingAuthorizationDecrease(self, stakingProvider)
            );
    }

    /// @notice Returns the current value of the provider's eligible
    ///         authorization. Eligible authorization is defined as the current
    ///         authorization weight minus the pending authorization decrease.
    ///         This value is used for the operator's weight in the pool. If it
    ///         is below the minimum authorization, eligible authorization is 0.
    /// @dev This function is not intended to be exposes to the public.
    ///      `decreasingBy` must be fetched from `pendingDecreases` mapping and
    ///      it is passed as a parameter to optimize gas usage of functions that
    ///      call `eligibleStake` and need to use `AuthorizationDecrease`
    ///      fetched from `pendingDecreases` for some additional logic.
    function eligibleStake(
        Data storage self,
        IFrostAuthorizationSource authorizationSource,
        address stakingProvider,
        uint96 decreasingBy
    ) internal view returns (uint96) {
        uint96 authorizedWeight = authorizationSource.authorizedWeight(
            stakingProvider,
            address(this)
        );

        uint96 eligibleWeight = authorizedWeight > decreasingBy
            ? authorizedWeight - decreasingBy
            : 0;

        if (eligibleWeight < self.parameters.minimumAuthorization) {
            return 0;
        } else {
            return eligibleWeight;
        }
    }

    /// @notice Returns the weight that is pending authorization decrease for
    ///         the given provider. If no authorization
    ///         decrease has been requested, returns zero.
    function pendingAuthorizationDecrease(
        Data storage self,
        address stakingProvider
    ) internal view returns (uint96) {
        AuthorizationDecrease storage decrease = self.pendingDecreases[
            stakingProvider
        ];

        return decrease.decreasingBy;
    }

    /// @notice Returns the remaining time in seconds that needs to pass before
    ///         the requested authorization decrease can be approved.
    ///         If the sortition pool state was not updated yet by the operator
    ///         after requesting the authorization decrease, returns
    ///         `type(uint64).max`.
    function remainingAuthorizationDecreaseDelay(
        Data storage self,
        address stakingProvider
    ) internal view returns (uint64) {
        AuthorizationDecrease storage decrease = self.pendingDecreases[
            stakingProvider
        ];

        if (decrease.decreasingAt == type(uint64).max) {
            return type(uint64).max;
        }

        // solhint-disable-next-line not-rely-on-time
        uint64 _now = uint64(block.timestamp);
        return _now > decrease.decreasingAt ? 0 : decrease.decreasingAt - _now;
    }
}
