import {
  BaseError,
  ContractFunctionRevertedError,
  getAddress,
  type Abi,
  type AbiEvent,
  type Address,
  type PublicClient,
} from "viem"
import { GetChainEvents } from "../contracts"
import {
  backoffRetrier,
  ExecutionLoggerFn,
  Hex,
  skipRetryWhenMatched,
} from "../utils"
import { EthereumAddress } from "./address"
import { connectEvm, EthereumSigner, EvmConnection } from "./evm-connection"

/**
 * Default number of blocks for interval length in partial events pulls.
 */
const GET_EVENTS_BLOCK_INTERVAL = 10_000

/**
 * Contract deployment artifact.
 * @see [hardhat-deploy#Deployment](https://github.com/wighawag/hardhat-deploy/blob/0c969e9a27b4eeff9f5ccac7e19721ef2329eed2/types.ts#L358)}
 */
export interface EvmContractDeployment {
  /**
   * Address of the deployed contract.
   */
  address: string
  /**
   * Contract's ABI.
   */
  abi: Abi
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
 * Casts a hardhat-deploy artifact JSON module to {@link EvmContractDeployment}.
 * The `unknown` hop is needed because TypeScript widens JSON literal types.
 * @param json Artifact JSON module.
 * @returns The artifact typed as a deployment.
 */
export function asDeployment(json: unknown): EvmContractDeployment {
  return json as EvmContractDeployment
}

/**
 * Represents a config set required to connect an Ethereum contract.
 */
export interface EthereumContractConfig {
  /**
   * Address of the Ethereum contract as a 0x-prefixed hex string.
   * Optional parameter, if not provided the value will be resolved from the
   * contract artifact.
   */
  address?: string
  /**
   * Signer - will allow the contract handle to send write transactions on
   * behalf of that signer, besides read-only access.
   * Provider - will give the contract handle read-only access.
   * An already-normalized {@link EvmConnection} may be passed as an internal
   * fast path (used by the contract loaders to normalize once per
   * initialization).
   */
  signerOrProvider: EthereumSigner | EvmConnection
  /**
   * Number of a block in which the contract was deployed.
   * Optional parameter, if not provided the value will be resolved from the
   * contract artifact.
   */
  deployedAtBlockNumber?: number
}

/**
 * SDK-owned decoded event (replaces the ethers `Event` in the internal
 * mapping layer).
 */
export interface EvmEvent {
  /**
   * Block number of the event emission.
   */
  blockNumber: number
  /**
   * Block hash of the event emission as a 0x-prefixed hex string.
   */
  blockHash: string
  /**
   * Transaction hash within which the event was emitted as a 0x-prefixed
   * hex string.
   */
  transactionHash: string
  /**
   * Decoded named event arguments. Numeric values arrive as `bigint` for
   * types wider than 48 bits and `number` otherwise - normalize with
   * `BigInt(x)` / `Number(x)` at the parsing site.
   */
  args: Record<string, unknown>
}

/**
 * Error signaling a contract execution revert. The error `message` equals
 * the raw revert `reason` string so that message-based error matchers
 * (e.g. {@link skipRetryWhenMatched}) fire on the exact `require` message.
 */
export class EvmRevertError extends Error {
  /**
   * The raw revert reason string, e.g. "Deposit already revealed".
   */
  readonly reason: string
  /**
   * The underlying error the revert was extracted from.
   */
  readonly cause?: unknown

  constructor(reason: string, cause?: unknown) {
    super(reason)
    this.name = "EvmRevertError"
    this.reason = reason
    this.cause = cause
  }
}

/**
 * Takes an error thrown by a viem action and, if it carries a contract
 * revert, converts it to an {@link EvmRevertError} whose message is the raw
 * revert reason. Any other error (network/transport) passes through
 * untouched so that generic retry logic treats it as retryable.
 * @param err Error to process.
 * @returns An {@link EvmRevertError} or the input error.
 */
export function normalizeEvmError(err: unknown): unknown {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError)
    if (revert instanceof ContractFunctionRevertedError) {
      // revert.reason is the raw require() string, e.g.
      // "Deposit already revealed" or
      // "Wallet with the given ID has not been registered".
      const reason = revert.reason ?? revert.shortMessage
      if (reason) {
        return new EvmRevertError(reason, err)
      }
    }
  }
  return err
}

