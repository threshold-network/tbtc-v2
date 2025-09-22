// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

// Note: These imports would normally be from wormhole-solidity-sdk
// For this temporary location, we'll define the required functions inline
import "./TrimmedAmount.sol";

// Minimal BytesParsing library functions needed
library BytesParsing {
    function asBytes32Unchecked(bytes memory data, uint256 offset) internal pure returns (bytes32 result, uint256 newOffset) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            result := mload(add(add(data, 0x20), offset))
            newOffset := add(offset, 0x20)
        }
    }
    
    function asBytes4Unchecked(bytes memory data, uint256 offset) internal pure returns (bytes4 result, uint256 newOffset) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            result := mload(add(add(data, 0x20), offset))
            newOffset := add(offset, 0x04)
        }
    }
    
    function asUint8Unchecked(bytes memory data, uint256 offset) internal pure returns (uint8 result, uint256 newOffset) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            result := byte(0, mload(add(add(data, 0x20), offset)))
            newOffset := add(offset, 0x01)
        }
    }
    
    function asUint16Unchecked(bytes memory data, uint256 offset) internal pure returns (uint16 result, uint256 newOffset) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            result := shr(240, mload(add(add(data, 0x20), offset)))
            newOffset := add(offset, 0x02)
        }
    }
    
    function asUint64Unchecked(bytes memory data, uint256 offset) internal pure returns (uint64 result, uint256 newOffset) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            result := shr(192, mload(add(add(data, 0x20), offset)))
            newOffset := add(offset, 0x08)
        }
    }
    
    function sliceUnchecked(bytes memory data, uint256 offset, uint256 length) internal pure returns (bytes memory result, uint256 newOffset) {
        result = new bytes(length);
        // solhint-disable-next-line no-inline-assembly
        assembly {
            let src := add(add(data, 0x20), offset)
            let dst := add(result, 0x20)
            for { let i := 0 } lt(i, length) { i := add(i, 0x20) } {
                mstore(add(dst, i), mload(add(src, i)))
            }
            newOffset := add(offset, length)
        }
    }
    
    function checkLength(bytes memory data, uint256 expectedLength) internal pure {
        require(data.length == expectedLength, "Invalid data length");
    }
}

