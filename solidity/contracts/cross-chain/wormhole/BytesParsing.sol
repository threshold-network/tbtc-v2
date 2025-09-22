// SPDX-License-Identifier: Apache 2
pragma solidity ^0.8.13;

library BytesParsing {
  uint256 private constant freeMemoryPtr = 0x40;
  uint256 private constant wordSize = 32;

  error OutOfBounds(uint256 offset, uint256 length);
  error LengthMismatch(uint256 encodedLength, uint256 expectedLength);
  error InvalidBoolVal(uint8 val);

  function checkBound(uint offset, uint length) internal pure {
    if (offset > length)
      revert OutOfBounds(offset, length);
  }

  function checkLength(bytes memory encoded, uint256 expected) internal pure {
    if (encoded.length != expected)
      revert LengthMismatch(encoded.length, expected);
  }

  function sliceUnchecked(
    bytes memory encoded,
    uint offset,
    uint length
  ) internal pure returns (bytes memory ret, uint nextOffset) {
    //bail early for degenerate case
    if (length == 0)
      return (new bytes(0), offset);

    assembly ("memory-safe") {
      nextOffset := add(offset, length)
      ret := mload(freeMemoryPtr)

      //Explanation on how we copy data here:
      //  The bytes type has the following layout in memory:
      //    [length: 32 bytes, data: length bytes]
      //  So if we allocate `bytes memory foo = new bytes(1);` then `foo` will be a pointer to 33
      //    bytes where the first 32 bytes contain the length and the last byte is the actual data.
      //  Since mload always loads 32 bytes of memory at once, we use our shift variable to align
      //    our reads so that our last read lines up exactly with the last 32 bytes of `encoded`.
      //  However this also means that if the length of `encoded` is not a multiple of 32 bytes, our
      //    first read will necessarily partly contain bytes from `encoded`'s 32 length bytes that
      //    will be written into the length part of our `ret` slice.
      //  We remedy this issue by writing the length of our `ret` slice at the end, thus
      //    overwritting those garbage bytes.
      let shift := and(length, 31) //equivalent to `mod(length, 32)` but 2 gas cheaper
      if iszero(shift) {
        shift := wordSize
      }

      let dest := add(ret, shift)
      let end := add(dest, length)
      for {
        let src := add(add(encoded, shift), offset)
      } lt(dest, end) {
        src := add(src, wordSize)
        dest := add(dest, wordSize)
      } {
        mstore(dest, mload(src))
      }

      mstore(ret, length)
      //When compiling with --via-ir then normally allocated memory (i.e. via new) will have 32 byte
      //  memory alignment and so we enforce the same memory alignment here.
      mstore(freeMemoryPtr, and(add(dest, 31), not(31)))
    }
  }

  function slice(
    bytes memory encoded,
    uint offset,
    uint length
  ) internal pure returns (bytes memory ret, uint nextOffset) {
    (ret, nextOffset) = sliceUnchecked(encoded, offset, length);
    checkBound(nextOffset, encoded.length);
  }

  function asAddressUnchecked(
    bytes memory encoded,
    uint offset
  ) internal pure returns (address, uint) {
    (uint160 ret, uint nextOffset) = asUint160Unchecked(encoded, offset);
    return (address(ret), nextOffset);
  }

  function asAddress(
    bytes memory encoded,
    uint offset
  ) internal pure returns (address ret, uint nextOffset) {
    (ret, nextOffset) = asAddressUnchecked(encoded, offset);
    checkBound(nextOffset, encoded.length);
  }

  function asBoolUnchecked(
    bytes memory encoded,
    uint offset
  ) internal pure returns (bool, uint) {
    (uint8 val, uint nextOffset) = asUint8Unchecked(encoded, offset);
    if (val & 0xfe != 0)
      revert InvalidBoolVal(val);

    uint cleanedVal = uint(val);
    bool ret;
    //skip 2x iszero opcode
    assembly ("memory-safe") {
      ret := cleanedVal
    }
    return (ret, nextOffset);
  }

  function asBool(
    bytes memory encoded,
    uint offset
  ) internal pure returns (bool ret, uint nextOffset) {
    (ret, nextOffset) = asBoolUnchecked(encoded, offset);
    checkBound(nextOffset, encoded.length);
  }

  function asUint8Unchecked(
    bytes memory encoded,
    uint offset
  ) internal pure returns (uint8 ret, uint nextOffset) {
    assembly ("memory-safe") {
      nextOffset := add(offset, 1)
      ret := mload(add(encoded, nextOffset))
    }
    return (ret, nextOffset);
  }

  function asUint8(
    bytes memory encoded,
    uint offset
  ) internal pure returns (uint8 ret, uint nextOffset) {
    (ret, nextOffset) = asUint8Unchecked(encoded, offset);
    checkBound(nextOffset, encoded.length);
  }

  function asBytes1Unchecked(
    bytes memory encoded,
    uint offset
  ) internal pure returns (bytes1, uint) {
    (uint8 ret, uint nextOffset) = asUint8Unchecked(encoded, offset);
    return (bytes1(ret), nextOffset);
  }

  function asBytes1(
    bytes memory encoded,
    uint offset
  ) internal pure returns (bytes1, uint) {
    (uint8 ret, uint nextOffset) = asUint8(encoded, offset);
    return (bytes1(ret), nextOffset);
  }

  function asUint16Unchecked(
    bytes memory encoded,
    uint offset
  ) internal pure returns (uint16 ret, uint nextOffset) {
    assembly ("memory-safe") {
      nextOffset := add(offset, 2)
      ret := mload(add(encoded, nextOffset))
    }
    return (ret, nextOffset);
  }

  function asUint16(
    bytes memory encoded,
    uint offset
  ) internal pure returns (uint16 ret, uint nextOffset) {
    (ret, nextOffset) = asUint16Unchecked(encoded, offset);
    checkBound(nextOffset, encoded.length);
  }

  function asBytes2Unchecked(
    bytes memory encoded,
    uint offset
  ) internal pure returns (bytes2, uint) {
    (uint16 ret, uint nextOffset) = asUint16Unchecked(encoded, offset);
    return (bytes2(ret), nextOffset);
  }

  function asBytes2(
    bytes memory encoded,
    uint offset
  ) internal pure returns (bytes2, uint) {
    (uint16 ret, uint nextOffset) = asUint16(encoded, offset);
    return (bytes2(ret), nextOffset);
  }

  function asUint32Unchecked(
    bytes memory encoded,
    uint offset
  ) internal pure returns (uint32 ret, uint nextOffset) {
    assembly ("memory-safe") {
      nextOffset := add(offset, 4)
      ret := mload(add(encoded, nextOffset))
    }
    return (ret, nextOffset);
  }

  function asUint32(
    bytes memory encoded,
    uint offset
  ) internal pure returns (uint32 ret, uint nextOffset) {
    (ret, nextOffset) = asUint32Unchecked(encoded, offset);
    checkBound(nextOffset, encoded.length);
  }

  function asBytes4Unchecked(
    bytes memory encoded,
    uint offset
  ) internal pure returns (bytes4, uint) {
    (uint32 ret, uint nextOffset) = asUint32Unchecked(encoded, offset);
    return (bytes4(ret), nextOffset);
  }

  function asBytes4(
    bytes memory encoded,
    uint offset
  ) internal pure returns (bytes4, uint) {
    (uint32 ret, uint nextOffset) = asUint32(encoded, offset);
    return (bytes4(ret), nextOffset);
  }

  function asUint64Unchecked(
    bytes memory encoded,
    uint offset
  ) internal pure returns (uint64 ret, uint nextOffset) {
    assembly ("memory-safe") {
      nextOffset := add(offset, 8)
      ret := mload(add(encoded, nextOffset))
    }
    return (ret, nextOffset);
  }

  function asUint64(
    bytes memory encoded,
    uint offset
  ) internal pure returns (uint64 ret, uint nextOffset) {
    (ret, nextOffset) = asUint64Unchecked(encoded, offset);
    checkBound(nextOffset, encoded.length);
  }

  function asBytes8Unchecked(
    bytes memory encoded,
    uint offset
  ) internal pure returns (bytes8, uint) {
    (uint64 ret, uint nextOffset) = asUint64Unchecked(encoded, offset);
    return (bytes8(ret), nextOffset);
  }

  function asBytes8(
    bytes memory encoded,
    uint offset
  ) internal pure returns (bytes8, uint) {
    (uint64 ret, uint nextOffset) = asUint64(encoded, offset);
    return (bytes8(ret), nextOffset);
  }

  function asUint160Unchecked(
    bytes memory encoded,
    uint offset
  ) internal pure returns (uint160 ret, uint nextOffset) {
    assembly ("memory-safe") {
      nextOffset := add(offset, 20)
      ret := mload(add(encoded, nextOffset))
    }
    return (ret, nextOffset);
  }

  function asUint160(
    bytes memory encoded,
    uint offset
  ) internal pure returns (uint160 ret, uint nextOffset) {
    (ret, nextOffset) = asUint160Unchecked(encoded, offset);
    checkBound(nextOffset, encoded.length);
  }

  function asBytes20Unchecked(
    bytes memory encoded,
    uint offset
  ) internal pure returns (bytes20, uint) {
    (uint160 ret, uint nextOffset) = asUint160Unchecked(encoded, offset);
    return (bytes20(ret), nextOffset);
  }

  function asBytes20(
    bytes memory encoded,
    uint offset
  ) internal pure returns (bytes20, uint) {
    (uint160 ret, uint nextOffset) = asUint160(encoded, offset);
    return (bytes20(ret), nextOffset);
  }

  function asUint256Unchecked(
    bytes memory encoded,
    uint offset
  ) internal pure returns (uint256 ret, uint nextOffset) {
    assembly ("memory-safe") {
      nextOffset := add(offset, 32)
      ret := mload(add(encoded, nextOffset))
    }
    return (ret, nextOffset);
  }

  function asUint256(
    bytes memory encoded,
    uint offset
  ) internal pure returns (uint256 ret, uint nextOffset) {
    (ret, nextOffset) = asUint256Unchecked(encoded, offset);
    checkBound(nextOffset, encoded.length);
  }

  function asBytes32Unchecked(
    bytes memory encoded,
    uint offset
  ) internal pure returns (bytes32, uint) {
    (uint256 ret, uint nextOffset) = asUint256Unchecked(encoded, offset);
    return (bytes32(ret), nextOffset);
  }

  function asBytes32(
    bytes memory encoded,
    uint offset
  ) internal pure returns (bytes32, uint) {
    (uint256 ret, uint nextOffset) = asUint256(encoded, offset);
    return (bytes32(ret), nextOffset);
  }
}
