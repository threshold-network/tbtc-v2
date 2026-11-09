import { Transaction as Tx } from "bitcoinjs-lib"
import bufio from "bufio"
import { BigNumber } from "@ethersproject/bignumber"
import { Hex } from "../utils"

/**
 * Represents a Bitcoin transaction hash (or transaction ID) as an un-prefixed hex
 * string. This hash is supposed to have the same byte order as used by the
 * Bitcoin block explorers which is the opposite of the byte order used
 * by the Bitcoin protocol internally. That means the hash must be reversed in
 * the use cases that expect the Bitcoin internal byte order.
 */
export class BitcoinTxHash extends Hex {}

/**
 * Represents a raw Bitcoin transaction.
 */
export interface BitcoinRawTx {
  /**
   * The full transaction payload as an un-prefixed hex string.
   */
  transactionHex: string
}

/**
 * Data about a Bitcoin transaction.
 */
export interface BitcoinTx {
  /**
   * The transaction hash (or transaction ID) as an un-prefixed hex string.
   */
  transactionHash: BitcoinTxHash

  /**
   * The vector of transaction inputs.
   */
  inputs: BitcoinTxInput[]

  /**
   * The vector of transaction outputs.
   */
  outputs: BitcoinTxOutput[]
}

/**
 * Data about a Bitcoin transaction outpoint.
 */
export interface BitcoinTxOutpoint {
  /**
   * The hash of the transaction the outpoint belongs to.
   */
  transactionHash: BitcoinTxHash

  /**
   * The zero-based index of the output from the specified transaction.
   */
  outputIndex: number
}

/**
 * Data about a Bitcoin transaction input.
 */
export type BitcoinTxInput = BitcoinTxOutpoint & {
  /**
   * The scriptSig that unlocks the specified outpoint for spending.
   */
  scriptSig: Hex
}

/**
 * Data about a Bitcoin transaction output.
 */
export interface BitcoinTxOutput {
  /**
   * The 0-based index of the output.
   */
  outputIndex: number

  /**
   * The value of the output in satoshis.
   */
  value: BigNumber

  /**
   * The receiving scriptPubKey.
   */
  scriptPubKey: Hex
}

/**
 * Data about a Bitcoin unspent transaction output.
 */
export type BitcoinUtxo = BitcoinTxOutpoint & {
  /**
   * The unspent value in satoshis.
   */
  value: BigNumber
}

/**
 * Represents a raw Bitcoin transaction decomposed into specific vectors.
 */
export interface BitcoinRawTxVectors {
  /**
   * Transaction version as a hex string.
   */
  version: Hex

  /**
   * All transaction's inputs prepended by the number of transaction inputs,
   * as a hex string.
   */
  inputs: Hex

  /**
   * All transaction's outputs prepended by the number of transaction outputs,
   * as a hex string.
   */
  outputs: Hex

  /**
   * Transaction locktime as a hex string.
   */
  locktime: Hex
}

/**
 * Decomposes a transaction in the raw representation into version, vector of
 * inputs, vector of outputs and locktime.
 * @param rawTransaction - Transaction in the raw format.
 * @returns Transaction data with fields represented as un-prefixed hex strings.
 */
export function extractBitcoinRawTxVectors(
  rawTransaction: BitcoinRawTx
): BitcoinRawTxVectors {
  const toHex = (bufferWriter: any): Hex => {
    return Hex.from(bufferWriter.render())
  }

  const getTxInputVector = (tx: Tx): Hex => {
    const buffer = bufio.write()
    buffer.writeVarint(tx.ins.length)
    tx.ins.forEach((input) => {
      buffer.writeHash(input.hash)
      buffer.writeU32(input.index)
      buffer.writeVarBytes(input.script)
      buffer.writeU32(input.sequence)
    })
    return toHex(buffer)
  }

  const getTxOutputVector = (tx: Tx): Hex => {
    const buffer = bufio.write()
    buffer.writeVarint(tx.outs.length)
    tx.outs.forEach((output) => {
      buffer.writeI64(output.value)
      buffer.writeVarBytes(output.script)
    })
    return toHex(buffer)
  }

  const getTxVersion = (tx: Tx): Hex => {
    const buffer = bufio.write()
    buffer.writeU32(tx.version)
    return toHex(buffer)
  }

  const getTxLocktime = (tx: Tx): Hex => {
    const buffer = bufio.write()
    buffer.writeU32(tx.locktime)
    return toHex(buffer)
  }

  const transaction = Tx.fromBuffer(
    Buffer.from(rawTransaction.transactionHex, "hex")
  )

  return {
    version: getTxVersion(transaction),
    inputs: getTxInputVector(transaction),
    outputs: getTxOutputVector(transaction),
    locktime: getTxLocktime(transaction),
  }
}

/**
 * Converts Bitcoin specific locktime value to a number. The number represents
 * either a block height or a Unix timestamp, depending on the value.
 *
 * If the number is less than 500 000 000 it is a block height.
 * If the number is greater or equal 500 000 000 it is a Unix timestamp.
 *
 * @see {@link https://developer.bitcoin.org/devguide/transactions.html#locktime-and-sequence-number Documentation}
 *
 * @param locktimeLE A 4-byte little-endian locktime as an un-prefixed
 *                   hex string {@link: Deposit#refundLocktime}.
 * @returns UNIX timestamp in seconds.
 */
function locktimeToNumber(locktimeLE: Buffer | string): number {
  const locktimeBE: Buffer = Hex.from(locktimeLE).reverse().toBuffer()
  return BigNumber.from(locktimeBE).toNumber()
}

/**
 * Calculates locktime parameter for the given locktime start timestamp.
 * Throws if the resulting locktime is not a 4-byte number.
 * @param locktimeStartedAt - Unix timestamp in seconds determining the moment
 *        of the locktime start.
 * @param locktimeDuration Locktime duration in seconds.
 * @returns A 4-byte little-endian locktime.
 */
function calculateLocktime(
  locktimeStartedAt: number,
  locktimeDuration: number
): Hex {
  // Locktime is a Unix timestamp in seconds, computed as locktime start
  // timestamp plus locktime duration.
  const locktime = BigNumber.from(locktimeStartedAt + locktimeDuration)

  const locktimeHex: Hex = Hex.from(locktime.toHexString())

  if (locktimeHex.toString().length != 8) {
    throw new Error("Locktime must be a 4 bytes number")
  }

  // Bitcoin locktime is interpreted as little-endian integer, so we must
  // adhere to that convention by converting the locktime accordingly.
  return locktimeHex.reverse()
}

/**
 * Utility functions allowing to deal with Bitcoin locktime.
 */
export const BitcoinLocktimeUtils = {
  locktimeToNumber,
  calculateLocktime,
}