library TransceiverStructs {
    using BytesParsing for bytes;
    using TrimmedAmountLib for TrimmedAmount;

    /// @notice Error thrown when the payload length exceeds the allowed maximum.
    /// @dev Selector 0xa3419691.
    /// @param size The size of the payload.
    error PayloadTooLong(uint256 size);

    /// @notice Error thrown when the prefix of an encoded message
    ///         does not match the expected value.
    /// @dev Selector 0x56d2569d.
    /// @param prefix The prefix that was found in the encoded message.
    error IncorrectPrefix(bytes4 prefix);

    /// @notice Error thrown when the transceiver instructions aren't
    ///         encoded with strictly increasing indices
    /// @dev Selector 0x0555a4b9.
    /// @param lastIndex Last parsed instruction index
    /// @param instructionIndex The instruction index that was unordered
    error UnorderedInstructions(uint256 lastIndex, uint256 instructionIndex);

    /// @dev Prefix for all NativeTokenTransfer payloads
    ///      This is 0x99'N''T''T'
    bytes4 internal constant NTT_PREFIX = 0x994E5454;

    /// @notice Error thrown when a transceiver instruction index
    ///         is greater than the number of registered transceivers
    /// @dev We index from 0 so if providedIndex == numTransceivers then we're out-of-bounds too
    /// @dev Selector 0x689f5016.
    /// @param providedIndex The index specified in the instruction
    /// @param numTransceivers The number of registered transceivers
    error InvalidInstructionIndex(uint256 providedIndex, uint256 numTransceivers);

    /// @dev Message emitted and received by the nttManager contract.
    ///      The wire format is as follows:
    ///      - id - 32 bytes
    ///      - sender - 32 bytes
    ///      - payloadLength - 2 bytes
    ///      - payload - `payloadLength` bytes
    struct NttManagerMessage {
        /// @notice unique message identifier
        /// @dev This is incrementally assigned on EVM chains, but this is not
        /// guaranteed on other runtimes.
        bytes32 id;
        /// @notice original message sender address.
        bytes32 sender;
        /// @notice payload that corresponds to the type.
        bytes payload;
    }

    function nttManagerMessageDigest(
        uint16 sourceChainId,
        NttManagerMessage memory m
    ) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(sourceChainId, encodeNttManagerMessage(m)));
    }

    function encodeNttManagerMessage(
        NttManagerMessage memory m
    ) public pure returns (bytes memory encoded) {
        if (m.payload.length > type(uint16).max) {
            revert PayloadTooLong(m.payload.length);
        }
        uint16 payloadLength = uint16(m.payload.length);
        return abi.encodePacked(m.id, m.sender, payloadLength, m.payload);
    }

    /// @notice Parse a NttManagerMessage.
    /// @param encoded The byte array corresponding to the encoded message
    /// @return nttManagerMessage The parsed NttManagerMessage struct.
    function parseNttManagerMessage(
        bytes memory encoded
    ) public pure returns (NttManagerMessage memory nttManagerMessage) {
        uint256 offset = 0;
        (nttManagerMessage.id, offset) = encoded.asBytes32Unchecked(offset);
        (nttManagerMessage.sender, offset) = encoded.asBytes32Unchecked(offset);
        uint256 payloadLength;
        (payloadLength, offset) = encoded.asUint16Unchecked(offset);
        (nttManagerMessage.payload, offset) = encoded.sliceUnchecked(offset, payloadLength);
        encoded.checkLength(offset);
    }

    /// @dev Native Token Transfer payload.
    ///      The wire format is as follows:
    ///      - NTT_PREFIX - 4 bytes
    ///      - numDecimals - 1 byte
    ///      - amount - 8 bytes
    ///      - sourceToken - 32 bytes
    ///      - to - 32 bytes
    ///      - toChain - 2 bytes
    struct NativeTokenTransfer {
        /// @notice Amount being transferred (big-endian u64 and u8 for decimals)
        TrimmedAmount amount;
        /// @notice Source chain token address.
        bytes32 sourceToken;
        /// @notice Address of the recipient.
        bytes32 to;
        /// @notice Chain ID of the recipient
        uint16 toChain;
    }

    function encodeNativeTokenTransfer(
        NativeTokenTransfer memory m
    ) public pure returns (bytes memory encoded) {
        // The `amount` and `decimals` fields are encoded in reverse order compared to how they are declared in the
        // `TrimmedAmount` type. This is consistent with the Rust NTT implementation.
        TrimmedAmount transferAmount = m.amount;
        return abi.encodePacked(
            NTT_PREFIX,
            transferAmount.getDecimals(),
            transferAmount.getAmount(),
            m.sourceToken,
            m.to,
            m.toChain
        );
    }

    /// @dev Parse a NativeTokenTransfer.
    /// @param encoded The byte array corresponding to the encoded message
    /// @return nativeTokenTransfer The parsed NativeTokenTransfer struct.
    function parseNativeTokenTransfer(
        bytes memory encoded
    ) public pure returns (NativeTokenTransfer memory nativeTokenTransfer) {
        uint256 offset = 0;
        bytes4 prefix;
        (prefix, offset) = encoded.asBytes4Unchecked(offset);
        if (prefix != NTT_PREFIX) {
            revert IncorrectPrefix(prefix);
        }

        // The `amount` and `decimals` fields are parsed in reverse order compared to how they are declared in the
        // `TrimmedAmount` struct. This is consistent with the Rust NTT implementation.
        uint8 numDecimals;
        (numDecimals, offset) = encoded.asUint8Unchecked(offset);
        uint64 amount;
        (amount, offset) = encoded.asUint64Unchecked(offset);
        nativeTokenTransfer.amount = packTrimmedAmount(amount, numDecimals);

        (nativeTokenTransfer.sourceToken, offset) = encoded.asBytes32Unchecked(offset);
        (nativeTokenTransfer.to, offset) = encoded.asBytes32Unchecked(offset);
        (nativeTokenTransfer.toChain, offset) = encoded.asUint16Unchecked(offset);
        encoded.checkLength(offset);
    }

    /// @dev Message emitted by Transceiver implementations.
    ///      Each message includes an Transceiver-specified 4-byte prefix.
    ///      The wire format is as follows:
    ///      - prefix - 4 bytes
    ///      - sourceNttManagerAddress - 32 bytes
    ///      - recipientNttManagerAddress - 32 bytes
    ///      - nttManagerPayloadLength - 2 bytes
    ///      - nttManagerPayload - `nttManagerPayloadLength` bytes
    ///      - transceiverPayloadLength - 2 bytes
    ///      - transceiverPayload - `transceiverPayloadLength` bytes
    struct TransceiverMessage {
        /// @notice Address of the NttManager contract that emitted this message.
        bytes32 sourceNttManagerAddress;
        /// @notice Address of the NttManager contract that receives this message.
        bytes32 recipientNttManagerAddress;
        /// @notice Payload provided to the Transceiver contract by the NttManager contract.
        bytes nttManagerPayload;
        /// @notice Optional payload that the transceiver can encode and use for its own message passing purposes.
        bytes transceiverPayload;
    }

    // @notice Encodes an Transceiver message for communication between the
    //         NttManager and the Transceiver.
    // @param m The TransceiverMessage struct containing the message details.
    // @return encoded The byte array corresponding to the encoded message.
    // @custom:throw PayloadTooLong if the length of transceiverId, nttManagerPayload,
    //         or transceiverPayload exceeds the allowed maximum.
    function encodeTransceiverMessage(
        bytes4 prefix,
        TransceiverMessage memory m
    ) public pure returns (bytes memory encoded) {
        if (m.nttManagerPayload.length > type(uint16).max) {
            revert PayloadTooLong(m.nttManagerPayload.length);
        }
        uint16 nttManagerPayloadLength = uint16(m.nttManagerPayload.length);

        if (m.transceiverPayload.length > type(uint16).max) {
            revert PayloadTooLong(m.transceiverPayload.length);
        }
        uint16 transceiverPayloadLength = uint16(m.transceiverPayload.length);

        return abi.encodePacked(
            prefix,
            m.sourceNttManagerAddress,
            m.recipientNttManagerAddress,
            nttManagerPayloadLength,
            m.nttManagerPayload,
            transceiverPayloadLength,
            m.transceiverPayload
        );
    }

    function buildAndEncodeTransceiverMessage(
        bytes4 prefix,
        bytes32 sourceNttManagerAddress,
        bytes32 recipientNttManagerAddress,
        bytes memory nttManagerMessage,
        bytes memory transceiverPayload
    ) public pure returns (TransceiverMessage memory, bytes memory) {
        TransceiverMessage memory transceiverMessage = TransceiverMessage({
            sourceNttManagerAddress: sourceNttManagerAddress,
            recipientNttManagerAddress: recipientNttManagerAddress,
            nttManagerPayload: nttManagerMessage,
            transceiverPayload: transceiverPayload
        });
        bytes memory encoded = encodeTransceiverMessage(prefix, transceiverMessage);
        return (transceiverMessage, encoded);
    }

    /// @dev Parses an encoded message and extracts information into an TransceiverMessage struct.
    /// @param encoded The encoded bytes containing information about the TransceiverMessage.
    /// @return transceiverMessage The parsed TransceiverMessage struct.
    /// @custom:throw IncorrectPrefix if the prefix of the encoded message does not
    ///         match the expected prefix.
    function parseTransceiverMessage(
        bytes4 expectedPrefix,
        bytes memory encoded
    ) internal pure returns (TransceiverMessage memory transceiverMessage) {
        uint256 offset = 0;
        bytes4 prefix;

        (prefix, offset) = encoded.asBytes4Unchecked(offset);

        if (prefix != expectedPrefix) {
            revert IncorrectPrefix(prefix);
        }

        (transceiverMessage.sourceNttManagerAddress, offset) = encoded.asBytes32Unchecked(offset);
        (transceiverMessage.recipientNttManagerAddress, offset) = encoded.asBytes32Unchecked(offset);
        uint16 nttManagerPayloadLength;
        (nttManagerPayloadLength, offset) = encoded.asUint16Unchecked(offset);
        (transceiverMessage.nttManagerPayload, offset) =
            encoded.sliceUnchecked(offset, nttManagerPayloadLength);
        uint16 transceiverPayloadLength;
        (transceiverPayloadLength, offset) = encoded.asUint16Unchecked(offset);
        (transceiverMessage.transceiverPayload, offset) =
            encoded.sliceUnchecked(offset, transceiverPayloadLength);

        // Check if the entire byte array has been processed
        encoded.checkLength(offset);
    }

    /// @dev Parses the payload of an Transceiver message and returns
    ///      the parsed NttManagerMessage struct.
    /// @param expectedPrefix The prefix that should be encoded in the nttManager message.
    /// @param payload The payload sent across the wire.
    function parseTransceiverAndNttManagerMessage(
        bytes4 expectedPrefix,
        bytes memory payload
    ) public pure returns (TransceiverMessage memory, NttManagerMessage memory) {
        // parse the encoded message payload from the Transceiver
        TransceiverMessage memory parsedTransceiverMessage =
            parseTransceiverMessage(expectedPrefix, payload);

        // parse the encoded message payload from the NttManager
        NttManagerMessage memory parsedNttManagerMessage =
            parseNttManagerMessage(parsedTransceiverMessage.nttManagerPayload);

        return (parsedTransceiverMessage, parsedNttManagerMessage);
    }

    /// @dev Variable-length transceiver-specific instruction that can be passed by the caller to the nttManager.
    ///      The index field refers to the index of the registeredTransceiver that this instruction should be passed to.
    ///      The serialization format is:
    ///      - index - 1 byte
    ///      - payloadLength - 1 byte
    ///      - payload - `payloadLength` bytes
    struct TransceiverInstruction {
        uint8 index;
        bytes payload;
    }

    function encodeTransceiverInstruction(
        TransceiverInstruction memory instruction
    ) public pure returns (bytes memory) {
        if (instruction.payload.length > type(uint8).max) {
            revert PayloadTooLong(instruction.payload.length);
        }
        uint8 payloadLength = uint8(instruction.payload.length);
        return abi.encodePacked(instruction.index, payloadLength, instruction.payload);
    }

    function parseTransceiverInstructionUnchecked(
        bytes memory encoded,
        uint256 offset
    ) public pure returns (TransceiverInstruction memory instruction, uint256 nextOffset) {
        (instruction.index, nextOffset) = encoded.asUint8Unchecked(offset);
        uint8 instructionLength;
        (instructionLength, nextOffset) = encoded.asUint8Unchecked(nextOffset);
        (instruction.payload, nextOffset) = encoded.sliceUnchecked(nextOffset, instructionLength);
    }

    function parseTransceiverInstructionChecked(
        bytes memory encoded
    ) public pure returns (TransceiverInstruction memory instruction) {
        uint256 offset = 0;
        (instruction, offset) = parseTransceiverInstructionUnchecked(encoded, offset);
        encoded.checkLength(offset);
    }

    /// @dev Encode an array of multiple variable-length transceiver-specific instructions.
    ///      The serialization format is:
    ///      - instructionsLength - 1 byte
    ///      - `instructionsLength` number of serialized `TransceiverInstruction` types.
    function encodeTransceiverInstructions(
        TransceiverInstruction[] memory instructions
    ) public pure returns (bytes memory) {
        if (instructions.length > type(uint8).max) {
            revert PayloadTooLong(instructions.length);
        }
        uint256 instructionsLength = instructions.length;

        bytes memory encoded;
        for (uint256 i = 0; i < instructionsLength; i++) {
            bytes memory innerEncoded = encodeTransceiverInstruction(instructions[i]);
            encoded = bytes.concat(encoded, innerEncoded);
        }
        return abi.encodePacked(uint8(instructionsLength), encoded);
    }

    function parseTransceiverInstructions(
        bytes memory encoded,
        uint256 numRegisteredTransceivers
    ) public pure returns (TransceiverInstruction[] memory) {
        uint256 offset = 0;
        uint256 instructionsLength;
        (instructionsLength, offset) = encoded.asUint8Unchecked(offset);

        // We allocate an array with the length of the number of registered transceivers
        // This gives us the flexibility to not have to pass instructions for transceivers that
        // don't need them
        TransceiverInstruction[] memory instructions =
            new TransceiverInstruction[](numRegisteredTransceivers);

        uint256 lastIndex = 0;
        for (uint256 i = 0; i < instructionsLength; i++) {
            TransceiverInstruction memory instruction;
            (instruction, offset) = parseTransceiverInstructionUnchecked(encoded, offset);

            uint8 instructionIndex = instruction.index;

            // The instructions passed in have to be strictly increasing in terms of transceiver index
            if (i != 0 && instructionIndex <= lastIndex) {
                revert UnorderedInstructions(lastIndex, instructionIndex);
            }

            // Instruction index is out of bounds
            if (instructionIndex >= numRegisteredTransceivers) {
                revert InvalidInstructionIndex(instructionIndex, numRegisteredTransceivers);
            }

            lastIndex = instructionIndex;

            instructions[instructionIndex] = instruction;
        }

        encoded.checkLength(offset);

        return instructions;
    }

    struct TransceiverInit {
        bytes4 transceiverIdentifier;
        bytes32 nttManagerAddress;
        uint8 nttManagerMode;
        bytes32 tokenAddress;
        uint8 tokenDecimals;
    }

    function encodeTransceiverInit(
        TransceiverInit memory init
    ) public pure returns (bytes memory) {
        return abi.encodePacked(
            init.transceiverIdentifier,
            init.nttManagerAddress,
            init.nttManagerMode,
            init.tokenAddress,
            init.tokenDecimals
        );
    }

    function decodeTransceiverInit(
        bytes memory encoded
    ) public pure returns (TransceiverInit memory init) {
        uint256 offset = 0;
        (init.transceiverIdentifier, offset) = encoded.asBytes4Unchecked(offset);
        (init.nttManagerAddress, offset) = encoded.asBytes32Unchecked(offset);
        (init.nttManagerMode, offset) = encoded.asUint8Unchecked(offset);
        (init.tokenAddress, offset) = encoded.asBytes32Unchecked(offset);
        (init.tokenDecimals, offset) = encoded.asUint8Unchecked(offset);
        encoded.checkLength(offset);
    }

    struct TransceiverRegistration {
        bytes4 transceiverIdentifier;
        uint16 transceiverChainId;
        bytes32 transceiverAddress;
    }

    function encodeTransceiverRegistration(
        TransceiverRegistration memory registration
    ) public pure returns (bytes memory) {
        return abi.encodePacked(
            registration.transceiverIdentifier,
            registration.transceiverChainId,
            registration.transceiverAddress
        );
    }

    function decodeTransceiverRegistration(
        bytes memory encoded
    ) public pure returns (TransceiverRegistration memory registration) {
        uint256 offset = 0;
        (registration.transceiverIdentifier, offset) = encoded.asBytes4Unchecked(offset);
        (registration.transceiverChainId, offset) = encoded.asUint16Unchecked(offset);
        (registration.transceiverAddress, offset) = encoded.asBytes32Unchecked(offset);
        encoded.checkLength(offset);
    }
}
