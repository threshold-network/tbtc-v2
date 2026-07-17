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

/// @title WormholeTypes
/// @notice Namespace which groups all types relevant to Wormhole interfaces.
library WormholeTypes {
    /// @dev See: https://github.com/wormhole-foundation/wormhole-solidity-sdk/blob/2b7db51f99b49eda99b44f4a044e751cb0b2e8ea/src/interfaces/IWormholeRelayer.sol#L22
    struct VaaKey {
        uint16 chainId;
        bytes32 emitterAddress;
        uint64 sequence;
    }
}

/// @title IWormholeGateway
/// @notice Interface to the `L2WormholeGateway` contract.
interface IWormholeGateway {
    /// @dev See ./L2WormholeGateway.sol#receiveTbtc
    function receiveTbtc(bytes memory vaa) external;
}

/// @title IWormhole
/// @notice Wormhole interface.
/// @dev See: https://github.com/wormhole-foundation/wormhole-solidity-sdk/blob/2b7db51f99b49eda99b44f4a044e751cb0b2e8ea/src/interfaces/IWormhole.sol#L6
interface IWormhole {
    /// @dev See: https://github.com/wormhole-foundation/wormhole-solidity-sdk/blob/2b7db51f99b49eda99b44f4a044e751cb0b2e8ea/src/interfaces/IWormhole.sol#L109
    function chainId() external view returns (uint16);

    /// @dev See: https://github.com/wormhole-foundation/wormhole-solidity-sdk/blob/2b7db51f99b49eda99b44f4a044e751cb0b2e8ea/src/interfaces/IWormhole.sol#L117
    function messageFee() external view returns (uint256);
}

/// @title IWormholeRelayer
/// @notice Wormhole Relayer interface.
/// @dev See: https://github.com/wormhole-foundation/wormhole-solidity-sdk/blob/2b7db51f99b49eda99b44f4a044e751cb0b2e8ea/src/interfaces/IWormholeRelayer.sol#L74
interface IWormholeRelayer {
    /// @dev See: https://github.com/wormhole-foundation/wormhole-solidity-sdk/blob/2b7db51f99b49eda99b44f4a044e751cb0b2e8ea/src/interfaces/IWormholeRelayer.sol#L442
    function quoteEVMDeliveryPrice(
        uint16 targetChain,
        uint256 receiverValue,
        uint256 gasLimit
    )
        external
        view
        returns (
            uint256 nativePriceQuote,
            uint256 targetChainRefundPerGasUnused
        );

    /// @dev See: https://github.com/wormhole-foundation/wormhole-solidity-sdk/blob/2b7db51f99b49eda99b44f4a044e751cb0b2e8ea/src/interfaces/IWormholeRelayer.sol#L182
    function sendVaasToEvm(
        uint16 targetChain,
        address targetAddress,
        bytes memory payload,
        uint256 receiverValue,
        uint256 gasLimit,
        WormholeTypes.VaaKey[] memory vaaKeys,
        uint16 refundChain,
        address refundAddress
    ) external payable returns (uint64 sequence);
}

/// @title IWormholeReceiver
/// @notice Wormhole Receiver interface.
/// @dev See: https://github.com/wormhole-foundation/wormhole-solidity-sdk/blob/2b7db51f99b49eda99b44f4a044e751cb0b2e8ea/src/interfaces/IWormholeReceiver.sol#L8
interface IWormholeReceiver {
    /// @dev See: https://github.com/wormhole-foundation/wormhole-solidity-sdk/blob/2b7db51f99b49eda99b44f4a044e751cb0b2e8ea/src/interfaces/IWormholeReceiver.sol#L44
    function receiveWormholeMessages(
        bytes memory payload,
        bytes[] memory additionalVaas,
        bytes32 sourceAddress,
        uint16 sourceChain,
        bytes32 deliveryHash
    ) external payable;
}

/// @title IWormholeTokenBridge
/// @notice Wormhole Token Bridge interface.
/// @dev See: https://github.com/wormhole-foundation/wormhole-solidity-sdk/blob/2b7db51f99b49eda99b44f4a044e751cb0b2e8ea/src/interfaces/ITokenBridge.sol#L9
interface IWormholeTokenBridge {
    function completeTransferWithPayload(bytes memory encodedVm)
        external
        returns (bytes memory);

    function parseTransferWithPayload(bytes memory encoded)
        external
        pure
        returns (TransferWithPayload memory transfer);

    function transferTokens(
        address token,
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient,
        uint256 arbiterFee,
        uint32 nonce
    ) external payable returns (uint64 sequence);

    function transferTokensWithPayload(
        address token,
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient,
        uint32 nonce,
        bytes memory payload
    ) external payable returns (uint64 sequence);

    struct TransferWithPayload {
        uint8 payloadID;
        uint256 amount;
        bytes32 tokenAddress;
        uint16 tokenChain;
        bytes32 to;
        uint16 toChain;
        bytes32 fromAddress;
        bytes payload;
    }
}

/// @title WormholeUtils
/// @notice Library for Wormhole utilities.
library WormholeUtils {
    /// @notice Converts Ethereum address into Wormhole format.
    /// @param _address The address to convert.
    function toWormholeAddress(address _address)
        internal
        pure
        returns (bytes32)
    {
        return bytes32(uint256(uint160(_address)));
    }

    /// @notice Converts Wormhole address into Ethereum format.
    /// @param _address The address to convert.
    function fromWormholeAddress(bytes32 _address)
        internal
        pure
        returns (address)
    {
        return address(uint160(uint256(_address)));
    }

    /// @dev Eliminates the dust that cannot be bridged with Wormhole
    ///      due to the decimal shift in the Wormhole Bridge contract.
    ///      See https://github.com/wormhole-foundation/wormhole/blob/96682bdbeb7c87bfa110eade0554b3d8cbf788d2/ethereum/contracts/bridge/Bridge.sol#L276-L288
    function normalize(uint256 amount) internal pure returns (uint256) {
        // slither-disable-next-line divide-before-multiply
        amount /= 10**10;
        amount *= 10**10;
        return amount;
    }
}
