// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

/// @notice Test-only stand-in for `@keep-network/random-beacon`'s
///         ReimbursementPool.
/// @dev Replaces `smock.fake<ReimbursementPool>("ReimbursementPool")`.
///
///      smock is archived upstream (`wonderland-archive/smock`, no further
///      support or security patches) and it is the reason this package cannot
///      move past hardhat 2.19.x, which in turn caps the toolchain at Node 22.
///      A plain Solidity stub carries none of that: it has no JavaScript
///      dependency, so it survives hardhat 2 -> 3, ethers -> viem, and a move
///      to Foundry.
///
///      Behaviour is deliberately the subset the tests use, not the whole
///      contract:
///
///      - `refund` records every call instead of transferring anything. The
///        recorded calls replace smock's `refund.getCall(n).args` and the
///        `calledOnce` / `calledTwice` matchers, via `refundCallCount()` and
///        `refundCall(i)`.
///      - `maxGasPrice`, `staticGas`, `owner` and `isAuthorized` return values
///        the test sets, replacing smock's `.returns(...)`.
///      - `resetRefundCalls()` replaces `refund.reset()`.
///
///      Assertions become state reads rather than spy matchers, which is why
///      this needs no chai plugin.
contract ReimbursementPoolStub {
    struct RefundCall {
        uint256 gasSpent;
        address receiver;
    }

    RefundCall[] internal refundCalls;

    uint256 public maxGasPrice = 20000000000;
    uint256 public staticGas = 40800;
    address public owner;
    bool internal authorizedDefault = true;

    mapping(address => bool) internal authorizedOverride;
    mapping(address => bool) internal authorizedOverrideSet;

    /// @notice Records the call. The production contract would transfer ETH;
    ///         every test that uses this stub asserts on the call, not on a
    ///         balance change.
    function refund(uint256 gasSpent, address receiver) external {
        refundCalls.push(RefundCall(gasSpent, receiver));
    }

    function isAuthorized(address account) external view returns (bool) {
        if (authorizedOverrideSet[account]) {
            return authorizedOverride[account];
        }
        return authorizedDefault;
    }

    // --- test controls -----------------------------------------------------

    function refundCallCount() external view returns (uint256) {
        return refundCalls.length;
    }

    /// @notice Arguments of the i-th `refund` call, replacing smock's
    ///         `refund.getCall(i).args`.
    function refundCall(uint256 index)
        external
        view
        returns (uint256 gasSpent, address receiver)
    {
        RefundCall storage call = refundCalls[index];
        return (call.gasSpent, call.receiver);
    }

    function resetRefundCalls() external {
        delete refundCalls;
    }

    function setMaxGasPrice(uint256 _maxGasPrice) external {
        maxGasPrice = _maxGasPrice;
    }

    function setStaticGas(uint256 _staticGas) external {
        staticGas = _staticGas;
    }

    function setOwner(address _owner) external {
        owner = _owner;
    }

    function setAuthorized(address account, bool value) external {
        authorizedOverride[account] = value;
        authorizedOverrideSet[account] = true;
    }

    function setAuthorizedDefault(bool value) external {
        authorizedDefault = value;
    }

    /// @notice Lets a test fund the stub so it can be the target of value
    ///         transfers if a future case needs it.
    receive() external payable {}
}
