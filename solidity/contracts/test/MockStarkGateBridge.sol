// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import "../cross-chain/starknet/interfaces/IStarkGateBridge.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockStarkGateBridge is IStarkGateBridge {
    uint256 public messageNonce = 1;
    uint256 private _depositWithMessageReturn = 1;
    bool private _shouldRevert;
    uint256 private _customFee;
    bool private _useCustomFee;
    bool private _shouldRevertEstimate;
    uint256 private _messageFee;
    uint256 private _depositCount;

    // Track calls for testing
    struct DepositCall {
        address token;
        uint256 amount;
        uint256 l2Recipient;
        uint256 messageFee;
        uint256[] callData;
    }

    struct SimpleDepositCall {
        address token;
        uint256 amount;
        uint256 l2Recipient;
    }

    DepositCall private _lastDepositCall;
    bool public depositWithMessageCalled;
    bool public depositCalled;
    SimpleDepositCall public lastSimpleDepositCall;

    // Additional deposit() function for tests that expect it
    function deposit(
        address token,
        uint256 amount,
        uint256 l2Recipient
    ) external payable override {
        require(!_shouldRevert, "Mock revert");
        depositCalled = true;
        lastSimpleDepositCall = SimpleDepositCall({
            token: token,
            amount: amount,
            l2Recipient: l2Recipient
        });
        // Don't internally call depositWithMessage to avoid double transfer
        // Just update the state directly
        _depositCount++;
        _lastDepositCall = DepositCall({
            token: token,
            amount: amount,
            l2Recipient: l2Recipient,
            messageFee: msg.value,
            callData: new uint256[](0)
        });

        // Transfer tokens from sender
        IERC20(token).transferFrom(msg.sender, address(this), amount);
    }

    function depositWithMessage(
        address token,
        uint256 amount,
        uint256 l2Recipient,
        uint256[] calldata message
    ) external payable returns (uint256, uint256) {
        require(!_shouldRevert, "Mock revert");

        // Actually transfer tokens to simulate real StarkGate behavior
        IERC20(token).transferFrom(msg.sender, address(this), amount);

        depositWithMessageCalled = true;
        _messageFee = msg.value;
        _depositCount++;
        _lastDepositCall = DepositCall({
            token: token,
            amount: amount,
            l2Recipient: l2Recipient,
            messageFee: msg.value,
            callData: message
        });
        return (_depositWithMessageReturn, block.timestamp); // solhint-disable-line not-rely-on-time
    }

    function estimateDepositFeeWei() external view override returns (uint256) {
        if (_shouldRevertEstimate) {
            revert("Mock revert estimate");
        }
        if (_useCustomFee) {
            return _customFee;
        }
        return 0.01 ether;
    }

    function depositWithMessageCancelRequest(
        address,
        uint256,
        uint256,
        uint256[] calldata,
        uint256
    ) external {
        // Mock implementation
    }

    function l1ToL2MessageNonce() external view returns (uint256) {
        return messageNonce;
    }

    function isDepositCancellable(uint256) external pure returns (bool) {
        return true;
    }

    // Helper functions for testing
    function wasDepositWithMessageCalled() external view returns (bool) {
        return depositWithMessageCalled;
    }

    function getLastDepositRecipient() external view returns (uint256) {
        return _lastDepositCall.l2Recipient;
    }

    function getLastDepositAmount() external view returns (uint256) {
        return _lastDepositCall.amount;
    }

    function getLastDepositToken() external view returns (address) {
        return _lastDepositCall.token;
    }

    function getLastDepositValue() external view returns (uint256) {
        return _lastDepositCall.messageFee;
    }

    function getMessageFee() external view returns (uint256) {
        return _messageFee;
    }

    // Test control functions
    function setDepositWithMessageReturn(uint256 value) external {
        _depositWithMessageReturn = value;
    }

    function setShouldRevert(bool shouldRevert) external {
        _shouldRevert = shouldRevert;
    }

    function setEstimateDepositFeeWeiReturn(uint256 fee) external {
        _customFee = fee;
        _useCustomFee = true;
    }

    function setShouldRevertEstimate(bool shouldRevert) external {
        _shouldRevertEstimate = shouldRevert;
    }

    function resetMock() external {
        depositWithMessageCalled = false;
        _depositCount = 0;
        _depositWithMessageReturn = 1;
        messageNonce = 1;
        _shouldRevert = false;
        _useCustomFee = false;
        _shouldRevertEstimate = false;
        depositCalled = false;
        _messageFee = 0;
    }

    function getDepositCount() external view returns (uint256) {
        return _depositCount;
    }

    function getLastDepositCall() external view returns (DepositCall memory) {
        return _lastDepositCall;
    }

    function getLastSimpleDepositCall()
        external
        view
        returns (SimpleDepositCall memory)
    {
        return lastSimpleDepositCall;
    }
}
