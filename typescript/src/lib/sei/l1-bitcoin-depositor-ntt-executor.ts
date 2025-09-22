import {
  EthersContractConfig,
  EthersContractDeployment,
  EthersContractHandle,
} from "../ethereum/adapter"
// TODO: Uncomment when L1BTCDepositorNttWithExecutor typechain is available
// import { L1BTCDepositorNttWithExecutor as L1BTCDepositorNttWithExecutorTypechain } from "../../../typechain/L1BTCDepositorNttWithExecutor"
import { Contract } from "ethers"
import {
  ChainIdentifier,
  Chains,
  ExtraDataEncoder,
  DepositReceipt,
  BitcoinDepositor,
} from "../contracts"
import {
  EthereumAddress,
  EthereumCrossChainExtraDataEncoder,
  packRevealDepositParameters,
} from "../ethereum"
import { Hex } from "../utils"
import { BitcoinRawTxVectors } from "../bitcoin"
import { TransactionReceipt } from "@ethersproject/providers"
import { BigNumber } from "ethers"

// TODO: Add actual L1 deployment artifacts when contracts are deployed
const MainnetL1BTCDepositorNttWithExecutorDeployment = {
  address: "0x0000000000000000000000000000000000000000", // TODO: Update with actual mainnet deployment
  abi: [], // TODO: Update with actual ABI
  receipt: {
    blockHash:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    blockNumber: 0,
    transactionHash:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
  },
}

const SepoliaL1BTCDepositorNttWithExecutorDeployment = {
  address: "0x0000000000000000000000000000000000000000", // TODO: Update with actual Sepolia deployment
  abi: [], // TODO: Update with actual ABI
  receipt: {
    blockHash:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    blockNumber: 0,
    transactionHash:
      "0x0000000000000000000000000000000000000000000000000000000000000000",
  },
}

/**
 * Executor arguments for NTT Manager With Executor transfers
 */
export interface ExecutorArgs {
  // / Value in wei to pay for executor service
  value: BigNumber
  // / Address to receive refunds for unused gas
  refundAddress: string
  // / Signed quote from the Wormhole Executor API
  signedQuote: string
  // / Relay instructions for gas configuration on destination chain
  instructions: string
}

/**
 * Fee arguments for NTT Manager With Executor transfers
 */
export interface FeeArgs {
  // / Fee in basis points (e.g., 100 = 1%)
  dbps: number
  // / Address to receive the fee payment
  payee: string
}

/**
 * Configuration for Sei-specific bridging parameters
 */
export interface SeiNttConfig {
  // / Wormhole chain ID for Sei (32)
  seiChainId: number
  // / Default gas limit for destination execution
  destinationGasLimit?: number
  // / Default executor fee in basis points
  executorFeeBps?: number
  // / Default executor fee recipient
  executorFeeRecipient?: string
}

/**
 * Implementation of the Sei L1 Bitcoin Depositor with NTT Executor support.
 *
 * This contract is deployed on Ethereum mainnet/testnet and handles the L1 side
 * of the Sei bridging mechanism. It uses Wormhole NTT with Executor support
 * to automatically execute transactions on the Sei destination chain.
 *
 * Key features:
 * - Automatic destination chain execution via Wormhole Executor
 * - Support for executor quotes and fee configuration
 * - Multi-chain support (primarily Sei, but extensible)
 * - Gas optimization and refund mechanisms
 *
 * @see {BitcoinDepositor} for reference.
 */
