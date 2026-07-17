import {
  GetChainEvents,
  TBTCVault,
  OptimisticMintingCancelledEvent,
  OptimisticMintingFinalizedEvent,
  OptimisticMintingRequest,
  OptimisticMintingRequestedEvent,
  ChainIdentifier,
  Chains,
} from "../contracts"

import { BitcoinTxHash } from "../bitcoin"
import { Hex } from "../utils"
import {
  asDeployment,
  EthereumContractConfig,
  EvmContractDeployment,
  EvmContractHandle,
} from "./adapter"
import { EthereumAddress } from "./address"
import { EthereumBridge } from "./bridge"

import MainnetTBTCVaultDeployment from "./artifacts/mainnet/TBTCVault.json"
import SepoliaTBTCVaultDeployment from "./artifacts/sepolia/TBTCVault.json"
import LocalTBTCVaultDeployment from "@keep-network/tbtc-v2/artifacts/TBTCVault.json"

/**
 * Converts a numeric value to a minimal-length, even-padded, 0x-prefixed hex
 * string - the exact format the ethers `BigNumber.toHexString()` produced
 * (e.g. `0x01` for 1), which downstream `Hex` handling relies on.
 * @param value The value to convert.
 * @returns The 0x-prefixed hex string.
 */
function toEvenLengthHex(value: bigint): string {
  let hex = value.toString(16)
  if (hex.length % 2 !== 0) {
    hex = `0${hex}`
  }
  return `0x${hex}`
}

/**
 * Implementation of the Ethereum TBTCVault handle.
 * @see {TBTCVault} for reference.
 */
