import {
  createPublicClient,
  createWalletClient,
  custom,
  getAddress,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem"
import { EthereumAddress } from "./address"
import { ethersToEip1193 } from "./eip1193-bridge"

/**
 * Minimal EIP-1193 provider (window.ethereum, WalletConnect, ethers v6
 * BrowserProvider's underlying provider, any viem transport source).
 */
export interface Eip1193Provider {
  request(args: {
    method: string
    params?: unknown[] | object
  }): Promise<unknown>
}

/**
 * Structural (duck-typed) ethers v5 Signer. ethers v5 brands every Signer with
 * `_isSigner`. The SDK does not depend on ethers — this type exists so that
 * ethers v5 users can keep passing their signers without a cast.
 * @deprecated The ethers v5 compatibility shim is deprecated at birth and will
 *             be removed in the next major version. Pass a viem client or a
 *             raw EIP-1193 provider instead.
 */
export interface EthersV5SignerLike {
  readonly _isSigner: boolean
  getAddress(): Promise<string>
  getChainId(): Promise<number>
  // The transaction fields are typed `unknown` (ethers v5 accepts deferrable
  // values, i.e. direct values or promises, for every field) so that the
  // nominal ethers v5 `Signer`/`Wallet` types are structurally assignable
  // to this shape without a cast. At runtime the SDK always passes plain
  // `to`/`data`/`value`/`gasLimit` hex strings.
  sendTransaction(tx: {
    to?: unknown
    data?: unknown
    value?: unknown
    gasLimit?: unknown
  }): Promise<{ hash: string }>
  call(tx: { to?: string; data?: string }, blockTag?: unknown): Promise<string>
  provider?: EthersV5ProviderLike
}

/**
 * Structural (duck-typed) ethers v5 Provider. ethers v5 brands every Provider
 * with `_isProvider`. The SDK does not depend on ethers — this type exists so
 * that ethers v5 users can keep passing their providers without a cast.
 * @deprecated The ethers v5 compatibility shim is deprecated at birth and will
 *             be removed in the next major version. Pass a viem client or a
 *             raw EIP-1193 provider instead.
 */
export interface EthersV5ProviderLike {
  readonly _isProvider: boolean
  getNetwork(): Promise<{ chainId: number }>
  call(tx: { to?: string; data?: string }, blockTag?: unknown): Promise<string>
  getLogs(filter: unknown): Promise<unknown[]>
  getBlockNumber(): Promise<number>
  getBlock(
    blockTag: unknown
  ): Promise<{ number: number; hash: string; timestamp: number } | null>
  getTransactionReceipt(hash: string): Promise<unknown>
  /**
   * Present on JsonRpcProvider/Web3Provider — when available raw RPC requests
   * are delegated to it.
   */
  send?(method: string, params: unknown[]): Promise<unknown>
}

/**
 * Represents an Ethereum "signer": anything the SDK can turn into read (and
 * optionally write) access to an EVM chain.
 */
export type EthereumSigner =
  | WalletClient // viem, write + read
  | PublicClient // viem, read-only
  | Eip1193Provider // raw EIP-1193, write if it exposes accounts
  | EthersV5SignerLike // ethers v5 Signer (compat shim, no ethers import)
  | EthersV5ProviderLike // ethers v5 Provider (compat shim, read-only)

/**
 * SDK-internal normalized connection. Never exposed in public method
 * signatures.
 */
export interface EvmConnection {
  /**
   * Read access to the chain.
   */
  public: PublicClient
  /**
   * Write access to the chain. Undefined in read-only mode.
   */
  wallet?: WalletClient
  /**
   * Resolved signer address; undefined in read-only mode.
   */
  account?: Address
  /**
   * Decimal string, comparable against Chains.Ethereum/Base/Arbitrum enum
   * values.
   */
  chainId: string
}

/**
 * Transport options for SDK-constructed viem clients. Transport-level
 * retries are disabled because retrying is owned by the SDK's
 * `backoffRetrier` (parity with the ethers-era behavior, where the RPC
 * layer performed no retries of its own).
 */
const transportOptions = { retryCount: 0 } as const

/**
 * Normalizes any accepted signer shape into viem clients using its current
 * account and chain. Contract loaders share this snapshot within one SDK
 * initialization; a later initialization resolves provider state again.
 * @param signer The signer/provider/client to normalize.
 * @returns Normalized SDK-internal connection.
 * @throws If the passed object is not a supported signer/provider shape.
 */
export async function connectEvm(
  signer: EthereumSigner
): Promise<EvmConnection> {
  if (typeof signer !== "object" || signer === null) {
    throw new Error("Unsupported Ethereum signer/provider")
  }

  return doConnectEvm(signer)
}

/**
 * Performs the actual signer normalization. Detection order (first match
 * wins):
 * 1. viem client (walletClient/publicClient),
 * 2. ethers v5 Signer (via the EIP-1193 bridge),
 * 3. ethers v5 Provider (via the EIP-1193 bridge, read-only),
 * 4. raw EIP-1193 provider,
 * 5. anything else throws.
 * @param signer The signer/provider/client to normalize.
 * @returns Normalized SDK-internal connection.
 */
async function doConnectEvm(signer: EthereumSigner): Promise<EvmConnection> {
  const candidate = signer as Record<string, unknown>
  const address = await ethereumAddressFromSigner(signer)
  const account = address ? getAddress(`0x${address.identifierHex}`) : undefined

  // Case 1: viem client. viem sets `type: "walletClient"` / `"publicClient"`
  // on clients created by `createWalletClient` / `createPublicClient`.
  if (
    typeof candidate.request === "function" &&
    typeof candidate.type === "string"
  ) {
    if (candidate.type === "walletClient") {
      const wallet = signer as WalletClient
      // Reuse the wallet client's transport pipe for reads.
      const publicClient = createPublicClient({
        transport: custom(
          {
            request: (args: { method: string; params?: unknown[] | object }) =>
              wallet.request(args as never),
          },
          transportOptions
        ),
      })
      return {
        public: publicClient,
        wallet,
        account,
        chainId: String(await publicClient.getChainId()),
      }
    }

    if (candidate.type === "publicClient") {
      const publicClient = signer as PublicClient
      return {
        public: publicClient,
        chainId: String(await publicClient.getChainId()),
      }
    }
    // Other viem client types (e.g. test clients) fall through to the raw
    // EIP-1193 path below - they still expose `request`.
  }

  // Case 2: ethers v5 Signer.
  if (candidate._isSigner === true) {
    const ethersSigner = signer as EthersV5SignerLike
    const bridge = ethersToEip1193(ethersSigner)
    const publicClient = createPublicClient({
      transport: custom(bridge, transportOptions),
    })
    const wallet = createWalletClient({
      account,
      transport: custom(bridge, transportOptions),
    })
    return {
      public: publicClient,
      wallet,
      account,
      chainId: String(await publicClient.getChainId()),
    }
  }

  // Case 3: ethers v5 Provider (read-only).
  if (candidate._isProvider === true) {
    const bridge = ethersToEip1193(signer as EthersV5ProviderLike)
    const publicClient = createPublicClient({
      transport: custom(bridge, transportOptions),
    })
    return {
      public: publicClient,
      chainId: String(await publicClient.getChainId()),
    }
  }

  // Case 4: raw EIP-1193 provider.
  if (typeof candidate.request === "function") {
    const provider = signer as Eip1193Provider
    const publicClient = createPublicClient({
      transport: custom(provider, transportOptions),
    })

    if (account !== undefined) {
      const wallet = createWalletClient({
        account,
        transport: custom(provider, transportOptions),
      })
      return {
        public: publicClient,
        wallet,
        account,
        chainId: String(await publicClient.getChainId()),
      }
    }

    return {
      public: publicClient,
      chainId: String(await publicClient.getChainId()),
    }
  }

  // Case 5: anything else.
  throw new Error("Unsupported Ethereum signer/provider")
}

/**
 * Resolves the chain ID from the given signer.
 * @param signer The signer whose chain ID should be resolved.
 * @returns Chain ID as a decimal string.
 */
export async function chainIdFromSigner(
  signer: EthereumSigner
): Promise<string> {
  return (await connectEvm(signer)).chainId
}

/**
 * Resolves the Ethereum address tied to the given signer without querying
 * its chain ID or initializing a connection. Locally available accounts
 * can be resolved offline. The address cannot be resolved for signers that
 * work in read-only mode.
 * @param signer The signer whose address should be resolved.
 * @returns Ethereum address or undefined for read-only signers.
 * @throws Throws an error if the address of the signer is not a proper
 *         Ethereum address or account discovery fails.
 */
export async function ethereumAddressFromSigner(
  signer: EthereumSigner
): Promise<EthereumAddress | undefined> {
  if (typeof signer !== "object" || signer === null) {
    throw new Error("Unsupported Ethereum signer/provider")
  }

  const candidate = signer as Record<string, unknown>
  if (typeof candidate.request === "function") {
    if (candidate.type === "walletClient") {
      const wallet = signer as WalletClient
      const account =
        wallet.account?.address ?? (await wallet.getAddresses())[0]
      return account !== undefined ? EthereumAddress.from(account) : undefined
    }
    if (candidate.type === "publicClient") {
      return undefined
    }
  }

  if (candidate._isSigner === true) {
    return EthereumAddress.from(
      await (signer as EthersV5SignerLike).getAddress()
    )
  }
  if (candidate._isProvider === true) {
    return undefined
  }

  if (typeof candidate.request === "function") {
    // Only eth_accounts may be needed to discover an account; never prompt
    // for authorization or require chain connectivity to resolve it.
    let accounts: unknown
    try {
      accounts = await (signer as Eip1193Provider).request({
        method: "eth_accounts",
      })
    } catch (error: unknown) {
      // Only explicit access denial or unsupported methods imply read-only
      // mode. Transport failures must reach connection initialization retries.
      const code = (error as { code?: unknown } | null)?.code
      if (
        typeof code === "number" &&
        [4001, 4100, 4200, -32601, -32004].includes(code)
      ) {
        return undefined
      }
      throw error
    }
    return Array.isArray(accounts) && accounts.length > 0
      ? EthereumAddress.from(accounts[0])
      : undefined
  }

  throw new Error("Unsupported Ethereum signer/provider")
}

/**
 * Determines whether a value is any shape the SDK's {@link EthereumSigner}
 * union accepts: a viem client, an ethers v5 Signer/Provider (structural
 * shim), or a raw EIP-1193 provider.
 * @param x The candidate value to check.
 * @returns True if `x` is a supported Ethereum signer/provider shape.
 */
export function isEvmSigner(x: unknown): boolean {
  if (typeof x !== "object" || x === null) {
    return false
  }

  const candidate = x as Record<string, unknown>

  if (
    typeof candidate.request === "function" &&
    typeof candidate.type === "string"
  ) {
    return true
  }

  if (candidate._isSigner === true || candidate._isProvider === true) {
    return true
  }

  return typeof candidate.request === "function"
}
