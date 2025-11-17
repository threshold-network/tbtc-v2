// SPDX-License-Identifier: GPL-3.0-only

pragma solidity 0.8.17;

import "./TestERC20.sol";
import "../cross-chain/wormhole/Wormhole.sol";

/// @dev Stub contract used in L2WormholeGateway unit tests.
///      Stub contract is used instead of a smock because of the token transfer
///      that needs to happen in completeTransferWithPayload function.
contract WormholeBridgeStub is IWormholeTokenBridge {
    TestERC20 public wormholeToken;

    uint256 public transferAmount;
    bytes32 public receiverAddress;
    bytes32 public fromAddress =
        0x7000000000000000000000000000000000000000000000000000000000000000; // Default value
    uint16 public tokenChain = 4; // Default value

    // Two simple events allowing to assert Wormhole bridge functions are
    // called.
    event WormholeBridgeStub_completeTransferWithPayload(bytes encodedVm);
    event WormholeBridgeStub_transferTokens(
        address token,
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient,
        uint256 arbiterFee,
        uint32 nonce
    );
    event WormholeBridgeStub_transferTokensWithPayload(
        address token,
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient,
        uint32 nonce,
        bytes payload
    );

    constructor(TestERC20 _wormholeToken) {
        wormholeToken = _wormholeToken;
    }

    function completeTransferWithPayload(bytes memory encodedVm)
        external
        returns (bytes memory)
    {
        emit WormholeBridgeStub_completeTransferWithPayload(encodedVm);
        wormholeToken.mint(msg.sender, transferAmount);

        // In a real implementation, encodedVm is parsed. To avoid copy-pasting
        // Wormhole code to this contract and then encoding parmaters in unit
        // tests, we allow to set the receiver address on the stub contract and
        // we return it here. The rest of the parameters does not matter.
        IWormholeTokenBridge.TransferWithPayload memory transfer = IWormholeTokenBridge
            .TransferWithPayload(
                1, // payloadID
                2, // amount
                0x3000000000000000000000000000000000000000000000000000000000000000, // tokenAddress
                tokenChain, // tokenChain - now uses the configurable value
                0x5000000000000000000000000000000000000000000000000000000000000000, // to
                6, // toChain
                fromAddress, // fromAddress - now uses the configurable value
                abi.encode(receiverAddress) // payload
            );

        return abi.encode(transfer);
    }

    function transferTokens(
        address token,
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient,
        uint256 arbiterFee,
        uint32 nonce
    ) external payable returns (uint64 sequence) {
        emit WormholeBridgeStub_transferTokens(
            token,
            amount,
            recipientChain,
            recipient,
            arbiterFee,
            nonce
        );
        return 777;
    }

    function transferTokensWithPayload(
        address token,
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient,
        uint32 nonce,
        bytes memory payload
    ) external payable returns (uint64 sequence) {
        emit WormholeBridgeStub_transferTokensWithPayload(
            token,
            amount,
            recipientChain,
            recipient,
            nonce,
            payload
        );
        return 888;
    }

    function parseTransferWithPayload(bytes memory encoded)
        external
        pure
        returns (IWormholeTokenBridge.TransferWithPayload memory transfer)
    {
        return abi.decode(encoded, (IWormholeTokenBridge.TransferWithPayload));
    }

    function setTransferAmount(uint256 _transferAmount) external {
        transferAmount = _transferAmount;
    }

    function setReceiverAddress(bytes32 _receiverAddress) external {
        receiverAddress = _receiverAddress;
    }

    function setFromAddress(bytes32 _fromAddress) external {
        fromAddress = _fromAddress;
    }

    function setTokenChain(uint16 _tokenChain) external {
        tokenChain = _tokenChain;
    }

    // Allows to mint Wormhole tBTC for depositWormholeTbtc unit tests.
    function mintWormholeToken(address to, uint256 amount) external {
        wormholeToken.mint(to, amount);
    }
}
