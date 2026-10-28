// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import "../Base.sol";
import {BankHandler} from "./BankHandler.sol";
import {TBTCHandler} from "./TBTCHandler.sol";
import {TBTCVaultHandler} from "./TBTCVaultHandler.sol";
import {BridgeHandler} from "./BridgeHandler.sol";
import {ReservationRouterHandler} from "./ReservationRouterHandler.sol";
import {ReservationVaultHandler} from "./ReservationVaultHandler.sol";
import {RebateStakingHandler} from "./RebateStakingHandler.sol";
import {RedemptionWatchtowerHandler} from "./RedemptionWatchtowerHandler.sol";

/// @notice Inherits from all the handlers to expose all entry points in a single contract.
///         Manages environment changes (e.g. current actor, current token, mocks setup, etc.).
abstract contract Handlers is
    BankHandler,
    TBTCHandler,
    TBTCVaultHandler,
    BridgeHandler,
    ReservationRouterHandler,
    ReservationVaultHandler,
    RebateStakingHandler,
    RedemptionWatchtowerHandler
{
    function setCurrentActor(uint256 entropy) public {
        actor = actors[entropy % actors.length];
    }
}
