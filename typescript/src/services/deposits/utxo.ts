import { BigNumber } from "ethers"
import { Transaction } from "bitcoinjs-lib"
import { BitcoinRawTx, BitcoinTxOutpoint, BitcoinUtxo } from "../../lib/bitcoin"

export type ResolvedBitcoinTxOutpoint = {
  transaction: Transaction
  output: Transaction["outs"][number]
}

export type ResolvedBitcoinUtxo = {
  transaction: ResolvedBitcoinTxOutpoint["transaction"]
  output: ResolvedBitcoinTxOutpoint["output"]
  value: BigNumber
}

/**
 * Resolves an outpoint against provider-returned raw transaction bytes and
 * rejects identity or index mismatches before the transaction is used.
 * @param outpoint Expected transaction hash and output index.
 * @param rawTransaction Raw transaction returned for the expected hash.
 * @param errorContext Selects user-facing errors for funding or signing flows.
 * @returns The authenticated transaction and selected output.
 */
export function resolveBitcoinTxOutpoint(
  outpoint: BitcoinTxOutpoint,
  rawTransaction: BitcoinRawTx,
  errorContext: "funding" | "utxo" = "funding"
): ResolvedBitcoinTxOutpoint {
  const transaction = Transaction.fromHex(rawTransaction.transactionHex)

  if (transaction.getId() !== outpoint.transactionHash.toString()) {
    throw new Error(
      errorContext === "utxo"
        ? "Raw transaction does not match UTXO transaction hash"
        : "Funding transaction bytes do not match requested transaction hash"
    )
  }

  if (
    !Number.isInteger(outpoint.outputIndex) ||
    outpoint.outputIndex < 0 ||
    outpoint.outputIndex >= transaction.outs.length
  ) {
    throw new Error(
      errorContext === "utxo"
        ? "UTXO output index is out of range"
        : "Funding output index is out of range"
    )
  }

  return { transaction, output: transaction.outs[outpoint.outputIndex] }
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
  const { transaction, output } = resolveBitcoinTxOutpoint(utxo, utxo, "utxo")
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
