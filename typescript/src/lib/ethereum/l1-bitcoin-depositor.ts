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
import MainnetSeiL1BitcoinDepositorDeployment from "./artifacts/mainnet/SeiL1BitcoinDepositor.json"

import SepoliaBaseL1BitcoinDepositorDeployment from "./artifacts/sepolia/BaseL1BitcoinDepositor.json"
import SepoliaArbitrumL1BitcoinDepositorDeployment from "./artifacts/sepolia/ArbitrumL1BitcoinDepositor.json"
import SepoliaStarkNetL1BitcoinDepositorDeployment from "./artifacts/sepolia/StarkNetBitcoinDepositor.json"
import SepoliaSuiBTCDepositorWormholeDeployment from "./artifacts/sepolia/SuiBTCDepositorWormhole.json"
import SepoliaSeiL1BitcoinDepositorDeployment from "./artifacts/sepolia/SeiL1BitcoinDepositor.json"

import SepoliaSolanaL1BitcoinDepositorDeployment from "./artifacts/sepolia/SolanaL1BitcoinDepositor.json"
import { SuiExtraDataEncoder } from "../sui"
import { StarkNetExtraDataEncoder } from "../starknet"
import { SolanaExtraDataEncoder } from "../solana"
import { SeiExtraDataEncoder } from "../sei"

const mainnetArtifacts: Record<DestinationChainName, EthersContractDeployment> =
  {
    Base: MainnetBaseL1BitcoinDepositorDeployment,
    Arbitrum: MainnetArbitrumL1BitcoinDepositorDeployment,
    Solana: MainnetSolanaL1BitcoinDepositorDeployment,
    StarkNet: MainnetStarkNetL1BitcoinDepositorDeployment,
    Sui: MainnetSuiBTCDepositorWormholeDeployment,
    Sei: MainnetSeiL1BitcoinDepositorDeployment,
  }

const sepoliaArtifacts: Record<DestinationChainName, EthersContractDeployment> =
  {
    Base: SepoliaBaseL1BitcoinDepositorDeployment,
    Arbitrum: SepoliaArbitrumL1BitcoinDepositorDeployment,
    Solana: SepoliaSolanaL1BitcoinDepositorDeployment,
    StarkNet: SepoliaStarkNetL1BitcoinDepositorDeployment,
    Sui: SepoliaSuiBTCDepositorWormholeDeployment,
    Sei: SepoliaSeiL1BitcoinDepositorDeployment,
  }

const artifactLoaders: Partial<
  Record<
    Chains.Ethereum,
    Record<DestinationChainName, EthersContractDeployment>
  >
> = {
  [Chains.Ethereum.Mainnet]: mainnetArtifacts,
  [Chains.Ethereum.Sepolia]: sepoliaArtifacts,
}

const extraDataEncoders: Partial<
  Record<DestinationChainName, new () => ExtraDataEncoder>
> = {
  Solana: SolanaExtraDataEncoder,
  StarkNet: StarkNetExtraDataEncoder,
  Sui: SuiExtraDataEncoder,
  Sei: SeiExtraDataEncoder,
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
    const deploymentArtifacts = artifactLoaders[chainId]
    if (!deploymentArtifacts) {
      throw new Error("Unsupported deployment type")
    }
    const deployment = deploymentArtifacts[destinationChainName]
    if (!deployment) {
      throw new Error("Unsupported destination chain")
    }

    super(config, deployment)

    const ExtraDataEncoderConstructor =
      extraDataEncoders[destinationChainName] ?? EthereumExtraDataEncoder
    this.#extraDataEncoder = new ExtraDataEncoderConstructor()
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

    const tx = await this._instance.initializeDeposit(
      fundingTx,
      reveal,
      deposit.extraData.toPrefixedString()
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
