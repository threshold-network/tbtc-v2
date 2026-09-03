import axios from "axios"
import { ChainIdentifier, BitcoinDepositor, DepositReceipt } from "../contracts"
import { packRevealDepositParameters } from "../ethereum"
import { BitcoinRawTxVectors } from "../bitcoin"
import { TransactionReceipt } from "@ethersproject/abstract-provider"
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
 * @see {BitcoinDepositor} for reference.
 */
export class SolanaDepositorInterface implements BitcoinDepositor {
  readonly #extraDataEncoder: SolanaExtraDataEncoder
  #depositOwner: ChainIdentifier | undefined

  constructor() {
    this.#extraDataEncoder = new SolanaExtraDataEncoder()
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinDepositor#getDepositOwner}
   */
  getDepositOwner(): ChainIdentifier | undefined {
    return this.#depositOwner
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinDepositor#setDepositOwner}
   */
  setDepositOwner(depositOwner: ChainIdentifier | undefined): void {
    this.#depositOwner = depositOwner
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinDepositor#extraDataEncoder}
   */
  extraDataEncoder(): SolanaExtraDataEncoder {
    return this.#extraDataEncoder
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinDepositor#initializeDeposit}
   *
   * This method calls the external service at `https://relayer.tbtcscan.com/api/reveal`
   * to trigger the deposit transaction via a relayer off-chain process.
   * It returns the resulting transaction hash as a Hex.
   */
  async initializeDeposit(
    depositTx: BitcoinRawTxVectors,
    depositOutputIndex: number,
    deposit: DepositReceipt,
    vault?: ChainIdentifier
  ): Promise<TransactionReceipt> {
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

function isTransactionReceipt(receipt: unknown): receipt is TransactionReceipt {
  return (
    typeof receipt === "object" &&
    receipt !== null &&
    typeof (receipt as TransactionReceipt).transactionHash === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test((receipt as TransactionReceipt).transactionHash)
  )
}
