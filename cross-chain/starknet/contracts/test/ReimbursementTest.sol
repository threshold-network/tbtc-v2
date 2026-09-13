// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.17;

import "../vendor/random-beacon/Reimbursable.sol";

/// @dev Minimal harness exposing the `refundable` modifier for local tests.
contract ReimbursementTest is Reimbursable {
    function run(address receiver) external refundable(receiver) {}
}
