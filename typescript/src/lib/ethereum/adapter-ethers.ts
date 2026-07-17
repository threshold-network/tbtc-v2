import {
  ContractTransaction as EthersContractTransaction,
  providers,
  Signer,
  utils,
} from "ethers"
import {
  Contract as EthersContract,
  Event as EthersEvent,
  EventFilter as EthersEventFilter,
} from "@ethersproject/contracts"
import { GetChainEvents } from "../contracts"
import {
  backoffRetrier,
  ExecutionLoggerFn,
  skipRetryWhenMatched,
} from "../utils"
import { EthereumAddress } from "./address"

/**
 * Contract deployment artifact.
 * @see [hardhat-deploy#Deployment](https://github.com/wighawag/hardhat-deploy/blob/0c969e9a27b4eeff9f5ccac7e19721ef2329eed2/types.ts#L358)}
 */
export interface EthersContractDeployment {
  /**
   * Address of the deployed contract.
   */
  address: string
  /**
   * Contract's ABI.
   */
  abi: any[]
  /**
   * Deployment transaction receipt.
   */
  receipt: {
    /**
     * Number of block in which the contract was deployed.
     */
    blockNumber: number
  }
}

/**
 * Represents a config set required to connect an Ethereum contract.
 */
export interface EthersContractConfig {
  /**
   * Address of the Ethereum contract as a 0x-prefixed hex string.
   * Optional parameter, if not provided the value will be resolved from the
   * contract artifact.
   */
  address?: string
  /**
   * Signer - will return a Contract which will act on behalf of that signer. The signer will sign all contract transactions.
   * Provider - will return a downgraded Contract which only has read-only access (i.e. constant calls)
   */
  signerOrProvider: Signer | providers.Provider
  /**
   * Number of a block in which the contract was deployed.
   * Optional parameter, if not provided the value will be resolved from the
   * contract artifact.
   */
  deployedAtBlockNumber?: number
}

/**
 * Ethers-based contract handle.
 */
export class EthersContractHandle<T extends EthersContract> {
  /**
   * Ethers instance of the deployed contract.
   */
  protected readonly _instance: T
  /**
   * Number of a block within which the contract was deployed. Value is read from
   * the contract deployment artifact. It can be overwritten by setting a
   * {@link EthersContractConfig.deployedAtBlockNumber} property.
   */
  protected readonly _deployedAtBlockNumber: number
  /**
   * Number of retries for ethereum requests.
   */
  protected readonly _totalRetryAttempts: number

  /**
   * @param config Configuration for contract instance initialization.
   * @param deployment Contract Deployment artifact.
   * @param totalRetryAttempts Number of retries for ethereum requests.
   */
  constructor(
    config: EthersContractConfig,
    deployment: EthersContractDeployment,
    totalRetryAttempts = 3
  ) {
    this._instance = new EthersContract(
      config.address ?? utils.getAddress(deployment.address),
      `${JSON.stringify(deployment.abi)}`,
      config.signerOrProvider
    ) as T

    this._deployedAtBlockNumber =
      config.deployedAtBlockNumber ?? deployment.receipt.blockNumber

    this._totalRetryAttempts = totalRetryAttempts
  }

  /**
   * Get address of the contract instance.
   * @returns Address of this contract instance.
   */
  getAddress(): EthereumAddress {
    return EthereumAddress.from(this._instance.address)
  }

  /**
   * Get events emitted by the Ethereum contract.
   * It starts searching from provided block number. If the {@link GetEvents.Options#fromBlock}
   * option is missing it looks for a contract's defined property
   * {@link _deployedAtBlockNumber}. If the property is missing starts searching
   * from block `0`.
   * @param eventName Name of the event.
   * @param options Options for events fetching.
   * @param filterArgs Arguments for events filtering.
   * @returns Array of found events.
   */
  async getEvents(
    eventName: string,
    options?: GetChainEvents.Options,
    ...filterArgs: Array<unknown>
  ): Promise<EthersEvent[]> {
    return backoffRetrier<EthersEvent[]>(
      options?.retries ?? this._totalRetryAttempts
    )(async () => {
      return await EthersEventUtils.getEvents(
        this._instance,
        this._instance.filters[eventName](...filterArgs),
        options?.fromBlock ?? this._deployedAtBlockNumber,
        options?.toBlock,
        options?.batchedQueryBlockInterval,
        options?.logger
      )
    })
  }
}

/**
 * Ethers-based utilities for transactions.
 */
