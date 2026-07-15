import { BigNumber } from "ethers"
import { Transaction } from "bitcoinjs-lib"
import { BitcoinRawTx, BitcoinUtxo } from "../../lib/bitcoin"

export type ResolvedBitcoinUtxo = {
  transaction: Transaction
  output: Transaction["outs"][number]
  value: BigNumber
}

/**
 * Resolves a UTXO against its raw transaction and rejects inconsistent
 * provider metadata before the output is used for signing or accounting.
 * @param utxo UTXO metadata paired with its raw transaction.
 * @returns The authenticated transaction output and its authoritative value.
 */
export function resolveBitcoinUtxo(
  utxo: BitcoinUtxo & BitcoinRawTx
): ResolvedBitcoinUtxo {
  const transaction = Transaction.fromHex(utxo.transactionHex)

  if (transaction.getId() !== utxo.transactionHash.toString()) {
    throw new Error("Raw transaction does not match UTXO transaction hash")
  }

  if (
    !Number.isInteger(utxo.outputIndex) ||
    utxo.outputIndex < 0 ||
    utxo.outputIndex >= transaction.outs.length
  ) {
    throw new Error("UTXO output index is out of range")
  }

  const output = transaction.outs[utxo.outputIndex]
  const value = BigNumber.from(output.value)

  if (!value.eq(utxo.value)) {
    throw new Error("UTXO value does not match raw previous transaction")
  }

  return { transaction, output, value }
}

/**
 * Ensures the final transaction pays exactly the fee requested by the caller.
 * @param transaction Final transaction to validate.
 * @param totalInputValue Sum of its authenticated input values.
 * @param requestedFee Absolute fee requested by the caller.
 * @returns Void if the transaction pays the requested fee.
 */
export function validateTransactionFee(
  transaction: Transaction,
  totalInputValue: BigNumber,
  requestedFee: BigNumber
): void {
  const totalOutputValue = transaction.outs.reduce(
    (sum, output) => sum.add(output.value),
    BigNumber.from(0)
  )
  const actualFee = totalInputValue.sub(totalOutputValue)

  if (!actualFee.eq(requestedFee)) {
    throw new Error("Transaction fee does not match the requested fee")
  }
}