export class EthereumTBTCVault extends EvmContractHandle implements TBTCVault {
  constructor(
    config: EthereumContractConfig,
    chainId: Chains.Ethereum = Chains.Ethereum.Local
  ) {
    let deployment: EvmContractDeployment

    switch (chainId) {
      case Chains.Ethereum.Local:
        deployment = asDeployment(LocalTBTCVaultDeployment)
        break
      case Chains.Ethereum.Sepolia:
        deployment = asDeployment(SepoliaTBTCVaultDeployment)
        break
      case Chains.Ethereum.Mainnet:
        deployment = asDeployment(MainnetTBTCVaultDeployment)
        break
      default:
        throw new Error("Unsupported deployment type")
    }

    super(config, deployment)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {TBTCVault#getChainIdentifier}
   */
  getChainIdentifier(): ChainIdentifier {
    return this.getAddress()
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {TBTCVault#optimisticMintingDelay}
   */
  async optimisticMintingDelay(): Promise<number> {
    const delaySeconds = await this._read<number | bigint>(
      "optimisticMintingDelay"
    )

    return Number(delaySeconds)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {TBTCVault#getMinters}
   */
  async getMinters(): Promise<EthereumAddress[]> {
    const minters = await this._read<readonly string[]>("getMinters")

    return minters.map(EthereumAddress.from)
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {TBTCVault#isMinter}
   */
  async isMinter(address: EthereumAddress): Promise<boolean> {
    return this._read<boolean>("isMinter", [`0x${address.identifierHex}`])
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {TBTCVault#isGuardian}
   */
  async isGuardian(address: EthereumAddress): Promise<boolean> {
    return this._read<boolean>("isGuardian", [`0x${address.identifierHex}`])
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {TBTCVault#requestOptimisticMint}
   */
  async requestOptimisticMint(
    depositTxHash: BitcoinTxHash,
    depositOutputIndex: number
  ): Promise<Hex> {
    return this._write(
      "requestOptimisticMint",
      [depositTxHash.reverse().toPrefixedString(), depositOutputIndex],
      {
        nonRetryableErrors: [
          "Optimistic minting already requested for the deposit",
          "The deposit is already swept",
        ],
      }
    )
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {TBTCVault#cancelOptimisticMint}
   */
  async cancelOptimisticMint(
    depositTxHash: BitcoinTxHash,
    depositOutputIndex: number
  ): Promise<Hex> {
    return this._write(
      "cancelOptimisticMint",
      [depositTxHash.reverse().toPrefixedString(), depositOutputIndex],
      {
        nonRetryableErrors: [
          "Optimistic minting already finalized for the deposit",
        ],
      }
    )
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {TBTCVault#finalizeOptimisticMint}
   */
  async finalizeOptimisticMint(
    depositTxHash: BitcoinTxHash,
    depositOutputIndex: number
  ): Promise<Hex> {
    return this._write(
      "finalizeOptimisticMint",
      [depositTxHash.reverse().toPrefixedString(), depositOutputIndex],
      {
        nonRetryableErrors: [
          "Optimistic minting already finalized for the deposit",
          "The deposit is already swept",
        ],
      }
    )
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {TBTCVault#optimisticMintingRequests}
   */
  async optimisticMintingRequests(
    depositTxHash: BitcoinTxHash,
    depositOutputIndex: number
  ): Promise<OptimisticMintingRequest> {
    const depositKey = EthereumBridge.buildDepositKey(
      depositTxHash,
      depositOutputIndex
    )

    // `optimisticMintingRequests` returns two outputs
    // (requestedAt, finalizedAt) which viem decodes as a positional array.
    const [requestedAt, finalizedAt] = await this._read<
      readonly [number | bigint, number | bigint]
    >("optimisticMintingRequests", [BigInt(depositKey)])

    return {
      requestedAt: Number(requestedAt),
      finalizedAt: Number(finalizedAt),
    }
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {ChainBridge#getOptimisticMintingRequestedEvents}
   */
  async getOptimisticMintingRequestedEvents(
    options?: GetChainEvents.Options,
    ...filterArgs: Array<any>
  ): Promise<OptimisticMintingRequestedEvent[]> {
    const events = await this._getEvents(
      "OptimisticMintingRequested",
      options,
      ...filterArgs
    )

    return events.map<OptimisticMintingRequestedEvent>((event) => {
      return {
        blockNumber: event.blockNumber,
        blockHash: Hex.from(event.blockHash),
        transactionHash: Hex.from(event.transactionHash),
        minter: EthereumAddress.from(event.args.minter as string),
        depositKey: Hex.from(
          toEvenLengthHex(BigInt(event.args.depositKey as number | bigint))
        ),
        depositor: EthereumAddress.from(event.args.depositor as string),
        amount: BigInt(event.args.amount as number | bigint),
        fundingTxHash: BitcoinTxHash.from(
          event.args.fundingTxHash as string
        ).reverse(),
        fundingOutputIndex: Number(
          event.args.fundingOutputIndex as number | bigint
        ),
      }
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {ChainBridge#getOptimisticMintingCancelledEvents}
   */
  async getOptimisticMintingCancelledEvents(
    options?: GetChainEvents.Options,
    ...filterArgs: Array<any>
  ): Promise<OptimisticMintingCancelledEvent[]> {
    const events = await this._getEvents(
      "OptimisticMintingCancelled",
      options,
      ...filterArgs
    )

    return events.map<OptimisticMintingCancelledEvent>((event) => {
      return {
        blockNumber: event.blockNumber,
        blockHash: Hex.from(event.blockHash),
        transactionHash: Hex.from(event.transactionHash),
        guardian: EthereumAddress.from(event.args.guardian as string),
        depositKey: Hex.from(
          toEvenLengthHex(BigInt(event.args.depositKey as number | bigint))
        ),
      }
    })
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * @see {ChainBridge#getOptimisticMintingFinalizedEvents}
   */
  async getOptimisticMintingFinalizedEvents(
    options?: GetChainEvents.Options,
    ...filterArgs: Array<any>
  ): Promise<OptimisticMintingFinalizedEvent[]> {
    const events = await this._getEvents(
      "OptimisticMintingFinalized",
      options,
      ...filterArgs
    )

    return events.map<OptimisticMintingFinalizedEvent>((event) => {
      return {
        blockNumber: event.blockNumber,
        blockHash: Hex.from(event.blockHash),
        transactionHash: Hex.from(event.transactionHash),
        minter: EthereumAddress.from(event.args.minter as string),
        depositKey: Hex.from(
          toEvenLengthHex(BigInt(event.args.depositKey as number | bigint))
        ),
        depositor: EthereumAddress.from(event.args.depositor as string),
        optimisticMintingDebt: BigInt(
          event.args.optimisticMintingDebt as number | bigint
        ),
      }
    })
  }
}