/**
 * Maps positional event filter arguments onto the names of the event's
 * indexed inputs, as required by viem's event filtering. Filter values must
 * be 0x-prefixed hex strings, addresses, or `bigint` values (callers pass
 * `Hex.toPrefixedString()` output or addresses).
 * @param abi Contract ABI containing the event.
 * @param eventName Name of the event.
 * @param filterArgs Positional filter arguments; `undefined`/`null` entries
 *        are skipped (match-any).
 * @returns Named filter args record or undefined when no filters are set.
 * @throws If the event is not found in the ABI, more filter arguments are
 *         passed than the event has indexed inputs, or a filtered indexed
 *         input has no name in the ABI.
 */
export function positionalToNamedEventArgs(
  abi: Abi,
  eventName: string,
  filterArgs: readonly unknown[]
): Record<string, unknown> | undefined {
  if (filterArgs.length === 0) {
    return undefined
  }

  const event = abi.find(
    (item): item is AbiEvent => item.type === "event" && item.name === eventName
  )
  if (!event) {
    throw new Error(`Event ${eventName} not found in the contract ABI`)
  }

  const indexedInputs = event.inputs.filter((input) => input.indexed)
  if (filterArgs.length > indexedInputs.length) {
    throw new Error(
      `Event ${eventName} has ${indexedInputs.length} indexed inputs ` +
        `but ${filterArgs.length} filter arguments were passed`
    )
  }

  const named: Record<string, unknown> = {}
  filterArgs.forEach((arg, index) => {
    if (arg === undefined || arg === null) {
      return
    }
    const input = indexedInputs[index]
    if (!input.name) {
      throw new Error(
        `Indexed input at position ${index} of event ${eventName} is ` +
          `unnamed; cannot map positional filter arguments`
      )
    }
    named[input.name] = arg
  })

  return Object.keys(named).length > 0 ? named : undefined
}

/**
 * Raw decoded log shape returned by viem's `getContractEvents`.
 */
type ContractEventLog = {
  blockNumber: bigint
  blockHash: `0x${string}`
  transactionHash: `0x${string}`
  args?: Record<string, unknown>
}

/**
 * Port of the ethers-era batched events fallback loop. Pulls events in
 * chunks of {@link batchedQueryBlockInterval} blocks when the single
 * `eth_getLogs` pull failed (e.g. provider-side block range limits).
 * @param publicClient viem public client to pull events with.
 * @param address Contract address.
 * @param abi Contract ABI.
 * @param eventName Name of the event.
 * @param args Named indexed filter args.
 * @param fromBlock Starting block for events search.
 * @param toBlock Ending block for events search.
 * @param batchedQueryBlockInterval Block interval for batched events pulls.
 * @param logger A logger function to pass execution messages.
 * @returns Array of raw decoded logs.
 */
async function batchedGetEvents(
  publicClient: PublicClient,
  address: Address,
  abi: Abi,
  eventName: string,
  args: Record<string, unknown> | undefined,
  fromBlock: bigint,
  toBlock: bigint | "latest",
  batchedQueryBlockInterval: number,
  logger: ExecutionLoggerFn
): Promise<ContractEventLog[]> {
  const resolvedToBlock: bigint =
    typeof toBlock === "string" ? await publicClient.getBlockNumber() : toBlock

  const interval = BigInt(batchedQueryBlockInterval)

  let resultEvents: ContractEventLog[] = []
  let batchStartBlock = fromBlock

  while (batchStartBlock <= resolvedToBlock) {
    let batchEndBlock = batchStartBlock + interval
    if (batchEndBlock > resolvedToBlock) {
      batchEndBlock = resolvedToBlock
    }
    logger(
      `executing partial events pull from contract: [${address}], ` +
        `fromBlock: [${batchStartBlock}], toBlock: [${batchEndBlock}]`
    )
    const foundEvents = (await publicClient.getContractEvents({
      address,
      abi,
      eventName,
      args,
      fromBlock: batchStartBlock,
      toBlock: batchEndBlock,
      strict: false,
    } as never)) as unknown as ContractEventLog[]

    resultEvents = resultEvents.concat(foundEvents)
    logger(
      `fetched [${foundEvents.length}] events, has ` +
        `[${resultEvents.length}] total`
    )

    batchStartBlock = batchEndBlock + 1n
  }

  return resultEvents
}

