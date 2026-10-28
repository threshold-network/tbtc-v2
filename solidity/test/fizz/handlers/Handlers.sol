// SPDX-License-Identifier: MIT
pragma solidity >=0.6.2 <0.9.0;

import {BridgeHandler} from "./BridgeHandler.sol";
import {ReservationRouterHandler} from "./ReservationRouterHandler.sol";

/// @notice The fixture surface the audit guards inherit: the Bridge and
///         ReservationRouter entry points they drive, on top of the
///         deployment in `Base.sol`.
abstract contract Handlers is BridgeHandler, ReservationRouterHandler {}
