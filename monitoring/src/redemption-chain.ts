import { BigNumber, utils } from "ethers"
import {
  BitcoinCompactSizeUint,
  BitcoinTxHash,
  EthereumBridge,
  Hex,
} from "@keep-network/tbtc-v2.ts"

import type { providers } from "ethers"
import type {
  Bridge,
  ChainEvent,
  RedemptionRequestedEvent,
} from "@keep-network/tbtc-v2.ts"

export interface RedemptionsCompletedEvent extends ChainEvent {
  walletPublicKeyHash: Hex
  redemptionTxHash: BitcoinTxHash
}

export interface RedemptionTimedOutEvent extends ChainEvent {
  walletPublicKeyHash: Hex
  redeemerOutputScript: Hex
}

export interface RedemptionLifecycleSource {
  requested(
    fromBlock: number,
    toBlock: number
  ): Promise<RedemptionRequestedEvent[]>
  completed(
    fromBlock: number,
    toBlock: number
  ): Promise<RedemptionsCompletedEvent[]>
  timedOut(
    fromBlock: number,
    toBlock: number
  ): Promise<RedemptionTimedOutEvent[]>
  // Undefined means the Bridge had no code at this historical block.
  timeout(block: number): Promise<number | undefined>
  pendingRequestedAt(
    request: RedemptionRequestedEvent,
    block: number
  ): Promise<number>
  blockTimestamp(block: number): Promise<number>
}

// The monitoring package pins SDK 2.5. Keep this small read-only adapter until
// its SDK can be upgraded to a release exposing these lifecycle methods.
// Signatures match solidity/contracts/bridge/Bridge.sol.
export const redemptionMonitoringABI = new utils.Interface([
  "event RedemptionsCompleted(bytes20 indexed walletPubKeyHash, bytes32 redemptionTxHash)",
  "event RedemptionTimedOut(bytes20 indexed walletPubKeyHash, bytes redeemerOutputScript)",
  "function redemptionParameters() view returns (uint64 redemptionDustThreshold, uint64 redemptionTreasuryFeeDivisor, uint64 redemptionTxMaxFee, uint64 redemptionTxMaxTotalFee, uint32 redemptionTimeout, uint96 redemptionTimeoutSlashingAmount, uint32 redemptionTimeoutNotifierRewardMultiplier)",
  "function pendingRedemptions(uint256 redemptionKey) view returns (tuple(address redeemer, uint64 requestedAmount, uint64 treasuryFee, uint64 txMaxFee, uint32 requestedAt))",
])

const maxLogQueryBlocks = 5000

export class RedemptionChain implements RedemptionLifecycleSource {
  private readonly address: string

  constructor(
    private readonly bridge: Pick<
      Bridge,
      "getChainIdentifier" | "getRedemptionRequestedEvents"
    >,
    private readonly provider: Pick<
      providers.Provider,
      "getLogs" | "call" | "getBlock" | "getCode"
    >
  ) {
    this.address = `0x${bridge.getChainIdentifier().identifierHex}`
  }

  async requested(
    fromBlock: number,
    toBlock: number
  ): Promise<RedemptionRequestedEvent[]> {
    return RedemptionChain.inBatches(fromBlock, toBlock, (from, to) =>
      this.bridge.getRedemptionRequestedEvents({ fromBlock: from, toBlock: to })
    )
  }

  async completed(
    fromBlock: number,
    toBlock: number
  ): Promise<RedemptionsCompletedEvent[]> {
    const logs = await this.logs("RedemptionsCompleted", fromBlock, toBlock)
    return logs.map((log) => ({
      ...RedemptionChain.metadata(log),
      walletPublicKeyHash: Hex.from(
        redemptionMonitoringABI.parseLog(log).args.walletPubKeyHash
      ),
      redemptionTxHash: BitcoinTxHash.from(
        redemptionMonitoringABI.parseLog(log).args.redemptionTxHash
      ).reverse(),
    }))
  }

  async timedOut(
    fromBlock: number,
    toBlock: number
  ): Promise<RedemptionTimedOutEvent[]> {
    const logs = await this.logs("RedemptionTimedOut", fromBlock, toBlock)
    return logs.map((log) => {
      const { walletPubKeyHash, redeemerOutputScript } =
        redemptionMonitoringABI.parseLog(log).args
      const script = Hex.from(redeemerOutputScript)
      const prefix = BitcoinCompactSizeUint.read(script)
      return {
        ...RedemptionChain.metadata(log),
        walletPublicKeyHash: Hex.from(walletPubKeyHash),
        redeemerOutputScript: Hex.from(
          script.toString().slice(prefix.byteLength * 2)
        ),
      }
    })
  }

  async timeout(block: number): Promise<number | undefined> {
    const encoded = await this.call("redemptionParameters", [], block)
    // eth_call returns empty data before deployment. Confirm the missing code
    // rather than interpreting archive-node errors or invalid deployed responses
    // as an empty monitoring window.
    if (
      encoded === "0x" &&
      (await this.provider.getCode(this.address, block)) === "0x"
    ) {
      return undefined
    }
    const result = redemptionMonitoringABI.decodeFunctionResult(
      "redemptionParameters",
      encoded
    )
    return BigNumber.from(result.redemptionTimeout).toNumber()
  }

  async pendingRequestedAt(
    request: RedemptionRequestedEvent,
    block: number
  ): Promise<number> {
    const key = EthereumBridge.buildRedemptionKey(
      request.walletPublicKeyHash,
      request.redeemerOutputScript
    )
    const result = await this.read("pendingRedemptions", [key], block)
    return BigNumber.from(result[0].requestedAt).toNumber()
  }

  async blockTimestamp(block: number): Promise<number> {
    const header = await this.provider.getBlock(block)
    if (!header) throw new Error(`missing Ethereum block ${block}`)
    return header.timestamp
  }

  private async read(
    method: string,
    args: unknown[],
    block: number
  ): Promise<utils.Result> {
    const encoded = await this.call(method, args, block)
    return redemptionMonitoringABI.decodeFunctionResult(method, encoded)
  }

  private call(
    method: string,
    args: unknown[],
    block: number
  ): Promise<string> {
    return this.provider.call(
      {
        to: this.address,
        data: redemptionMonitoringABI.encodeFunctionData(method, args),
      },
      block
    )
  }

  private logs(
    event: string,
    fromBlock: number,
    toBlock: number
  ): Promise<providers.Log[]> {
    return RedemptionChain.inBatches(fromBlock, toBlock, (from, to) =>
      this.provider.getLogs({
        address: this.address,
        topics: [redemptionMonitoringABI.getEventTopic(event)],
        fromBlock: from,
        toBlock: to,
      })
    )
  }

  private static metadata(log: providers.Log): ChainEvent {
    return {
      blockNumber: log.blockNumber,
      blockHash: Hex.from(log.blockHash),
      transactionHash: Hex.from(log.transactionHash),
    }
  }

  private static async inBatches<T>(
    fromBlock: number,
    toBlock: number,
    query: (from: number, to: number) => Promise<T[]>
  ): Promise<T[]> {
    const result: T[] = []
    for (let from = fromBlock; from <= toBlock; from += maxLogQueryBlocks) {
      // Sequential batches cap RPC pressure during catch-up and timeout changes.
      // eslint-disable-next-line no-await-in-loop
      const batch = await query(
        from,
        Math.min(from + maxLogQueryBlocks - 1, toBlock)
      )
      result.push(...batch)
    }
    return result
  }
}