/**
 * Memoized async normalization of the connection a contract handle was
 * configured with. Keeps handle constructors synchronous while `connectEvm`
 * normalization (chain ID probing, account resolution) happens once, on
 * first use.
 */
class ConnectionRef {
  private _connection?: Promise<EvmConnection>

  constructor(private readonly _source: EthereumSigner | EvmConnection) {}

  /**
   * @returns The normalized connection, memoized after the first call.
   */
  get(): Promise<EvmConnection> {
    if (!this._connection) {
      const connection = ConnectionRef.isEvmConnection(this._source)
        ? Promise.resolve(this._source)
        : connectEvm(this._source)
      this._connection = connection
      // Do not memoize failed normalizations - a transient RPC error must
      // not poison subsequent retry attempts.
      connection.catch(() => {
        if (this._connection === connection) {
          this._connection = undefined
        }
      })
    }
    return this._connection
  }

  /**
   * Detects an already-normalized connection passed by a contract loader.
   * @param source The configured signer/provider/connection.
   * @returns True when the source is an {@link EvmConnection}.
   */
  private static isEvmConnection(
    source: EthereumSigner | EvmConnection
  ): source is EvmConnection {
    return (
      typeof source === "object" &&
      source !== null &&
      "public" in source &&
      "chainId" in source
    )
  }
}

/**
 * viem-based contract handle. Replaces the ethers-based
 * `EthersContractHandle`.
 */
export class EvmContractHandle {
  /**
   * Address of the contract instance.
   */
  protected readonly _address: Address
  /**
   * ABI of the contract instance.
   */
  protected readonly _abi: Abi
  /**
   * Number of a block within which the contract was deployed. Value is read
   * from the contract deployment artifact. It can be overwritten by setting
   * a {@link EthereumContractConfig.deployedAtBlockNumber} property.
   */
  protected readonly _deployedAtBlockNumber: number
  /**
   * Number of retries for ethereum requests.
   */
  protected readonly _totalRetryAttempts: number
  /**
   * Memoized normalized connection.
   */
  private readonly _connRef: ConnectionRef

  /**
   * @param config Configuration for contract instance initialization.
   * @param deployment Contract Deployment artifact.
   * @param totalRetryAttempts Number of retries for ethereum requests.
   */
  constructor(
    config: EthereumContractConfig,
    deployment: EvmContractDeployment,
    totalRetryAttempts = 3
  ) {
    this._address = getAddress(config.address ?? deployment.address)
    this._abi = deployment.abi
    this._deployedAtBlockNumber =
      config.deployedAtBlockNumber ?? deployment.receipt.blockNumber
    this._totalRetryAttempts = totalRetryAttempts
    this._connRef = new ConnectionRef(config.signerOrProvider)
  }

  /**
   * Get address of the contract instance.
   * @returns Address of this contract instance.
   */
  getAddress(): EthereumAddress {
    return EthereumAddress.from(this._address)
  }

  /**
   * @returns The normalized connection this handle operates on.
   */
  protected async _connection(): Promise<EvmConnection> {
    return this._connRef.get()
  }

  /**
   * Calls a read-only contract function with retries.
   * @param functionName Name of the contract function.
   * @param args Positional arguments of the function.
   * @param opts Optional block number to read at and retries override.
   * @returns Decoded function result. Numeric values arrive as `bigint` for
   *          types wider than 48 bits and `number` otherwise - normalize
   *          with `BigInt(x)` / `Number(x)` at the parsing site.
   */
  protected async _read<T>(
    functionName: string,
    args?: readonly unknown[],
    opts?: {
      blockNumber?: number
      retries?: number
      nonRetryableErrors?: Array<string | RegExp>
    }
  ): Promise<T> {
    return backoffRetrier<T>(
      opts?.retries ?? this._totalRetryAttempts,
      undefined,
      undefined,
      opts?.nonRetryableErrors
        ? skipRetryWhenMatched(opts.nonRetryableErrors)
        : undefined
    )(async () => {
      const { public: publicClient } = await this._connRef.get()
      try {
        return (await publicClient.readContract({
          address: this._address,
          abi: this._abi,
          functionName,
          args: args ?? [],
          blockNumber:
            opts?.blockNumber !== undefined
              ? BigInt(opts.blockNumber)
              : undefined,
        } as never)) as T
      } catch (e: unknown) {
        throw normalizeEvmError(e)
      }
    })
  }

