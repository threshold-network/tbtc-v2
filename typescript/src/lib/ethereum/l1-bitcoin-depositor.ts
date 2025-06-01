import {
  EthersContractConfig,
  EthersContractDeployment,
  EthersContractHandle,
} from "./adapter"
import { L1BitcoinDepositor as L1BitcoinDepositorTypechain } from "../../../typechain/L1BitcoinDepositor"
import {
  ChainIdentifier,
  Chains,
  CrossChainExtraDataEncoder,
  DepositReceipt,
  DepositState,
  L1BitcoinDepositor,
  L2Chain,
} from "../contracts"
import { EthereumAddress, packRevealDepositParameters } from "./index"
import { BitcoinRawTxVectors } from "../bitcoin"
import { Hex } from "../utils"

import MainnetBaseL1BitcoinDepositorDeployment from "./artifacts/mainnet/BaseL1BitcoinDepositor.json"
import MainnetArbitrumL1BitcoinDepositorDeployment from "./artifacts/mainnet/ArbitrumOneL1BitcoinDepositor.json"
import MainnetStarkNetL1BitcoinDepositorDeployment from "./artifacts/mainnet/StarkNetL1BitcoinDepositor.json"

import SepoliaBaseL1BitcoinDepositorDeployment from "./artifacts/sepolia/BaseL1BitcoinDepositor.json"
import SepoliaArbitrumL1BitcoinDepositorDeployment from "./artifacts/sepolia/ArbitrumL1BitcoinDepositor.json"
import SepoliaStarkNetL1BitcoinDepositorDeployment from "./artifacts/sepolia/StarkNetL1BitcoinDepositor.json"

const artifactLoader = {
  getMainnet: (l2ChainName: L2Chain) => {
    switch (l2ChainName) {
      case "Base":
        return MainnetBaseL1BitcoinDepositorDeployment
      case "Arbitrum":
        return MainnetArbitrumL1BitcoinDepositorDeployment
      case "StarkNet":
        return MainnetStarkNetL1BitcoinDepositorDeployment
      default:
        throw new Error("Unsupported L2 chain")
    }
  },

  getSepolia: (l2ChainName: L2Chain) => {
    switch (l2ChainName) {
      case "Base":
        return SepoliaBaseL1BitcoinDepositorDeployment
      case "Arbitrum":
        return SepoliaArbitrumL1BitcoinDepositorDeployment
      case "StarkNet":
        return SepoliaStarkNetL1BitcoinDepositorDeployment
      default:
        throw new Error("Unsupported L2 chain")
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
  readonly #extraDataEncoder: CrossChainExtraDataEncoder

  constructor(
    config: EthersContractConfig,
    chainId: Chains.Ethereum,
    l2ChainName: L2Chain
  ) {
    let deployment: EthersContractDeployment

    switch (chainId) {
      case Chains.Ethereum.Sepolia:
        deployment = artifactLoader.getSepolia(l2ChainName)
        break
      case Chains.Ethereum.Mainnet:
        deployment = artifactLoader.getMainnet(l2ChainName)
        break
      default:
        throw new Error("Unsupported deployment type")
    }

    super(config, deployment)

    // Use StarkNet encoder for StarkNet, otherwise use Ethereum encoder
    if (l2ChainName === "StarkNet") {
      const { StarkNetCrossChainExtraDataEncoder } = require("../starknet")
      this.#extraDataEncoder = new StarkNetCrossChainExtraDataEncoder()
    } else {
      this.#extraDataEncoder = new EthereumCrossChainExtraDataEncoder()
    }
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
  extraDataEncoder(): CrossChainExtraDataEncoder {
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
 * Implementation of the Ethereum CrossChainExtraDataEncoder.
 * @see {CrossChainExtraDataEncoder} for reference.
 */
export class EthereumCrossChainExtraDataEncoder
  implements CrossChainExtraDataEncoder
{
  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {CrossChainExtraDataEncoder#encodeDepositOwner}
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
   * @see {CrossChainExtraDataEncoder#decodeDepositOwner}
   */
  decodeDepositOwner(extraData: Hex): ChainIdentifier {
    // Cut the first 12 zero bytes of the extra data and convert the rest to
    // an Ethereum address.
    return EthereumAddress.from(
      Hex.from(extraData.toBuffer().subarray(12)).toString()
    )
  }
}
