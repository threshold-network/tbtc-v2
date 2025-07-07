import {
  ChainIdentifier,
  CrossChainInterfaces,
  ExtraDataEncoder,
  DepositorProxy,
  DepositReceipt,
} from "../../lib/contracts"
import { BitcoinRawTxVectors } from "../../lib/bitcoin"
import { Hex } from "../../lib/utils"
import { TransactionReceipt } from "@ethersproject/providers"
import { SuiTransactionBlockResponse } from "@mysten/sui/client"

/**
 * Mode of operation for the cross-chain depositor proxy:
 * - [L2Transaction]: The proxy will reveal the deposit using a transaction on
 *   the L2 chain. The tBTC system is responsible for relaying the deposit to
 *   the tBTC L1 chain.
 * - [L1Transaction]: The proxy will directly reveal the deposit using a
 *   transaction on the tBTC L1 chain.
 */
export type CrossChainDepositorMode = "L2Transaction" | "L1Transaction"

/**
 * Implementation of the cross chain depositor proxy. This component is used to
 * reveal cross-chain deposits whose target chain is not the same as the L1
 * chain the tBTC system is deployed on.
 * @see {DepositorProxy} for reference.
 */
export class CrossChainDepositor implements DepositorProxy {
  readonly #crossChainContracts: CrossChainInterfaces
  readonly #revealMode: CrossChainDepositorMode

  constructor(
    crossChainContracts: CrossChainInterfaces,
    revealMode: CrossChainDepositorMode = "L2Transaction"
  ) {
    this.#crossChainContracts = crossChainContracts
    this.#revealMode = revealMode
  }

  /**
   * @returns The chain-specific identifier of the contract that will be
   *          used as the actual L1 depositor embedded in the deposit script.
   *          In this case, the depositor must be the L1BitcoinDepositor contract
   *          corresponding to the given L2 chain the deposit is targeting.
   *          This is because the L1BitcoinDepositor contract reveals the deposit to
   *          the Bridge contract (on L1) and transfers minted TBTC token to the
   *          target L2 chain once the deposit is processed.
   * @see {DepositorProxy#getChainIdentifier}
   */
  getChainIdentifier(): ChainIdentifier {
    return this.#crossChainContracts.l1BitcoinDepositor.getChainIdentifier()
  }

  /**
   * @returns Extra data for the cross-chain deposit script. Actually, this is
   *          the destination chain deposit owner identifier took from the BitcoinDepositor
   *          contract.
   * @throws Throws if the destination chain deposit owner cannot be resolved. This
   *         typically happens if the BitcoinDepositor operates with
   *         a read-only signer whose address cannot be resolved.
   */
  extraData(): Hex {
    const depositOwner =
      this.#crossChainContracts.destinationChainBitcoinDepositor.getDepositOwner()

    if (!depositOwner) {
      throw new Error("Cannot resolve destination chain deposit owner")
    }

    return this.#extraDataEncoder().encodeDepositOwner(depositOwner)
  }

  #extraDataEncoder(): ExtraDataEncoder {
    switch (this.#revealMode) {
      case "L2Transaction":
        return this.#crossChainContracts.destinationChainBitcoinDepositor.extraDataEncoder()
      case "L1Transaction":
        return this.#crossChainContracts.l1BitcoinDepositor.extraDataEncoder()
    }
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * Reveals the given deposit depending on the reveal mode.
   * @see {CrossChainDepositorMode} for reveal modes description.
   * @see {DepositorProxy#revealDeposit}
   */
  async revealDeposit(
    depositTx: BitcoinRawTxVectors,
    depositOutputIndex: number,
    deposit: DepositReceipt,
    vault?: ChainIdentifier
  ): Promise<Hex> {
    let result: Hex | TransactionReceipt | SuiTransactionBlockResponse

    switch (this.#revealMode) {
      case "L2Transaction":
        result =
          await this.#crossChainContracts.destinationChainBitcoinDepositor.initializeDeposit(
            depositTx,
            depositOutputIndex,
            deposit,
            vault
          )
        break
      case "L1Transaction":
        result =
          await this.#crossChainContracts.l1BitcoinDepositor.initializeDeposit(
            depositTx,
            depositOutputIndex,
            deposit,
            vault
          )
        break
    }

    // If result is a TransactionReceipt, extract the transaction hash
    if (result instanceof Hex) {
      console.log("Hex: ", result)
      return result
    } else if ((result as SuiTransactionBlockResponse).digest) {
      const digestBuffer = Buffer.from(
        (result as SuiTransactionBlockResponse).digest,
        "utf8"
      )
      return Hex.from(digestBuffer)
    } else {
      return Hex.from((result as TransactionReceipt).transactionHash)
    }
  }
}
