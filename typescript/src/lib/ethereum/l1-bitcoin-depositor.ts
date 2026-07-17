import {
  asDeployment,
  EthereumContractConfig,
  EvmContractDeployment,
  EvmContractHandle,
} from "./adapter"
import {
  ChainIdentifier,
  Chains,
  ExtraDataEncoder,
  DepositReceipt,
  DepositState,
  L1BitcoinDepositor,
  DestinationChainName,
} from "../contracts"
import { packRevealDepositParameters } from "./bridge"
import { EthereumAddress } from "./address"
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

const mainnetArtifacts: Record<DestinationChainName, EvmContractDeployment> = {
  Base: asDeployment(MainnetBaseL1BitcoinDepositorDeployment),
  Arbitrum: asDeployment(MainnetArbitrumL1BitcoinDepositorDeployment),
  Solana: asDeployment(MainnetSolanaL1BitcoinDepositorDeployment),
  StarkNet: asDeployment(MainnetStarkNetL1BitcoinDepositorDeployment),
  Sui: asDeployment(MainnetSuiBTCDepositorWormholeDeployment),
}

const sepoliaArtifacts: Record<DestinationChainName, EvmContractDeployment> = {
  Base: asDeployment(SepoliaBaseL1BitcoinDepositorDeployment),
  Arbitrum: asDeployment(SepoliaArbitrumL1BitcoinDepositorDeployment),
  Solana: asDeployment(SepoliaSolanaL1BitcoinDepositorDeployment),
  StarkNet: asDeployment(SepoliaStarkNetL1BitcoinDepositorDeployment),
  Sui: asDeployment(SepoliaSuiBTCDepositorWormholeDeployment),
}

const artifactLoaders: Partial<
  Record<Chains.Ethereum, Record<DestinationChainName, EvmContractDeployment>>
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
}

/**
 * Implementation of the Ethereum L1BitcoinDepositor handle. It can be
 * constructed for each supported L2 chain.
 * @see {L1BitcoinDepositor} for reference.
 */
export class EthereumL1BitcoinDepositor
  extends EvmContractHandle
  implements L1BitcoinDepositor
{
  readonly #extraDataEncoder: ExtraDataEncoder
  #depositOwner: ChainIdentifier | undefined

  constructor(
    config: EthereumContractConfig,
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
  async getDepositState(depositId: string): Promise<DepositState> {
    const state = await this._read<number | bigint>("deposits", [
      BigInt(depositId),
    ])

    return Number(state)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {L1BitcoinDepositor#getChainIdentifier}
   */
  getChainIdentifier(): ChainIdentifier {
    return this.getAddress()
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

    return this._write("initializeDeposit", [
      fundingTx,
      reveal,
      deposit.extraData.toPrefixedString(),
    ])
  }
}

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
