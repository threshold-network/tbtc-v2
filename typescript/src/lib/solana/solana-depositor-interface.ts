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

    const response = await axios.post(
      "https://relayer.tbtcscan.com/api/reveal",
      {
        fundingTx,
        reveal,
        l2DepositOwner: formattedOwner,
        l2Sender: formattedSender,
      },
      { timeout: 90000 }
    )

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
