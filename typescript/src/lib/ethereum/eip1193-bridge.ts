import type {
  Eip1193Provider,
  EthersV5ProviderLike,
  EthersV5SignerLike,
} from "./evm-connection"

/**
 * Hexifies a JSON-RPC quantity value coming from an ethers v5 result:
 * `number`, `bigint` and ethers `BigNumber`-like objects (duck-typed via
 * `toHexString`) are converted to 0x-prefixed hex strings; 0x-strings pass
 * through untouched.
 * @param value The value to hexify.
 * @returns 0x-prefixed hex quantity string.
 */
function toHexQuantity(value: unknown): string {
  if (typeof value === "string" && value.startsWith("0x")) {
    return value
  }
  if (typeof value === "number") {
    return `0x${value.toString(16)}`
  }
  if (typeof value === "bigint") {
    return `0x${value.toString(16)}`
  }
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { toHexString?: unknown }).toHexString === "function"
  ) {
    return (value as { toHexString(): string }).toHexString()
  }
  throw new Error(`Cannot convert value to a hex quantity: ${value}`)
}

/**
 * Converts a JSON-RPC block parameter (hex quantity or block tag) to the
 * shape ethers v5 expects (number or tag string).
 * @param value JSON-RPC block parameter.
 * @param defaultValue Value used when the parameter is missing.
 * @returns ethers v5 block tag.
 */
function toEthersBlockTag(
  value: unknown,
  defaultValue: string | number = "latest"
): string | number {
  if (value === undefined || value === null) {
    return defaultValue
  }
  if (typeof value === "string" && value.startsWith("0x")) {
    return parseInt(value, 16)
  }
  return value as string | number
}

/**
 * Translates an ethers v5 log object to the raw JSON-RPC log shape
 * (hex-quantity `blockNumber`/`logIndex`/`transactionIndex`).
 * @param log ethers v5 log object.
 * @returns Raw JSON-RPC log object.
 */
function toRawLog(log: Record<string, unknown>): Record<string, unknown> {
  const raw: Record<string, unknown> = { ...log }
  for (const field of ["blockNumber", "logIndex", "transactionIndex"]) {
    if (log[field] !== undefined && log[field] !== null) {
      raw[field] = toHexQuantity(log[field])
    }
  }
  return raw
}

/**
 * Translates an ethers v5 transaction receipt to the raw JSON-RPC receipt
 * shape (hex quantities).
 * @param receipt ethers v5 transaction receipt.
 * @returns Raw JSON-RPC receipt object or null.
 */
function toRawReceipt(receipt: unknown): unknown {
  if (receipt === null || receipt === undefined) {
    return null
  }
  const source = receipt as Record<string, unknown>
  const raw: Record<string, unknown> = { ...source }
  for (const field of [
    "blockNumber",
    "transactionIndex",
    "status",
    "type",
    "gasUsed",
    "cumulativeGasUsed",
    "effectiveGasPrice",
  ]) {
    if (source[field] !== undefined && source[field] !== null) {
      raw[field] = toHexQuantity(source[field])
    }
  }
  if (Array.isArray(source.logs)) {
    raw.logs = source.logs.map((log) =>
      toRawLog(log as Record<string, unknown>)
    )
  }
  return raw
}

/**
 * Wraps an ethers v5 Signer or Provider (duck-typed - the SDK does not
 * depend on ethers) into a minimal EIP-1193 provider that viem transports
 * can consume.
 *
 * Behavior:
 * - Signer-owned methods (`eth_accounts`, `eth_chainId`,
 *   `eth_sendTransaction`) are answered by the signer itself (when the input
 *   is a signer).
 * - Fast path: providers exposing `.send(method, params)`
 *   (JsonRpcProvider/Web3Provider family) get raw RPC delegation for every
 *   other method.
 * - Slow path (no `.send`): only the methods the SDK actually issues are
 *   implemented by translating to the ethers v5 API and hexifying results.
 *   Any other method throws.
 * @param signerOrProvider ethers v5 Signer or Provider (duck-typed).
 * @returns EIP-1193 provider bridging to the ethers object.
 */
