import {
  BitcoinDepositor,
  ChainIdentifier,
  Chains,
  DepositReceipt,
  ExtraDataEncoder,
} from "../contracts"
import { SuiAddress } from "./chain-identifier"
import { SuiExtraDataEncoder } from "./extra-data-encoder"
import { BitcoinRawTxVectors } from "../bitcoin"
import { Hex } from "../utils"
import { SuiClient, SuiError } from "./types"
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"

/**
 * Implementation of the SUI BitcoinDepositor handle.
 * @see {BitcoinDepositor} for reference.
 */
export class SuiBitcoinDepositor implements BitcoinDepositor {
  readonly #extraDataEncoder: ExtraDataEncoder
  readonly #packageId: string
  readonly #client: SuiClient
  readonly #signer: Ed25519Keypair | any // Support both keypair and wallet adapters
  #depositOwner: ChainIdentifier | undefined

  constructor(
    client: SuiClient,
    signer: Ed25519Keypair | any,
    packageId: string,
    chainId: Chains.Sui
  ) {
    this.#client = client
    this.#signer = signer
    this.#packageId = packageId
    this.#extraDataEncoder = new SuiExtraDataEncoder()
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinDepositor#getChainIdentifier}
   */
  getChainIdentifier(): ChainIdentifier {
    // For SUI, we use the package ID as the chain identifier
    return SuiAddress.from(this.#packageId)
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
  setDepositOwner(depositOwner: ChainIdentifier): void {
    this.#depositOwner = depositOwner
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinDepositor#extraDataEncoder}
   */
  extraDataEncoder(): ExtraDataEncoder {
    return this.#extraDataEncoder
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinDepositor#initializeDeposit}
   */
  async initializeDeposit(
    depositTx: BitcoinRawTxVectors,
    depositOutputIndex: number,
    deposit: DepositReceipt,
    vault?: ChainIdentifier // Ignored for SUI - no vault support
  ): Promise<Hex | any> {
    // This method is called by CrossChainDepositor in L2Transaction mode
    // It initiates the deposit on SUI, which triggers the relayer

    // Import SUI SDK with error handling
    let Transaction: typeof import("@mysten/sui/transactions").Transaction
    try {
      const suiModule = await import("@mysten/sui/transactions")
      Transaction = suiModule.Transaction
    } catch (error) {
      throw new SuiError(
        "Failed to load SUI SDK. Please ensure @mysten/sui is installed.",
        error
      )
    }

    const tx = new Transaction()

    // Serialize funding transaction data
    const fundingTx = this.serializeFundingTx(depositTx)

    // Serialize deposit reveal data (no vault for SUI)
    const depositReveal = this.serializeDepositReveal(
      deposit,
      depositOutputIndex
    )

    // Extract deposit owner from extra data
    const depositOwner = deposit.extraData
      ? this.#extraDataEncoder.decodeDepositOwner(deposit.extraData)
          .identifierHex
      : this.#depositOwner?.identifierHex || ""

    // Call initialize_deposit on the Move module
    tx.moveCall({
      target: `${this.#packageId}::BitcoinDepositor::initialize_deposit`,
      arguments: [
        tx.pure.vector("u8", Array.from(fundingTx)),
        tx.pure.vector("u8", Array.from(depositReveal)),
        tx.pure.vector("u8", Array.from(Buffer.from(depositOwner, "hex"))),
      ],
    })

    // Execute transaction and return result
    try {
      let result: any

      // Check if signer has signAndExecuteTransaction method (wallet adapter)
      if (
        this.#signer &&
        typeof this.#signer.signAndExecuteTransaction === "function"
      ) {
        // Use wallet adapter's signAndExecuteTransaction
        result = await this.#signer.signAndExecuteTransaction({
          transaction: tx,
          options: {
            showEffects: true,
            showEvents: true,
            showObjectChanges: true,
          },
        })
      } else {
        // Fallback to client method for keypair signers
        result = await this.#client.signAndExecuteTransaction({
          signer: this.#signer,
          transaction: tx,
          options: {
            showEffects: true,
            showEvents: true,
            showObjectChanges: true,
          },
        })
      }

      // Wait for the transaction to be indexed and get the indexed result
      const indexedTransaction = await this.#client.waitForTransaction({
        digest: result.digest,
        options: {
          showEffects: true,
          showEvents: true,
        },
      })

      // Check if transaction was successful
      // The structure is confirmed to exist based on actual response
      if (indexedTransaction.effects?.status?.status !== "success") {
        throw new SuiError(
          `Transaction failed: ${
            indexedTransaction.effects?.status?.error || "Unknown error"
          }`
        )
      }

      // Validate that DepositInitialized event was emitted
      const depositEvent = indexedTransaction.events?.find(
        (e: any) =>
          e.type === `${this.#packageId}::BitcoinDepositor::DepositInitialized`
      )

      if (!depositEvent) {
        console.warn(
          "DepositInitialized event not found in transaction. " +
            "The relayer may not process this deposit."
        )
      }

      // Return the indexed transaction result which has all the proper fields
      // The CrossChainDepositor will extract the transaction hash if needed
      return indexedTransaction
    } catch (error) {
      if (error instanceof SuiError) {
        throw error
      }
      throw new SuiError(
        "Failed to execute deposit initialization on SUI",
        error
      )
    }
  }

  /**
   * Serializes the Bitcoin funding transaction for the Move contract.
   * @param tx The Bitcoin transaction vectors.
   * @returns The serialized transaction as a Uint8Array.
   */
  private serializeFundingTx(tx: BitcoinRawTxVectors): Uint8Array {
    // The Move contract expects raw concatenated bytes of Bitcoin transaction components
    return Buffer.concat([
      Buffer.from(tx.version.toString(), "hex"), // Hex.toString() returns unprefixed hex
      Buffer.from(tx.inputs.toString(), "hex"), // Hex.toString() returns unprefixed hex
      Buffer.from(tx.outputs.toString(), "hex"), // Hex.toString() returns unprefixed hex
      Buffer.from(tx.locktime.toString(), "hex"), // Hex.toString() returns unprefixed hex
    ])
  }

  /**
   * Serializes the deposit reveal data for the Move contract.
   * @param deposit The deposit receipt.
   * @param depositOutputIndex The output index in the funding transaction.
   * @returns The serialized reveal data as a Uint8Array.
   */
  private serializeDepositReveal(
    deposit: DepositReceipt,
    depositOutputIndex: number
  ): Uint8Array {
    // The Move contract expects deposit parameters as concatenated bytes
    const outputIndexBuffer = Buffer.alloc(4)
    outputIndexBuffer.writeUInt32BE(depositOutputIndex, 0)

    const parts = [
      outputIndexBuffer, // 4 bytes
      Buffer.from(deposit.blindingFactor.toString(), "hex"), // 8 bytes
      Buffer.from(deposit.walletPublicKeyHash.toString(), "hex"), // 20 bytes
      Buffer.from(deposit.refundPublicKeyHash.toString(), "hex"), // 20 bytes
      Buffer.from(deposit.refundLocktime.toString(), "hex"), // 4 bytes
    ]

    const result = Buffer.concat(parts)
    return result
  }
}
