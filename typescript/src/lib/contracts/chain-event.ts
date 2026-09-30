import { ExecutionLoggerFn, Hex } from "../utils"

/**
 * Minimal chain-agnostic transaction receipt. Replaces the ethers
 * `TransactionReceipt` type in public unions.
 */
export interface ChainTransactionReceipt {
  /**
   * 0x-prefixed transaction hash.
   */
  transactionHash: string
  /**
   * Number of the block the transaction was included in.
   */
  blockNumber?: number
  /**
   * Status of the transaction. The `number` variant is kept for relayer
   * passthrough responses (e.g. StarkNet).
   */
  status?: "success" | "reverted" | number
}

/**
 * Represents a generic chain event.
 */
export interface ChainEvent {
  /**
   * Block number of the event emission.
   */
  blockNumber: number
  /**
   * Block hash of the event emission.
   */
  blockHash: Hex
  /**
   * Transaction hash within which the event was emitted.
   */
  transactionHash: Hex
}

export namespace GetChainEvents {
  /**
   * Represents generic options used for getting events from the chain.
   */
  export interface Options {
    /**
     * Block number from which events should be queried.
     * If not defined a block number of a contract deployment is used.
     */
    fromBlock?: number
    /**
     * Block number to which events should be queried.
     * If not defined the latest block number will be used.
     */
    toBlock?: number
    /**
     * Number of retries in case of an error getting the events.
     */
    retries?: number
    /**
     * Number of blocks for interval length in partial events pulls.
     */
    batchedQueryBlockInterval?: number
    /**
     * A logger function to pass execution messages.
     */
    logger?: ExecutionLoggerFn
  }

  /**
   * Represents a generic function to get events emitted on the chain.
   */
  export interface Function<T extends ChainEvent> {
    /**
     * Get emitted events.
     * @param options Options for getting events.
     * @param filterArgs Arguments for events filtering.
     * @returns Array of found events.
     */
    (options?: Options, ...filterArgs: Array<any>): Promise<T[]>
  }
}
