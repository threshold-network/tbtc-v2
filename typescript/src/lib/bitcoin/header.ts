import { BigNumber } from "@ethersproject/bignumber"
import { Hex } from "../utils"
import { BitcoinHashUtils } from "./hash"

/**
 * BitcoinHeader represents the header of a Bitcoin block. For reference, see:
 * https://developer.bitcoin.org/reference/block_chain.html#block-headers.
 */
export interface BitcoinHeader {
  /**
   * The block version number that indicates which set of block validation rules
   * to follow. The field is 4-byte long.
   */
  version: number

  /**
   * The hash of the previous block's header. The field is 32-byte long.
   */
  previousBlockHeaderHash: Hex

  /**
   * The hash derived from the hashes of all transactions included in this block.
   * The field is 32-byte long.
   */
  merkleRootHash: Hex

  /**
   * The Unix epoch time when the miner started hashing the header. The field is
   * 4-byte long.
   */
  time: number

  /**
   * Bits that determine the target threshold this block's header hash must be
   * less than or equal to. The field is 4-byte long.
   */
  bits: number

  /**
   * An arbitrary number miners change to modify the header hash in order to
   * produce a hash less than or equal to the target threshold. The field is
   * 4-byte long.
   */
  nonce: number
}

/**
 * Serializes a Bitcoin block header to the raw representation.
 * @param header - Bitcoin block header.
 * @returns Serialized Bitcoin block header.
 */
function serializeHeader(header: BitcoinHeader): Hex {
  const buffer = Buffer.alloc(80)
  buffer.writeUInt32LE(header.version, 0)
  header.previousBlockHeaderHash.toBuffer().copy(buffer, 4)
  header.merkleRootHash.toBuffer().copy(buffer, 36)
  buffer.writeUInt32LE(header.time, 68)
  buffer.writeUInt32LE(header.bits, 72)
  buffer.writeUInt32LE(header.nonce, 76)
  return Hex.from(buffer)
}

/**
 * Deserializes a raw representation of a Bitcoin block header.
 * @param rawHeader - Raw Bitcoin block header.
 * @returns Deserialized Bitcoin block header.
 */
function deserializeHeader(rawHeader: Hex): BitcoinHeader {
  const buffer = rawHeader.toBuffer()
  const version = buffer.readUInt32LE(0)
  const previousBlockHeaderHash = buffer.slice(4, 36)
  const merkleRootHash = buffer.slice(36, 68)
  const time = buffer.readUInt32LE(68)
  const bits = buffer.readUInt32LE(72)
  const nonce = buffer.readUInt32LE(76)

  return {
    version: version,
    previousBlockHeaderHash: Hex.from(previousBlockHeaderHash),
    merkleRootHash: Hex.from(merkleRootHash),
    time: time,
    bits: bits,
    nonce: nonce,
  }
}

/**
 * Deserializes a raw representation of a Bitcoin block headers chain.
 * @param rawHeadersChain - Raw Bitcoin block headers chain.
 * @returns Deserialized Bitcoin block headers.
 */
function deserializeHeadersChain(rawHeadersChain: Hex): BitcoinHeader[] {
  const headersChain = rawHeadersChain.toString()
  if (headersChain.length % 160 !== 0) {
    throw new Error("Incorrect length of Bitcoin headers")
  }

  const result: BitcoinHeader[] = []
  for (let i = 0; i < headersChain.length; i += 160) {
    result.push(deserializeHeader(Hex.from(headersChain.substring(i, i + 160))))
  }

  return result
}

/**
 * Utility functions allowing to serialize and deserialize Bitcoin block headers.
 */
export const BitcoinHeaderSerializer = {
  serializeHeader,
  deserializeHeader,
  deserializeHeadersChain,
}

/**
 * Validates a chain of consecutive block headers by checking each header's
 * difficulty, hash, and continuity with the previous header. This function can
 * be used to validate a series of Bitcoin block headers for their validity.
 * @param headers An array of block headers that form the chain to be
 *        validated.
 * @param previousEpochDifficulty The difficulty of the previous Bitcoin epoch.
 * @param currentEpochDifficulty The difficulty of the current Bitcoin epoch.
 * @dev The block headers must come from Bitcoin epochs with difficulties marked
 *      by the previous and current difficulties. If a Bitcoin difficulty relay
 *      is used to provide these values and the relay is up-to-date, only the
 *      recent block headers will pass validation. Block headers older than the
 *      current and previous Bitcoin epochs will fail.
 * @throws {Error} If any of the block headers are invalid, or if the block
 *         header chain is not continuous.
 * @returns An empty return value.
 */
