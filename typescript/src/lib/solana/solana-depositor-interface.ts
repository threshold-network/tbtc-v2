import axios from "axios"
import { ChainIdentifier, BitcoinDepositor, DepositReceipt } from "../contracts"
import { packRevealDepositParameters } from "../ethereum"
import { BitcoinRawTxVectors } from "../bitcoin"
import { TransactionReceipt } from "@ethersproject/providers"
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
   * This method calls the external service at `https://api.tbtcscan.org/reveal`
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

    try {
      const response = await axios.post(
        "http://relayer.tbtcscan.com/api/reveal",
        {
          fundingTx,
          reveal,
          l2DepositOwner: extraData,
          l2Sender: `0x${this.#depositOwner?.identifierHex}`,
        }
      )

      const { data } = response
      if (!data.receipt) {
        throw new Error(
          `Unexpected response from /api/reveal: ${JSON.stringify(data)}`
        )
      }

      return data.receipt
    } catch (error) {
      // You can add logging, rethrow, etc.
      console.error("Error calling /api/reveal endpoint:", error)
      throw error
    }
  }
}