export function ethersToEip1193(
  signerOrProvider: EthersV5SignerLike | EthersV5ProviderLike
): Eip1193Provider {
  const signer =
    (signerOrProvider as EthersV5SignerLike)._isSigner === true
      ? (signerOrProvider as EthersV5SignerLike)
      : undefined

  const provider: EthersV5ProviderLike | undefined = signer
    ? signer.provider
    : (signerOrProvider as EthersV5ProviderLike)

  return {
    request: async (args: {
      method: string
      params?: unknown[] | object
    }): Promise<unknown> => {
      const { method } = args
      const params = Array.isArray(args.params) ? args.params : []

      // Signer-owned methods - answered by the signer, never delegated.
      if (signer) {
        switch (method) {
          case "eth_accounts":
            return [await signer.getAddress()]
          case "eth_chainId":
            return `0x${(await signer.getChainId()).toString(16)}`
          case "eth_sendTransaction": {
            const tx = (params[0] ?? {}) as Record<string, unknown>
            const ethersTx: Record<string, unknown> = {}
            if (tx.to !== undefined) ethersTx.to = tx.to
            if (tx.data !== undefined) ethersTx.data = tx.data
            // Hex-quantity strings pass through as-is - ethers v5
            // `BigNumberish` accepts 0x-strings. `gas` renames to `gasLimit`.
            if (tx.value !== undefined) ethersTx.value = tx.value
            if (tx.gas !== undefined) ethersTx.gasLimit = tx.gas
            if (tx.gasPrice !== undefined) ethersTx.gasPrice = tx.gasPrice
            if (tx.maxFeePerGas !== undefined)
              ethersTx.maxFeePerGas = tx.maxFeePerGas
            if (tx.maxPriorityFeePerGas !== undefined)
              ethersTx.maxPriorityFeePerGas = tx.maxPriorityFeePerGas
            if (tx.nonce !== undefined) ethersTx.nonce = tx.nonce
            if (tx.type !== undefined) ethersTx.type = tx.type
            if (tx.accessList !== undefined) ethersTx.accessList = tx.accessList
            // `from` is dropped - it is implied by the signer.
            const response = await signer.sendTransaction(ethersTx)
            return response.hash
          }
        }
      }

      // Fast path: raw RPC delegation to JsonRpcProvider-family providers.
      if (provider && typeof provider.send === "function") {
        return provider.send(method, params)
      }

      // Slow path: translate the methods the SDK actually issues.
      switch (method) {
        case "eth_chainId": {
          if (!provider) break
          const network = await provider.getNetwork()
          return `0x${network.chainId.toString(16)}`
        }
        case "eth_call": {
          const tx = params[0] as { to?: string; data?: string }
          const blockTag = toEthersBlockTag(params[1])
          if (provider) {
            return provider.call(tx, blockTag)
          }
          if (signer) {
            return signer.call(tx, blockTag)
          }
          break
        }
        case "eth_getLogs": {
          if (!provider) break
          const filter = (params[0] ?? {}) as Record<string, unknown>
          const ethersFilter: Record<string, unknown> = {}
          if (filter.address !== undefined)
            ethersFilter.address = filter.address
          if (filter.topics !== undefined) ethersFilter.topics = filter.topics
          if (filter.fromBlock !== undefined) {
            ethersFilter.fromBlock = toEthersBlockTag(filter.fromBlock)
          }
          if (filter.toBlock !== undefined) {
            ethersFilter.toBlock = toEthersBlockTag(filter.toBlock)
          }
          const logs = await provider.getLogs(ethersFilter)
          return logs.map((log) => toRawLog(log as Record<string, unknown>))
        }
        case "eth_blockNumber": {
          if (!provider) break
          return toHexQuantity(await provider.getBlockNumber())
        }
        case "eth_getBlockByNumber": {
          if (!provider) break
          const block = await provider.getBlock(toEthersBlockTag(params[0]))
          if (!block) {
            return null
          }
          return {
            number: toHexQuantity(block.number),
            hash: block.hash,
            timestamp: toHexQuantity(block.timestamp),
          }
        }
        case "eth_getTransactionReceipt": {
          if (!provider) break
          return toRawReceipt(
            await provider.getTransactionReceipt(params[0] as string)
          )
        }
      }

      throw new Error(
        `Method ${method} not supported by the ethers v5 compatibility bridge`
      )
    },
  }
}