export class SeiL1BTCDepositorNttWithExecutor
  extends EthersContractHandle<Contract>
  implements BitcoinDepositor
{
  readonly #extraDataEncoder: ExtraDataEncoder
  readonly #seiConfig: SeiNttConfig
  #depositOwner: ChainIdentifier | undefined

  constructor(
    config: EthersContractConfig,
    chainId: Chains.Ethereum,
    seiConfig?: Partial<SeiNttConfig>
  ) {
    let deployment: EthersContractDeployment

    switch (chainId) {
      case Chains.Ethereum.Sepolia:
        deployment = SepoliaL1BTCDepositorNttWithExecutorDeployment
        break
      case Chains.Ethereum.Mainnet:
        deployment = MainnetL1BTCDepositorNttWithExecutorDeployment
        break
      default:
        throw new Error(
          "Unsupported Ethereum deployment type for Sei L1 depositor"
        )
    }

    super(config, deployment)

    this.#extraDataEncoder = new EthereumCrossChainExtraDataEncoder()
    this.#seiConfig = {
      seiChainId: 32, // Wormhole chain ID for Sei
      destinationGasLimit: 500000,
      executorFeeBps: 0,
      executorFeeRecipient: "0x0000000000000000000000000000000000000000",
      ...seiConfig,
    }
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {BitcoinDepositor#getChainIdentifier}
   */
  getChainIdentifier(): ChainIdentifier {
    return EthereumAddress.from(this._instance.address)
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
  setDepositOwner(depositOwner: ChainIdentifier | undefined) {
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
    vault?: ChainIdentifier
  ): Promise<Hex | TransactionReceipt> {
    const { fundingTx, reveal } = packRevealDepositParameters(
      depositTx,
      depositOutputIndex,
      deposit,
      vault
    )

    if (!deposit.extraData) {
      throw new Error("Extra data is required")
    }

    const l2DepositOwner = this.extraDataEncoder().decodeDepositOwner(
      deposit.extraData
    )

    const tx = await this._instance.initializeDeposit(
      fundingTx,
      reveal,
      `0x${l2DepositOwner.identifierHex}`
    )

    return Hex.from(tx.hash)
  }

  /**
   * Sets executor parameters for the next finalizeDeposit call
   * @param executorArgs Executor arguments with signed quote from Wormhole Executor API
   * @param feeArgs Fee arguments for the executor service
   * @returns Transaction hash
   */
  async setExecutorParameters(
    executorArgs: ExecutorArgs,
    feeArgs: FeeArgs
  ): Promise<string> {
    const tx = await this._instance.setExecutorParameters(
      {
        value: executorArgs.value,
        refundAddress: executorArgs.refundAddress,
        signedQuote: executorArgs.signedQuote,
        instructions: executorArgs.instructions,
      },
      {
        dbps: feeArgs.dbps,
        payee: feeArgs.payee,
      }
    )
    return tx.hash
  }

  /**
   * Clears stored executor parameters
   * @returns Transaction hash
   */
  async clearExecutorParameters(): Promise<string> {
    const tx = await this._instance.clearExecutorParameters()
    return tx.hash
  }

  /**
   * Checks if executor parameters have been set
   * @returns True if executor parameters are set and ready for finalizeDeposit
   */
  async areExecutorParametersSet(): Promise<boolean> {
    return this._instance.areExecutorParametersSet()
  }

  /**
   * Gets the stored executor value (for informational purposes)
   * @returns The executor value in wei, or 0 if not set
   */
  async getStoredExecutorValue(): Promise<BigNumber> {
    return this._instance.getStoredExecutorValue()
  }

  /**
   * Quotes the cost using stored executor parameters
   * @returns Total cost for the transfer using stored parameters
   */
  async quoteFinalizeDeposit(): Promise<BigNumber> {
    return this._instance.quoteFinalizeDeposit()
  }

  /**
   * Quotes the cost for a specific destination chain using stored executor parameters
   * @param destinationChain Wormhole chain ID of the destination
   * @returns Total cost for the transfer to the specified chain
   */
  async quoteFinalizeDepositForChain(
    destinationChain: number
  ): Promise<BigNumber> {
    return this._instance["quoteFinalizeDeposit(uint16)"](destinationChain)
  }

  /**
   * Encodes destination receiver data for cross-chain transfer
   * @param chainId Wormhole chain ID of the destination
   * @param recipient Recipient address on the destination chain
   * @returns Encoded receiver data
   */
  async encodeDestinationReceiver(
    chainId: number,
    recipient: string
  ): Promise<string> {
    return this._instance.encodeDestinationReceiver(chainId, recipient)
  }

  /**
   * Decodes destination receiver data
   * @param encodedReceiver The encoded receiver data
   * @returns Tuple of [chainId, recipient address]
   */
  async decodeDestinationReceiver(
    encodedReceiver: string
  ): Promise<[number, string]> {
    return this._instance.decodeDestinationReceiver(encodedReceiver)
  }

  /**
   * Gets the Sei configuration for this depositor
   * @returns The Sei NTT configuration
   */
  getSeiConfig(): SeiNttConfig {
    return { ...this.#seiConfig }
  }

  /**
   * Creates default executor arguments for Sei bridging
   * @param refundAddress Address to receive refunds for unused gas
   * @param signedQuote Signed quote from Wormhole Executor API
   * @param executorValue Value in wei to pay for executor service
   * @returns Default executor arguments
   */
  createDefaultExecutorArgs(
    refundAddress: string,
    signedQuote: string,
    executorValue: BigNumber = BigNumber.from(0)
  ): ExecutorArgs {
    return {
      value: executorValue,
      refundAddress,
      signedQuote,
      instructions: "0x", // Empty instructions for basic transfer
    }
  }

  /**
   * Creates default fee arguments for Sei bridging
   * @param feeRecipient Address to receive executor fees (optional)
   * @param feeBps Fee in basis points (optional, defaults to config)
   * @returns Default fee arguments
   */
  createDefaultFeeArgs(feeRecipient?: string, feeBps?: number): FeeArgs {
    return {
      dbps: feeBps ?? this.#seiConfig.executorFeeBps ?? 0,
      payee:
        feeRecipient ??
        this.#seiConfig.executorFeeRecipient ??
        "0x0000000000000000000000000000000000000000",
    }
  }

  /**
   * Helper method to prepare executor parameters for Sei bridging
   * @param refundAddress Address to receive refunds
   * @param signedQuote Signed quote from Wormhole Executor API
   * @param executorValue Value for executor service
   * @param feeRecipient Optional fee recipient
   * @param feeBps Optional fee in basis points
   * @returns Prepared executor and fee arguments
   */
  prepareSeiExecutorParams(
    refundAddress: string,
    signedQuote: string,
    executorValue: BigNumber = BigNumber.from(0),
    feeRecipient?: string,
    feeBps?: number
  ): { executorArgs: ExecutorArgs; feeArgs: FeeArgs } {
    const executorArgs = this.createDefaultExecutorArgs(
      refundAddress,
      signedQuote,
      executorValue
    )
    const feeArgs = this.createDefaultFeeArgs(feeRecipient, feeBps)

    return { executorArgs, feeArgs }
  }

  /**
   * Convenience method to set executor parameters specifically for Sei
   * @param refundAddress Address to receive refunds
   * @param signedQuote Signed quote from Wormhole Executor API
   * @param executorValue Value for executor service
   * @param feeRecipient Optional fee recipient
   * @param feeBps Optional fee in basis points
   * @returns Transaction hash
   */
  async setSeiExecutorParameters(
    refundAddress: string,
    signedQuote: string,
    executorValue: BigNumber = BigNumber.from(0),
    feeRecipient?: string,
    feeBps?: number
  ): Promise<string> {
    const { executorArgs, feeArgs } = this.prepareSeiExecutorParams(
      refundAddress,
      signedQuote,
      executorValue,
      feeRecipient,
      feeBps
    )

    return this.setExecutorParameters(executorArgs, feeArgs)
  }
}
