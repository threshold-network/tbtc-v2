import {
  EthersContractConfig,
  EthersContractDeployment,
  EthersContractHandle,
} from "./adapter"
import { L1BitcoinDepositor as L1BitcoinDepositorTypechain } from "../../../typechain/L1BitcoinDepositor"
import {
  ChainIdentifier,
  Chains,
  ExtraDataEncoder,
  DepositReceipt,
  DepositState,
  L1BitcoinDepositor,
  DestinationChainName,
} from "../contracts"
import { EthereumAddress, packRevealDepositParameters } from "./index"
import { BitcoinRawTxVectors } from "../bitcoin"
import { Hex } from "../utils"

import MainnetBaseL1BitcoinDepositorDeployment from "./artifacts/mainnet/BaseL1BitcoinDepositor.json"
import MainnetArbitrumL1BitcoinDepositorDeployment from "./artifacts/mainnet/ArbitrumOneL1BitcoinDepositor.json"

import MainnetSolanaL1BitcoinDepositorDeployment from "./artifacts/mainnet/SolanaL1BitcoinDepositor.json"
import MainnetStarkNetL1BitcoinDepositorDeployment from "./artifacts/mainnet/StarkNetBitcoinDepositor.json"
import MainnetSuiBTCDepositorWormholeDeployment from "./artifacts/mainnet/SuiBTCDepositorWormhole.json"

import SepoliaBaseL1BitcoinDepositorDeployment from "./artifacts/sepolia/BaseL1BitcoinDepositor.json"
import SepoliaArbitrumL1BitcoinDepositorDeployment from "./artifacts/sepolia/ArbitrumL1BitcoinDepositor.json"
import SepoliaStarkNetL1BitcoinDepositorDeployment from "./artifacts/sepolia/StarkNetBitcoinDepositor.json"
import SepoliaSuiBTCDepositorWormholeDeployment from "./artifacts/sepolia/SuiBTCDepositorWormhole.json"

import SepoliaSolanaL1BitcoinDepositorDeployment from "./artifacts/sepolia/SolanaL1BitcoinDepositor.json"
import { SuiExtraDataEncoder } from "../sui"
import { StarkNetExtraDataEncoder } from "../starknet"
import { SolanaExtraDataEncoder } from "../solana"

const artifactLoader = {
  getMainnet: (destinationChainName: DestinationChainName) => {
    switch (destinationChainName) {
      case "Base":
        return MainnetBaseL1BitcoinDepositorDeployment
      case "Arbitrum":
        return MainnetArbitrumL1BitcoinDepositorDeployment
      case "Solana":
        return MainnetSolanaL1BitcoinDepositorDeployment
      case "StarkNet":
        return MainnetStarkNetL1BitcoinDepositorDeployment
      case "Sui":
        return MainnetSuiBTCDepositorWormholeDeployment
      default:
        throw new Error("Unsupported destination chain")
    }
  },

  getSepolia: (destinationChainName: DestinationChainName) => {
    switch (destinationChainName) {
      case "Base":
        return SepoliaBaseL1BitcoinDepositorDeployment
      case "Arbitrum":
        return SepoliaArbitrumL1BitcoinDepositorDeployment
      case "Solana":
        return SepoliaSolanaL1BitcoinDepositorDeployment
      case "StarkNet":
        return SepoliaStarkNetL1BitcoinDepositorDeployment
      case "Sui":
        return SepoliaSuiBTCDepositorWormholeDeployment
      default:
        throw new Error("Unsupported destination chain")
    }
  },
}

/**
 * Implementation of the Ethereum L1BitcoinDepositor handle. It can be
 * constructed for each supported L2 chain.
 * @see {L1BitcoinDepositor} for reference.
 */
export class EthereumL1BitcoinDepositor
  extends EthersContractHandle<L1BitcoinDepositorTypechain>
  implements L1BitcoinDepositor
{
  readonly #extraDataEncoder: ExtraDataEncoder
  #depositOwner: ChainIdentifier | undefined

  constructor(
    config: EthersContractConfig,
    chainId: Chains.Ethereum,
    destinationChainName: DestinationChainName
  ) {
    let deployment: EthersContractDeployment

    switch (chainId) {
      case Chains.Ethereum.Sepolia:
        deployment = artifactLoader.getSepolia(destinationChainName)
        break
      case Chains.Ethereum.Mainnet:
        deployment = artifactLoader.getMainnet(destinationChainName)
        break
      default:
        throw new Error("Unsupported deployment type")
    }

    super(config, deployment)

    switch (destinationChainName) {
      case "StarkNet":
        this.#extraDataEncoder = new StarkNetExtraDataEncoder()
        break
      case "Sui":
        this.#extraDataEncoder = new SuiExtraDataEncoder()
        break
      case "Solana":
        this.#extraDataEncoder = new SolanaExtraDataEncoder()
        break
      default:
        this.#extraDataEncoder = new EthereumExtraDataEncoder()
        break
    }
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
   * @see {L1BitcoinDepositor#getDepositState}
   */
  getDepositState(depositId: string): Promise<DepositState> {
    return this._instance.deposits(depositId)
  }
  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {L1BitcoinDepositor#getChainIdentifier}
   */
  getChainIdentifier(): ChainIdentifier {
    return EthereumAddress.from(this._instance.address)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {L1BitcoinDepositor#extraDataEncoder}
   */
  extraDataEncoder(): ExtraDataEncoder {
    return this.#extraDataEncoder
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {L1BitcoinDepositor#initializeDeposit}
   */
  async initializeDeposit(
    depositTx: BitcoinRawTxVectors,
    depositOutputIndex: number,
    deposit: DepositReceipt,
    vault?: ChainIdentifier
  ): Promise<Hex> {
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
}

/**
 * Implementation of the Ethereum ExtraDataEncoder.
 * @see {ExtraDataEncoder} for reference.
 */
/**
 * Implementation of the Ethereum ExtraDataEncoder.
 * @see {ExtraDataEncoder} for reference.
 */
export class EthereumExtraDataEncoder implements ExtraDataEncoder {
  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {ExtraDataEncoder#encodeDepositOwner}
   */
  encodeDepositOwner(depositOwner: ChainIdentifier): Hex {
    // Make sure we are dealing with an Ethereum address. If not, this
    // call will throw.
    const address = EthereumAddress.from(depositOwner.identifierHex)

    // Extra data must be 32-byte so prefix the 20-byte address with
    // 12 zero bytes.
    return Hex.from(`000000000000000000000000${address.identifierHex}`)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {ExtraDataEncoder#decodeDepositOwner}
   */
  decodeDepositOwner(extraData: Hex): ChainIdentifier {
    // Cut the first 12 zero bytes of the extra data and convert the rest to
    // an Ethereum address.
    return EthereumAddress.from(
      Hex.from(extraData.toBuffer().subarray(12)).toString()
    )
  }
}

/**
 * @deprecated Use EthereumExtraDataEncoder instead
 */
export const EthereumCrossChainExtraDataEncoder = EthereumExtraDataEncoder