export function validateBitcoinHeadersChain(
  headers: BitcoinHeader[],
  previousEpochDifficulty: BigNumber,
  currentEpochDifficulty: BigNumber
) {
  let requireCurrentDifficulty: boolean = false
  let previousBlockHeaderHash: Hex = Hex.from("00")

  for (let index = 0; index < headers.length; index++) {
    const currentHeader = headers[index]

    // Check if the current block header stores the hash of the previously
    // processed block header. Skip the check for the first header.
    if (index !== 0) {
      if (
        !previousBlockHeaderHash.equals(currentHeader.previousBlockHeaderHash)
      ) {
        throw new Error(
          `Invalid headers chain; problem with header index: ${index}`
        )
      }
    }

    const difficultyTarget = bitsToTarget(currentHeader.bits)

    const currentBlockHeaderHash = BitcoinHashUtils.computeHash256(
      serializeHeader(currentHeader)
    )

    // Ensure the header has sufficient work.
    if (
      BitcoinHashUtils.hashLEToBigNumber(currentBlockHeaderHash).gt(
        difficultyTarget
      )
    ) {
      throw new Error("Insufficient work in the header")
    }

    // Save the current block header hash to compare it with the next block
    // header's previous block header hash.
    previousBlockHeaderHash = currentBlockHeaderHash

    // Check if the stored block difficulty is equal to previous or current
    // difficulties.
    const difficulty = targetToDifficulty(difficultyTarget)

    if (previousEpochDifficulty.eq(1) && currentEpochDifficulty.eq(1)) {
      // Special case for Bitcoin Testnet. Do not check block's difficulty
      // due to required difficulty falling to `1` for Testnet.
      continue
    }

    if (
      !difficulty.eq(previousEpochDifficulty) &&
      !difficulty.eq(currentEpochDifficulty)
    ) {
      throw new Error(
        "Header difficulty not at current or previous Bitcoin difficulty"
      )
    }

    // Additionally, require the header to be at current difficulty if some
    // headers at current difficulty have already been seen. This ensures
    // there is at most one switch from previous to current difficulties.
    if (requireCurrentDifficulty && !difficulty.eq(currentEpochDifficulty)) {
      throw new Error("Header must be at current Bitcoin difficulty")
    }

    // If the header is at current difficulty, require the subsequent headers to
    // be at current difficulty as well.
    requireCurrentDifficulty = difficulty.eq(currentEpochDifficulty)
  }
}

/**
 * Converts a block header's bits into target.
 * @param bits - bits from block header.
 * @returns Target as a BigNumber.
 */
function bitsToTarget(bits: number): BigNumber {
  // A serialized 80-byte block header stores the `bits` value as a 4-byte
  // little-endian hexadecimal value in a slot including bytes 73, 74, 75, and
  // 76. This function's input argument is expected to be a numerical
  // representation of that 4-byte value reverted to the big-endian order.
  // For example, if the `bits` little-endian value in the header is
  // `0xcb04041b`, it must be reverted to the big-endian form `0x1b0404cb` and
  // turned to a decimal number `453248203` in order to be used as this
  // function's input.
  //
  // The `bits` 4-byte big-endian representation is a compact value that works
  // like a base-256 version of scientific notation. It encodes the target
  // exponent in the first byte and the target mantissa in the last three bytes.
  // Referring to the previous example, if `bits = 453248203`, the hexadecimal
  // representation is `0x1b0404cb` so the exponent is `0x1b` while the mantissa
  // is `0x0404cb`.
  //
  // To extract the exponent, we need to shift right by 3 bytes (24 bits),
  // extract the last byte of the result, and subtract 3 (because of the
  // mantissa length):
  // - 0x1b0404cb >>> 24 = 0x0000001b
  // - 0x0000001b & 0xff = 0x1b
  // - 0x1b - 3 = 24 (decimal)
  //
  // To extract the mantissa, we just need to take the last three bytes:
  // - 0x1b0404cb & 0xffffff = 0x0404cb = 263371 (decimal)
  //
  // The final difficulty can be computed as mantissa * 256^exponent:
  // - 263371 * 256^24 =
  // 1653206561150525499452195696179626311675293455763937233695932416 (decimal)
  //
  // Sources:
  // - https://developer.bitcoin.org/reference/block_chain.html#target-nbits
  // - https://wiki.bitcoinsv.io/index.php/Target

  const exponent = ((bits >>> 24) & 0xff) - 3
  const mantissa = bits & 0xffffff

  const target = BigNumber.from(mantissa).mul(BigNumber.from(256).pow(exponent))
  return target
}

/**
 * Converts difficulty target to difficulty.
 * @param target - difficulty target.
 * @returns Difficulty as a BigNumber.
 */
function targetToDifficulty(target: BigNumber): BigNumber {
  const DIFF1_TARGET = BigNumber.from(
    "0xffff0000000000000000000000000000000000000000000000000000"
  )
  return DIFF1_TARGET.div(target)
}

/**
 * Utility functions allowing to perform Bitcoin target conversions.
 */
export const BitcoinTargetConverter = {
  bitsToTarget,
  targetToDifficulty,
}