  /**
   * Sends a contract write transaction with retries. The transaction is
   * simulated first (`eth_call`) so that reverts surface with a parseable
   * reason before anything is sent - mirroring the ethers v5 gas-estimation
   * pre-flight.
   * @param functionName Name of the contract function.
   * @param args Positional arguments of the function.
   * @param opts Optional value to send, non-retryable error matchers and
   *        logger.
   * @returns Transaction hash.
   * @throws "Signer not provided" when the handle operates in read-only
   *         mode; {@link EvmRevertError} on contract revert.
   */
  protected async _write(
    functionName: string,
    args: readonly unknown[],
    opts?: {
      value?: bigint
      nonRetryableErrors?: Array<string | RegExp>
      logger?: ExecutionLoggerFn
    }
  ): Promise<Hex> {
    const connection = await this._connRef.get()
    const { wallet, account } = connection
    if (!wallet || !account) {
      throw new Error("Signer not provided")
    }

    return backoffRetrier<Hex>(
      this._totalRetryAttempts,
      1000,
      opts?.logger,
      opts?.nonRetryableErrors
        ? skipRetryWhenMatched(opts.nonRetryableErrors)
        : undefined
    )(async () => {
      try {
        const { request } = await connection.public.simulateContract({
          address: this._address,
          abi: this._abi,
          functionName,
          args,
          account: wallet.account ?? account,
          value: opts?.value,
        } as never)
        const hash = await wallet.writeContract({
          ...(request as Record<string, unknown>),
          chain: wallet.chain ?? null,
        } as never)
        return Hex.from(hash)
      } catch (e: unknown) {
        throw normalizeEvmError(e)
      }
    })
  }

  /**
   * Get events emitted by the Ethereum contract.
   * It starts searching from provided block number. If the
   * {@link GetChainEvents.Options#fromBlock} option is missing it looks for
   * a contract's defined property {@link _deployedAtBlockNumber}.
   * It pulls events in one `eth_getLogs` call. If the call fails it
   * fallbacks to querying events in batches of
   * {@link GetChainEvents.Options#batchedQueryBlockInterval} blocks.
   * @param eventName Name of the event.
   * @param options Options for events fetching.
   * @param filterArgs Positional arguments for events filtering, mapped onto
   *        the event's indexed inputs. Values must be 0x-prefixed hex
   *        strings, addresses, or `bigint`.
   * @returns Array of found events.
   */
  protected async _getEvents(
    eventName: string,
    options?: GetChainEvents.Options,
    ...filterArgs: Array<unknown>
  ): Promise<EvmEvent[]> {
    return backoffRetrier<EvmEvent[]>(
      options?.retries ?? this._totalRetryAttempts
    )(async () => {
      const { public: publicClient } = await this._connRef.get()
      const args = positionalToNamedEventArgs(this._abi, eventName, filterArgs)
      const fromBlock = BigInt(
        options?.fromBlock ?? this._deployedAtBlockNumber
      )
      const toBlock: bigint | "latest" =
        options?.toBlock !== undefined ? BigInt(options.toBlock) : "latest"
      const logger = options?.logger ?? console.debug

      let logs: ContractEventLog[]
      try {
        logs = (await publicClient.getContractEvents({
          address: this._address,
          abi: this._abi,
          eventName,
          args,
          fromBlock,
          toBlock,
          strict: false,
        } as never)) as unknown as ContractEventLog[]
      } catch (err) {
        logger(
          `switching to partial events pulls; ` +
            `failed to get events in one request from contract: ` +
            `[${this._address}], ` +
            `fromBlock: [${fromBlock}], toBlock: [${toBlock}]: [${err}]`
        )
        logs = await batchedGetEvents(
          publicClient,
          this._address,
          this._abi,
          eventName,
          args,
          fromBlock,
          toBlock,
          options?.batchedQueryBlockInterval ?? GET_EVENTS_BLOCK_INTERVAL,
          logger
        )
      }

      return logs.map((log) => ({
        blockNumber: Number(log.blockNumber),
        blockHash: log.blockHash,
        transactionHash: log.transactionHash,
        args: (log.args ?? {}) as Record<string, unknown>,
      }))
    })
  }
}