export namespace EthersTransactionUtils {
  /**
   * Sends ethereum transaction with retries.
   * @param fn Function to execute with retries.
   * @param retries The number of retries to perform before bubbling the failure out.
   * @param logger A logger function to pass execution messages.
   * @param nonRetryableErrors List of error messages that if returned from executed
   *        function, should break the retry loop and return immediately.
   * @returns Result of function execution.
   * @throws An error returned by function execution. An error thrown by the executed
   *         function is processed by {@link resolveEthersError} function to resolve
   *         the revert message in case of a transaction revert.
   */
  export async function sendWithRetry<T extends EthersContractTransaction>(
    fn: () => Promise<T>,
    retries: number,
    logger?: ExecutionLoggerFn,
    nonRetryableErrors?: Array<string | RegExp>
  ): Promise<T> {
    return backoffRetrier<T>(
      retries,
      1000,
      logger,
      nonRetryableErrors ? skipRetryWhenMatched(nonRetryableErrors) : undefined
    )(async () => {
      try {
        return await fn()
      } catch (err: unknown) {
        throw resolveEthersError(err)
      }
    })
  }

  /**
   * Represents an interface that matches the errors structure thrown by ethers library.
   * {@see {@link https://github.com/ethers-io/ethers.js/blob/c80fcddf50a9023486e9f9acb1848aba4c19f7b6/packages/logger/src.ts/index.ts#L268-L277 ethers source code}}
   */
  interface EthersError extends Error {
    reason: string
    code: string
    error: unknown
  }

  /**
   * Takes an error and tries to resolve a revert message if the error is related
   * to reverted transaction.
   * @param err Error to process.
   * @returns Error with a revert message or the input error when the error could
   *          not be resolved successfully.
   */
  function resolveEthersError(err: unknown): unknown {
    const isEthersError = (obj: any): obj is EthersError => {
      return "reason" in obj && "code" in obj && "error" in obj
    }

    if (isEthersError(err) && err !== null) {
      // Ethers errors are nested. The parent UNPREDICTABLE_GAS_LIMIT has a general
      // reason "cannot estimate gas; transaction may fail or may require manual gas limit",
      if (err.code === "UNPREDICTABLE_GAS_LIMIT") {
        if (typeof isEthersError(err["error"]) && err["error"] !== null) {
          // The nested error is expected to contain a reason property with a message
          // of the transaction revert.
          return new Error((err["error"] as EthersError).reason)
        }
      }
    }

    return err
  }
}

/**
 * Ethers-based utilities for events.
 */
export namespace EthersEventUtils {
  const GET_EVENTS_BLOCK_INTERVAL = 10_000

  /**
   * Looks up all existing events defined by the {@link event} filter on
   * {@link sourceContract}, searching past blocks and then returning them.
   * Does not wait for any new events. It starts searching from provided block number.
   * If the {@link fromBlock} is missing it starts searching from block `0`.
   * It pulls events in one `getLogs` call. If the call fails it fallbacks to querying
   * events in batches of {@link batchedQueryBlockInterval} blocks. If the parameter
   * is not set it queries in {@link GET_EVENTS_BLOCK_INTERVAL} blocks batches.
   * @param sourceContract The contract instance that emits the event.
   * @param event The event filter to query.
   * @param fromBlock Starting block for events search.
   * @param toBlock Ending block for events search.
   * @param batchedQueryBlockInterval Block interval for batched events pulls.
   * @param logger A logger function to pass execution messages.
   * @returns A promise that will be fulfilled by the list of event objects once
   *          they are found.
   */
  export async function getEvents(
    sourceContract: EthersContract,
    event: EthersEventFilter,
    fromBlock: number = 0,
    toBlock: number | string = "latest",
    batchedQueryBlockInterval: number = GET_EVENTS_BLOCK_INTERVAL,
    logger: ExecutionLoggerFn = console.debug
  ): Promise<EthersEvent[]> {
    return new Promise(async (resolve, reject) => {
      let resultEvents: EthersEvent[] = []
      try {
        resultEvents = await sourceContract.queryFilter(
          event,
          fromBlock,
          toBlock
        )
      } catch (err) {
        logger(
          `switching to partial events pulls; ` +
            `failed to get events in one request from contract: [${event.address}], ` +
            `fromBlock: [${fromBlock}], toBlock: [${toBlock}]: [${err}]`
        )

        try {
          if (typeof toBlock === "string") {
            toBlock = (await sourceContract.provider.getBlock(toBlock)).number
          }

          let batchStartBlock = fromBlock

          while (batchStartBlock <= toBlock) {
            let batchEndBlock = batchStartBlock + batchedQueryBlockInterval
            if (batchEndBlock > toBlock) {
              batchEndBlock = toBlock
            }
            logger(
              `executing partial events pull from contract: [${event.address}], ` +
                `fromBlock: [${batchStartBlock}], toBlock: [${batchEndBlock}]`
            )
            const foundEvents = await sourceContract.queryFilter(
              event,
              batchStartBlock,
              batchEndBlock
            )

            resultEvents = resultEvents.concat(foundEvents)
            logger(
              `fetched [${foundEvents.length}] events, has ` +
                `[${resultEvents.length}] total`
            )

            batchStartBlock = batchEndBlock + 1
          }
        } catch (error) {
          return reject(error)
        }
      }

      return resolve(resultEvents)
    })
  }
}
