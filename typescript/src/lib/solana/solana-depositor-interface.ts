import axios from "axios"
import {
  ChainIdentifier,
  ChainTransactionReceipt,
  BitcoinDepositor,
  DepositReceipt,
} from "../contracts"
import { packRevealDepositParameters } from "../ethereum"
import { BitcoinRawTxVectors } from "../bitcoin"

import { SolanaExtraDataEncoder } from "./extra-data-encoder"

/**
 * Thrown when the relayer request times out (e.g. ECONNABORTED, ETIMEDOUT, or request timeout).
 * Because the relayer may still submit the reveal transaction on L1 after the timeout,
 * the outcome is ambiguous and callers can special-case this error rather than
 * treating it as a definitive failure.
 */
export class SolanaRelayerTimeoutError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = "SolanaRelayerTimeoutError"
  }
}

/**
 * Thrown when the relayer reports that a deposit reveal already exists (HTTP 409 Conflict).
 * Callers can special-case this error to handle already-submitted deposits.
 */
export class SolanaRelayerDepositConflictError extends Error {
  constructor(
    message: string,
    public readonly responseData?: unknown,
    public readonly cause?: unknown
  ) {
    super(message)
    this.name = "SolanaRelayerDepositConflictError"
  }
}

/**
 * Implementation of the Solana Depositor Interface handle.
 */
export class SolanaDepositorInterface implements BitcoinDepositor {
  readonly #extraDataEncoder: SolanaExtraDataEncoder
  #depositOwner: ChainIdentifier | undefined

  constructor() {
    this.#extraDataEncoder = new SolanaExtraDataEncoder()
  }

  getDepositOwner(): ChainIdentifier | undefined {
    return this.#depositOwner
  }

  setDepositOwner(depositOwner: ChainIdentifier | undefined): void {
    this.#depositOwner = depositOwner
  }

  extraDataEncoder(): SolanaExtraDataEncoder {
    return this.#extraDataEncoder
  }

  /**
   * Initializes a deposit by calling the external relayer service at
   * `https://relayer.tbtcscan.com/api/reveal` to trigger the deposit transaction
   * via an off-chain relayer process.
   *
   * @param depositTx - The Bitcoin raw transaction vectors.
   * @param depositOutputIndex - The output index of the deposit in the funding transaction.
   * @param deposit - The deposit receipt.
   * @param vault - Optional vault identifier.
   * @returns The resulting transaction receipt containing the transaction hash.
   */
  async initializeDeposit(
    depositTx: BitcoinRawTxVectors,
    depositOutputIndex: number,
    deposit: DepositReceipt,
    vault?: ChainIdentifier
  ): Promise<ChainTransactionReceipt> {
    const { fundingTx, reveal, extraData } = packRevealDepositParameters(
      depositTx,
      depositOutputIndex,
      deposit,
      vault
    )

    if (!extraData) {
      throw new Error("Extra data is required.")
    }

    const depositOwner = deposit.extraData
      ? this.#extraDataEncoder.decodeDepositOwner(deposit.extraData)
      : this.#depositOwner

    if (!depositOwner) {
      throw new Error("Deposit owner is required.")
    }

    const sender = this.#depositOwner ?? depositOwner
    const formattedOwner = `0x${depositOwner.identifierHex}`
    const formattedSender = `0x${sender.identifierHex}`

    let response
    try {
      response = await axios.post(
        "https://relayer.tbtcscan.com/api/reveal",
        {
          fundingTx,
          reveal,
          l2DepositOwner: formattedOwner,
          l2Sender: formattedSender,
        },
        { timeout: 90000 }
      )
    } catch (error: unknown) {
      if (axios.isAxiosError(error)) {
        if (
          error.code === "ECONNABORTED" ||
          error.code === "ETIMEDOUT" ||
          error.message?.toLowerCase().includes("timeout")
        ) {
          throw new SolanaRelayerTimeoutError(
            "RELAYER_TIMEOUT_AMBIGUOUS: Relayer request timed out after 90s. The reveal may still be processed by the relayer.",
            error
          )
        }

        if (error.response?.status === 409) {
          throw new SolanaRelayerDepositConflictError(
            "RELAYER_CONFLICT_AMBIGUOUS: Deposit reveal already submitted or in conflict (HTTP 409).",
            error.response?.data,
            error
          )
        }
      }

      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT")
      ) {
        throw new SolanaRelayerTimeoutError(
          "RELAYER_TIMEOUT_AMBIGUOUS: Relayer request timed out after 90s. The reveal may still be processed by the relayer.",
          error
        )
      }

      throw error
    }

    const { data } = response
    if (!isTransactionReceipt(data.receipt)) {
      throw new Error(
        `Unexpected response from /api/reveal: ${JSON.stringify(data)}`
      )
    }

    return data.receipt
  }
}

function isTransactionReceipt(
  receipt: unknown
): receipt is ChainTransactionReceipt {
  return (
    typeof receipt === "object" &&
    receipt !== null &&
    typeof (receipt as ChainTransactionReceipt).transactionHash === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(
      (receipt as ChainTransactionReceipt).transactionHash
    )
  )
}
