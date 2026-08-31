import {
  BitcoinDepositor,
  ChainIdentifier,
  ExtraDataEncoder,
} from "../contracts"
import { BitcoinHashUtils, BitcoinRawTxVectors } from "../bitcoin"
import { DepositReceipt } from "../contracts/bridge"
import { StarkNetAddress } from "./address"
import { StarkNetExtraDataEncoder } from "./extra-data-encoder"
import { StarkNetProvider } from "./types"
import { Hex } from "../utils"
import { packRevealDepositParameters } from "../ethereum"
import axios from "axios"
import { ethers } from "ethers"
import { TransactionReceipt } from "@ethersproject/providers"

/**
 * Relayer request payload for revealing a deposit
 */
interface RelayerRevealRequest {
  fundingTx: {
    version: string
    inputVector: string
    outputVector: string
    locktime: string
  }
  reveal: {
    fundingOutputIndex: number
    blindingFactor: string
    walletPubKeyHash: string
    refundPubKeyHash: string
    refundLocktime: string
    vault: string
  }
  l2DepositOwner: string
  l2Sender: string
}

/**
 * Relayer response for reveal deposit endpoint
 */
interface RelayerRevealResponse {
  success: boolean
  depositId?: string
  message?: string
  receipt?: {
    transactionHash: string
    blockNumber?: number
    status?: number
  }
  error?: string
  details?: any
}

/**
 * Status of a deposit as reported by the relayer's deposit-status endpoint.
 *
 * These are the three on-chain states the Starknet deposit-status endpoint can
 * return. QUEUED=0 is the on-chain Unknown slot (the contract's deposits mapping
 * stores 0 for not-initialized). The endpoint derives its value from the L1
 * depositor contract's `deposits` mapping (`Unknown`/`Initialized`/`Finalized`),
 * which has exactly these three states. This enum intentionally does NOT mirror
 * every value of the relayer's internal cross-chain lifecycle enum (which
 * additionally has `AWAITING_WORMHOLE_VAA` and `BRIDGED`): those internal
 * lifecycle values are never surfaced by the status endpoint, so trusting them
 * here would widen the accepted input beyond what the endpoint can actually
 * report and weaken the fail-closed validation in
 * {@link StarkNetBitcoinDepositor.handleDepositConflict}.
 */
export enum StarkNetRelayerDepositStatus {
  // eslint-disable-next-line no-unused-vars
  QUEUED = 0,
  // eslint-disable-next-line no-unused-vars
  INITIALIZED = 1,
  // eslint-disable-next-line no-unused-vars
  FINALIZED = 2,
}

/**
 * Determines whether a numeric relayer status value is one of the recognized
 * on-chain {@link StarkNetRelayerDepositStatus} values (QUEUED, INITIALIZED, or
 * FINALIZED). Unlike a reverse-enum lookup, this explicit guard will not
 * silently start trusting a value if the enum is ever extended with states the
 * status endpoint does not actually report.
 * @param value The candidate status value reported by the relayer.
 * @returns True only for QUEUED, INITIALIZED, or FINALIZED.
 */
function isKnownRelayerDepositStatus(
  value: unknown
): value is StarkNetRelayerDepositStatus {
  return (
    value === StarkNetRelayerDepositStatus.QUEUED ||
    value === StarkNetRelayerDepositStatus.INITIALIZED ||
    value === StarkNetRelayerDepositStatus.FINALIZED
  )
}

/**
 * Relayer response for the deposit-status endpoint.
 */
interface RelayerDepositStatusResponse {
  success: boolean
  depositId?: string
  status?: StarkNetRelayerDepositStatus
  message?: string
  error?: string
  receipt?: {
    transactionHash: string
    blockNumber?: number
    status?: number
  }
}
/**
 * Thrown when the relayer reports that a deposit reveal already exists
 * but its status/deposit-ID does not align with the local derivation.
 * Preserves whatever deposit ID and verified status could be recovered from
 * the relayer so the caller can poll the relayer or otherwise recover.
 *
 * @property {string|undefined} depositId The deposit ID reported by the relayer,
 * or undefined if the relayer's reported ID was non-canonical or missing.
 * @property {string|undefined} locallyDerivedDepositId The deposit ID
 * independently derived by the SDK from the funding transaction, if available.
 * @property {boolean} statusVerified Whether the relayer's reported status is
 * trustable. False if no status endpoint was configured, the deposit ID was
 * non-canonical, the query failed, the relayer's success response was false, the
 * relayer's echoed ID did not match the locally derived one, or the relayer
 * reported an unrecognized status.
 */
export class StarkNetRelayerDepositConflictError extends Error {
  constructor(
    message: string,
    public readonly depositId: string | undefined,
    public readonly locallyDerivedDepositId: string | undefined,
    public readonly status: StarkNetRelayerDepositStatus | undefined,
    public readonly statusVerified: boolean
  ) {
    super(message)
    this.name = "StarkNetRelayerDepositConflictError"
  }
}

/**
 * Configuration for StarkNetBitcoinDepositor
 */
export interface StarkNetBitcoinDepositorConfig {
  chainId: string
  relayerUrl?: string
  /**
   * Base path for the relayer's deposit-status endpoint. Must be a path
   * prefix (e.g. "https://relayer.example/api/Chain/deposit") - the SDK
   * appends "/<depositId>" to it. Trailing slashes are stripped
   * automatically; do not supply a templated URL containing "{depositId}"
   * or similar placeholders.
   */
  relayerStatusUrl?: string
  defaultVault?: string
}

/**
 * @deprecated Use StarkNetBitcoinDepositorConfig instead
 */
export type StarkNetDepositorConfig = StarkNetBitcoinDepositorConfig

/**
 * Maps StarkNet chain IDs to the chain name segment used in relayer URLs
 * (PascalCase, matching the relayer's route naming). Only these explicitly
 * listed chain IDs have a default relayer route; recognition must go through
 * {@link hasDefaultStarkNetRelayerRoute} rather than a bare `[chainId]` lookup
 * (see that helper).
 */
const STARKNET_RELAYER_CHAIN_NAMES: Record<string, string> = {
  "0x534e5f474f45524c49": "StarknetTestnet", // SN_GOERLI
  "0x534e5f5345504f4c4941": "StarknetTestnet", // SN_SEPOLIA - mapped to StarknetTestnet in relayer
  "0x534e5f4d41494e": "StarknetMainnet", // SN_MAIN
  "0x534e5f544553544e4554": "StarknetTestnet", // SN_TESTNET - also declared supported in ./index.ts's TBTC_CONTRACT_ADDRESSES
}

/**
 * Determines whether a StarkNet chain ID has a built-in default relayer route.
 *
 * This is the single authoritative recognition check reused by both
 * {@link resolveStarkNetRelayerChainName} and the constructor's both-endpoint
 * rule. It uses an own-property check on purpose: a bare
 * `STARKNET_RELAYER_CHAIN_NAMES[chainId]` lookup would also resolve names
 * inherited from `Object.prototype` (e.g. "toString", "constructor",
 * "valueOf", "__proto__") to truthy members, making those non-chain strings
 * appear to have a default route. Such a value would then be interpolated into
 * a malformed relayer URL instead of failing loudly, so only the chain IDs
 * explicitly listed in {@link STARKNET_RELAYER_CHAIN_NAMES} may be recognized.
 * @param chainId The StarkNet chain ID.
 * @returns True only when chainId is one of the explicitly mapped chain IDs.
 */
function hasDefaultStarkNetRelayerRoute(chainId: string): boolean {
  return Object.prototype.hasOwnProperty.call(
    STARKNET_RELAYER_CHAIN_NAMES,
    chainId
  )
}

/**
 * Resolves the relayer URL chain-name segment for a recognized StarkNet chain
 * ID. Only the chain IDs in {@link STARKNET_RELAYER_CHAIN_NAMES} (SN_MAIN,
 * SN_SEPOLIA, SN_GOERLI, SN_TESTNET) have a default relayer route. An unknown or
 * mistyped chain ID has no default route and must fail loudly instead of being
 * silently coerced to a testnet segment, which could misroute a reveal after
 * Bitcoin funding.
 * @param chainId The StarkNet chain ID.
 * @returns The PascalCase chain-name segment used in relayer URLs.
 * @throws Error if the chain ID has no recognized default relayer route.
 */
function resolveStarkNetRelayerChainName(chainId: string): string {
  if (!hasDefaultStarkNetRelayerRoute(chainId)) {
    throw new Error(
      `No default StarkNet relayer route for chain ID: ${chainId}. ` +
        "Supply explicit relayerUrl and relayerStatusUrl values to use a " +
        "custom or unsupported StarkNet network."
    )
  }
  return STARKNET_RELAYER_CHAIN_NAMES[chainId]
}

const LOCAL_RELAYER_URL_BASE = "http://localhost:3001"
const PRODUCTION_RELAYER_URL_BASE =
  "https://tbtc-crosschain-relayer-swmku.ondigitalocean.app"

/**
 * Determines whether code is currently running in a browser whose location
 * is localhost or 127.0.0.1.
 * @returns True only for a local-development browser origin. Always false
 *          when `window` is undefined (Node/SSR), so server-side execution
 *          deterministically resolves to the production relayer instead of
 *          depending on a real browser context.
 */
function isLocalhostBrowserOrigin(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.location !== "undefined" &&
    (window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1")
  )
}

/**
 * Resolves the default relayer reveal URL for a StarkNet chain when no
 * explicit relayerUrl override is configured. Mainnet always uses the
 * production relayer, even when running on localhost.
 * @param chainId The StarkNet chain ID.
 * @returns The relayer reveal URL for the given chain.
 * @throws Error if the chain ID has no recognized default relayer route.
 */
function getDefaultStarkNetRelayerUrl(chainId: string): string {
  const chainName = resolveStarkNetRelayerChainName(chainId)
  const baseUrl =
    isLocalhostBrowserOrigin() && chainId !== "0x534e5f4d41494e"
      ? LOCAL_RELAYER_URL_BASE
      : PRODUCTION_RELAYER_URL_BASE
  return `${baseUrl}/api/${chainName}/reveal`
}

/**
 * Resolves the default relayer deposit-status URL for a StarkNet chain when
 * no explicit relayerStatusUrl override is configured. Sibling of
 * {@link getDefaultStarkNetRelayerUrl}, sharing the same environment/chain
 * resolution so local vs. production and chain-name mapping never drift
 * between the two endpoints. Mainnet always uses the production relayer,
 * even when running on localhost.
 * @param chainId The StarkNet chain ID.
 * @returns The relayer deposit-status URL for the given chain.
 * @throws Error if the chain ID has no recognized default relayer route.
 */
function getDefaultStarkNetRelayerStatusUrl(chainId: string): string {
  const chainName = resolveStarkNetRelayerChainName(chainId)
  const baseUrl =
    isLocalhostBrowserOrigin() && chainId !== "0x534e5f4d41494e"
      ? LOCAL_RELAYER_URL_BASE
      : PRODUCTION_RELAYER_URL_BASE
  return `${baseUrl}/api/${chainName}/deposit`
}

/**
 * Canonical decimal deposit ID pattern: base-10 digits only, no sign, no
 * whitespace, and no leading zeros other than the literal "0". This is the
 * exact form produced by `ethers.BigNumber.from(...).toString()`, which is
 * how this file derives a deposit ID from the funding transaction (see
 * {@link deriveCanonicalDepositId}). Hex strings, signed values,
 * padded/whitespace strings, and arbitrary text never match.
 */
const CANONICAL_DEPOSIT_ID_PATTERN = /^(0|[1-9][0-9]*)$/

/**
 * Maximum canonical deposit ID value in decimal form. A deposit ID is derived
 * from a 32-byte Solidity hash converted to decimal (see
 * {@link deriveCanonicalDepositId}), so its legitimate range is
 * `0..2^256-1`. Any larger magnitude cannot be a genuine deposit ID and must
 * be rejected. `2^256-1` is exactly 78 decimal digits long.
 */
const MAX_CANONICAL_DEPOSIT_ID = ethers.constants.MaxUint256.toString()

/**
 * Determines whether a value is a canonical decimal deposit ID string within
 * the `0..2^256-1` range produced by the deposit-ID derivation.
 * @param value The candidate deposit ID reported by the relayer
 * @returns True only when the value is a well-formed canonical decimal
 *          deposit ID that does not exceed the uint256 maximum
 */
function isCanonicalDepositId(value: unknown): value is string {
  if (typeof value !== "string") {
    return false
  }

  // Discard anything longer than the max before running the regex or any
  // numeric comparison, so arbitrarily long attacker-controlled strings are
  // rejected cheaply and never parsed.
  if (value.length > MAX_CANONICAL_DEPOSIT_ID.length) {
    return false
  }

  if (!CANONICAL_DEPOSIT_ID_PATTERN.test(value)) {
    return false
  }

  // Only a same-length (78-digit) candidate can exceed the uint256 maximum.
  // Because the regex guarantees digits with no leading zeros, comparing two
  // equal-length decimal strings lexicographically is equivalent to a numeric
  // comparison, and avoids precision-losing Number conversion.
  if (
    value.length === MAX_CANONICAL_DEPOSIT_ID.length &&
    value > MAX_CANONICAL_DEPOSIT_ID
  ) {
    return false
  }

  return true
}

/**
 * Derives the canonical decimal deposit ID for a StarkNet reveal from the raw
 * Bitcoin funding transaction, matching the relayer's derivation.
 *
 * The funding transaction is first hashed with Bitcoin SHA-256d (double
 * SHA-256). That 32-byte digest - used directly in internal byte order, i.e.
 * NOT reversed into block-explorer txid byte order - and a `uint32` output
 * index are then packed and Keccak-hashed, matching the on-chain deposit-key
 * formula in `Deposit.sol` / {@link EthereumBridge.buildDepositKey}. This
 * helper intentionally does NOT call `EthereumBridge.buildDepositKey`
 * directly: that method's `BitcoinTxHash` input is stored in
 * display/txid byte order and unconditionally reversed back to internal
 * order before hashing, whereas this helper hashes the raw funding bytes
 * fresh and is already in internal order - the two are consistent, not
 * contradictory, despite one reversing and the other not. The result is
 * converted to the canonical decimal string form produced elsewhere in this
 * file.
 * @param depositTx The raw Bitcoin funding transaction vectors.
 * @param depositOutputIndex The funding output index, packed as a uint32.
 * @returns The canonical decimal deposit ID.
 */
function deriveCanonicalDepositId(
  depositTx: BitcoinRawTxVectors,
  depositOutputIndex: number
): string {
  // Concatenate the raw transaction vectors as bytes (unprefixed hex).
  const fundingTxComponents =
    depositTx.version.toString() +
    depositTx.inputs.toString() +
    depositTx.outputs.toString() +
    depositTx.locktime.toString()

  // Bitcoin double SHA-256 of the serialized funding transaction. The digest is
  // used directly as the bytes32 funding hash - it is NOT reversed into
  // block-explorer txid byte order, matching the relayer's derivation.
  const fundingTxHash = BitcoinHashUtils.computeHash256(
    Hex.from(fundingTxComponents)
  )

  // Pack the funding hash and the uint32 output index, Keccak-hash them, and
  // convert to the canonical decimal representation.
  const depositIdHash = ethers.utils.solidityKeccak256(
    ["bytes32", "uint32"],
    [fundingTxHash.toPrefixedString(), depositOutputIndex]
  )
  return ethers.BigNumber.from(depositIdHash).toString()
}

/**
 * Full implementation of the BitcoinDepositor interface for StarkNet.
 * This implementation uses a StarkNet provider for operations and supports
 * deposit initialization through the relayer endpoint.
 *
 * Unlike other destination chains, StarkNet deposits are primarily handled through L1
 * contracts, with this depositor serving as a provider-aware interface for
 * future L2 functionality and relayer integration.
 */
export class StarkNetBitcoinDepositor implements BitcoinDepositor {
  readonly #extraDataEncoder = new StarkNetExtraDataEncoder()
  readonly #config: StarkNetBitcoinDepositorConfig
  readonly #chainName: string
  readonly #provider: StarkNetProvider
  #depositOwner: ChainIdentifier | undefined

  /**
   * Creates a new StarkNetBitcoinDepositor instance.
   * @param config Configuration containing chainId and other chain-specific settings.
   * Note: If an unrecognized chain ID is provided, relayerUrl must be supplied.
   * @param chainName Name of the chain (should be "StarkNet")
   * @param provider StarkNet provider for blockchain interactions (Provider or Account)
   * @throws Error if provider is not provided or if chain-ID/relayerUrl requirements are unmet.
   */
  constructor(
    config: StarkNetBitcoinDepositorConfig,
    chainName: string,
    provider: StarkNetProvider
  ) {
    if (!provider) {
      throw new Error("Provider is required for StarkNet depositor")
    }

    // Set default relayer URLs based on chainId and environment if not
    // explicitly provided. Explicit config values always win.
    const enhancedConfig = { ...config }

    // A custom or unsupported StarkNet network - one whose chain ID has no
    // default relayer route - is supported only when the caller supplies the
    // reveal endpoint explicitly. If the reveal endpoint would otherwise have to
    // be synthesized from an unrecognized chain ID, fail loudly at construction
    // instead of silently misrouting a reveal after Bitcoin funding. A
    // recognized chain ID keeps its documented defaulting behavior below.
    // Empty strings are treated as absent, matching the defaulting checks below.
    const hasDefaultRelayerRoute = hasDefaultStarkNetRelayerRoute(
      config.chainId
    )
    if (!hasDefaultRelayerRoute && !enhancedConfig.relayerUrl) {
      // resolveStarkNetRelayerChainName throws for an unrecognized chain ID;
      // only its throw is needed here, not its return value. This throw
      // serves as defense-in-depth.
      resolveStarkNetRelayerChainName(config.chainId)
    }

    // Whether the SDK must synthesize the reveal endpoint. An unrecognized
    // chainId has no default relayer route, so the builder throws here rather
    // than silently misrouting a reveal after Bitcoin funding (see
    // resolveStarkNetRelayerChainName).
    const shouldDefaultRelayerUrl = !enhancedConfig.relayerUrl
    if (shouldDefaultRelayerUrl) {
      enhancedConfig.relayerUrl = getDefaultStarkNetRelayerUrl(config.chainId)
    }

    // Deposit-status endpoint, sibling of the reveal endpoint above. Used to
    // verify the real outcome of a deposit the relayer reports as a conflict
    // (HTTP 409) instead of trusting the conflict response alone.
    //
    // Only default it when the SDK also chose the reveal endpoint. Automatic
    // conflict-status verification is trustworthy only when the SDK controls
    // both endpoints; pairing a caller's custom reveal service with the SDK's
    // default status service (production, or the local dev relayer under
    // isLocalhostBrowserOrigin()) would cross a configured service boundary
    // and could attach misleading "verified" metadata to a conflict. A
    // caller using a custom reveal service must explicitly supply
    // relayerStatusUrl to opt back into status verification. An explicitly
    // supplied relayerStatusUrl is always preserved, including when the
    // reveal URL is defaulted.
    if (shouldDefaultRelayerUrl && !enhancedConfig.relayerStatusUrl) {
      enhancedConfig.relayerStatusUrl = getDefaultStarkNetRelayerStatusUrl(
        config.chainId
      )
    }

    this.#config = Object.freeze(enhancedConfig)
    this.#chainName = chainName
    this.#provider = provider
  }

  /**
   * Gets the chain name for this depositor.
   * @returns The chain name (e.g., "StarkNet")
   */
  getChainName(): string {
    return this.#chainName
  }

  /**
   * Gets the StarkNet provider used by this depositor.
   * @returns The StarkNet provider instance
   */
  getProvider(): StarkNetProvider {
    return this.#provider
  }

  /**
   * Gets the chain-specific identifier of this contract.
   * @throws Always throws since StarkNet deposits are handled via L1.
   */
  // eslint-disable-next-line valid-jsdoc
  getChainIdentifier(): ChainIdentifier {
    throw new Error(
      "StarkNet depositor has no chain identifier. " +
        "Deposits are handled via L1 StarkNet Bitcoin Depositor."
    )
  }

  /**
   * Gets the identifier that should be used as the owner of deposits.
   * @returns The StarkNet address set as deposit owner, or undefined if not set.
   */
  getDepositOwner(): ChainIdentifier | undefined {
    return this.#depositOwner
  }

  /**
   * Sets the identifier that should be used as the owner of deposits.
   * @param depositOwner Must be a StarkNetAddress instance or undefined/null to clear.
   * @throws Error if the deposit owner is not a StarkNetAddress and not undefined/null.
   */
  // eslint-disable-next-line valid-jsdoc
  setDepositOwner(depositOwner: ChainIdentifier | undefined): void {
    // Allow clearing the deposit owner
    if (depositOwner === undefined || depositOwner === null) {
      this.#depositOwner = undefined
      return
    }

    // Validate that the deposit owner is a StarkNet address
    if (!(depositOwner instanceof StarkNetAddress)) {
      throw new Error("Deposit owner must be a StarkNet address")
    }

    this.#depositOwner = depositOwner
  }

  /**
   * Returns the extra data encoder for StarkNet.
   * @returns The StarkNetExtraDataEncoder instance.
   */
  extraDataEncoder(): ExtraDataEncoder {
    return this.#extraDataEncoder
  }

  /**
   * Initializes a cross-chain deposit by calling the external relayer service.
   *
   * This method calls the external service to trigger the deposit transaction
   * via a relayer off-chain process. It resolves with the full transaction
   * receipt.
   *
   * If the relayer reports that the deposit already exists (HTTP 409), this
   * method attempts to verify the deposit's real status through the relayer's
   * deposit-status endpoint - only when relayerStatusUrl is configured, and
   * using the relayer's reported deposit ID when it is canonical, falling
   * back to the SDK's independently-derived ID when it is not - then always
   * throws a StarkNetRelayerDepositConflictError carrying the deposit ID and
   * any verified status so the caller can poll or otherwise recover. The
   * relayer's deposit-status endpoint cannot supply a real TransactionReceipt
   * (it has no `to`, `from`, `gasUsed`, `logs`, `blockHash`, etc.), so a
   * conflict never resolves to a fabricated success value, even when the
   * relayer confirms the deposit reached a terminal state.
   *
   * @param depositTx - The Bitcoin transaction data
   * @param depositOutputIndex - The output index of the deposit
   * @param deposit - The deposit receipt containing all deposit parameters
   * @param vault - Optional vault address
   * @returns The full transaction receipt from the relayer response
   * @throws Error if deposit owner not set or relayer returns unexpected response
   * @throws StarkNetRelayerDepositConflictError if the relayer reports the deposit
   *         already exists
   */
  // eslint-disable-next-line valid-jsdoc
  async initializeDeposit(
    depositTx: BitcoinRawTxVectors,
    depositOutputIndex: number,
    deposit: DepositReceipt,
    vault?: ChainIdentifier
  ): Promise<Hex | TransactionReceipt> {
    const { fundingTx, reveal } = packRevealDepositParameters(
      depositTx,
      depositOutputIndex,
      deposit,
      vault
    )

    const depositOwner = deposit.extraData
      ? this.#extraDataEncoder.decodeDepositOwner(deposit.extraData)
      : this.#depositOwner

    if (!depositOwner) {
      throw new Error(
        "L2 deposit owner must be set before initializing deposit"
      )
    }

    const l2SenderOwner = this.#depositOwner ?? depositOwner

    // Format addresses for relayer
    const formattedL2DepositOwner = this.formatStarkNetAddressAsBytes32(
      depositOwner.toString()
    )
    const formattedL2Sender = this.formatStarkNetAddressAsBytes32(
      l2SenderOwner.toString()
    )

    // Derive the canonical deposit ID once, up front, so it is available on
    // BOTH the success path (for logging) and the 409-conflict path (to
    // cross-check against whatever deposit ID the relayer reports in the
    // conflict body). Computed here rather than per-attempt since depositTx
    // and depositOutputIndex never change across retries.
    let locallyDerivedDepositId: string | undefined
    try {
      locallyDerivedDepositId = deriveCanonicalDepositId(
        depositTx,
        depositOutputIndex
      )
    } catch (e) {
      console.warn("Failed to calculate deposit ID:", e)
    }

    // Retry configuration
    const maxRetries = 3
    const delays = [3000, 6000, 12000] // Exponential backoff: 3s, 6s, 12s

    let lastError: any

    // Attempt the request with retries
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const requestPayload: RelayerRevealRequest = {
          fundingTx,
          reveal,
          l2DepositOwner: formattedL2DepositOwner,
          l2Sender: formattedL2Sender,
        }

        const response = await axios.post<RelayerRevealResponse>(
          this.#config.relayerUrl!,
          requestPayload,
          {
            timeout: 90000, // 90 seconds timeout
            headers: {
              "Content-Type": "application/json",
            },
          }
        )

        const { data } = response
        console.log("Relayer response:", {
          status: response.status,
          success: data.success,
          depositId: data.depositId,
          hasReceipt: !!data.receipt,
        })

        // locallyDerivedDepositId (see above) is derived the same way the
        // relayer derives it, so the two can be cross-checked; it is never
        // used as a substitute for the relayer's receipt.

        // Validate response. Require the literal boolean `true`: Axios does
        // not validate decoded JSON against the declared type, so a truthy
        // non-boolean value such as "false", "true", 1, {}, or [] must not be
        // treated as a successful initialization and cast to a receipt.
        if (data.success !== true) {
          throw new Error(
            data.error ||
              `Relayer returned unsuccessful response: ${
                data.message || "Unknown error"
              }`
          )
        }

        if (!data.receipt || !data.receipt.transactionHash) {
          throw new Error(
            `Invalid response from relayer: missing receipt or transactionHash. Response: ${JSON.stringify(
              data
            )}`
          )
        }
        // Mirror the success-path strictness used for `data.success`: a truthy
        // non-string or non-hex value (number, object, array, signed hex,
        // arbitrary text) must not be cast to a TransactionReceipt. The real
        // relayer always emits a 0x-prefixed hex hash of the expected length,
        // but the check here is shape-only - length is enforced upstream by
        // the bytes32 contract field.
        if (
          typeof data.receipt.transactionHash !== "string" ||
          !/^0x[0-9a-fA-F]+$/.test(data.receipt.transactionHash)
        ) {
          throw new Error(
            "Invalid response from relayer: receipt.transactionHash must be a 0x-prefixed hex string."
          )
        }

        // Log deposit ID if available
        if (locallyDerivedDepositId) {
          console.log(`Deposit initialized with ID: ${locallyDerivedDepositId}`)
        }
        return data.receipt as TransactionReceipt
      } catch (error: any) {
        lastError = error

        // A 409 means the relayer already has a record of this deposit.
        // That alone is not proof L1 initialization succeeded, so it can
        // never be converted into a fabricated Hex or TransactionReceipt.
        // Verify the deposit's real status before deciding how to respond.
        if (error.response?.status === 409) {
          return await this.handleDepositConflict(
            error,
            locallyDerivedDepositId
          )
        }

        // Check if error is retryable and we have retries left
        if (attempt < maxRetries && this.isRetryableError(error)) {
          console.log(
            `Retryable error on attempt ${attempt + 1}, retrying in ${
              delays[attempt]
            }ms:`,
            {
              status: error.response?.status,
              code: error.code,
              message: error.message,
            }
          )
          // Retry after exponential backoff delay
          await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
          continue
        }

        // If not retryable or no retries left, handle the error
        break
      }
    }

    // Format and throw the error
    const formattedError = this.formatRelayerError(lastError)
    throw new Error(formattedError)
  }

  /**
   * Handles a 409 Conflict response from the relayer, which means the
   * relayer already has a record of this deposit. That alone is not proof
   * that L1 initialization succeeded, and the relayer's deposit-status
   * endpoint cannot supply a real TransactionReceipt (it has no `to`,
   * `from`, `gasUsed`, `logs`, `blockHash`, etc.), so this method never
   * returns a value: it always throws a StarkNetRelayerDepositConflictError
   * carrying whatever deposit ID and verified status could be recovered
   * from the relayer, so the caller can poll or otherwise recover.
   * @param error The Axios error produced by the 409 response
   * @param locallyDerivedDepositId The deposit ID the SDK independently
   *        derived from the funding transaction, if available. Used to
   *        query the relayer's status endpoint when the relayer's reported
   *        ID is missing or non-canonical, and to detect a mismatch against
   *        a canonical relayer-reported ID - in which case an otherwise-
   *        verified status is downgraded to unverified, since the relayer
   *        only corroborated its own claim, not the SDK's independent
   *        derivation from the funding transaction.
   * @throws StarkNetRelayerDepositConflictError always; carries the deposit ID and
   *         verified status (if any) recovered from the relayer
   * @returns Promise that never resolves; always throws StarkNetRelayerDepositConflictError.
   */
  private async handleDepositConflict(
    error: unknown,
    locallyDerivedDepositId?: string
  ): Promise<never> {
    // Unchecked cast for Axios error response
    const errorResponse = error as {
      response?: { data?: { depositId?: string } }
    }
    const errorData = errorResponse.response?.data
    const rawDepositId = errorData?.depositId
    const depositIdFromRelayer: string | undefined = isCanonicalDepositId(
      rawDepositId
    )
      ? rawDepositId
      : undefined

    // F3: When rawDepositId is absent/non-canonical AND locallyDerivedDepositId is available, query status using locallyDerivedDepositId instead
    const depositIdToQuery = depositIdFromRelayer || locallyDerivedDepositId

    let status: StarkNetRelayerDepositStatus | undefined
    let statusVerified = false

    if (depositIdToQuery) {
      try {
        const statusResponse = await this.queryRelayerDepositStatus(
          depositIdToQuery
        )
        if (
          statusResponse &&
          // The status response must confirm the same canonical deposit ID
          // that was queried - a mismatched ID means the response cannot be
          // trusted to describe this conflict.
          statusResponse.depositId === depositIdToQuery &&
          // Accept only the recognized on-chain status values the endpoint can
          // actually report (see StarkNetRelayerDepositStatus).
          isKnownRelayerDepositStatus(statusResponse.status)
        ) {
          status = statusResponse.status
          statusVerified = true

          // F3: When relayer's echoed ID does not match locallyDerivedDepositId (mismatch case), DOWNGRADE statusVerified to false
          if (
            locallyDerivedDepositId !== undefined &&
            depositIdFromRelayer !== undefined &&
            depositIdFromRelayer !== locallyDerivedDepositId
          ) {
            statusVerified = false
          }
        }
      } catch (statusError) {
        console.warn(
          "Failed to verify deposit status with the relayer:",
          statusError
        )
      }
    }

    throw new StarkNetRelayerDepositConflictError(
      this.formatConflictMessage(depositIdFromRelayer, status, statusVerified),
      depositIdFromRelayer,
      locallyDerivedDepositId,
      status,
      statusVerified
    )
  }

  /**
   * Queries the relayer's deposit-status endpoint for the current status of
   * a previously-revealed deposit.
   * @param depositId Canonical decimal deposit ID as reported by the relayer
   * @returns The parsed status response, or undefined if the relayer did
   *          not confirm a recognized status for the deposit
   */
  private async queryRelayerDepositStatus(
    depositId: string
  ): Promise<RelayerDepositStatusResponse | undefined> {
    if (!this.#config.relayerStatusUrl) {
      return undefined
    }

    // Strip any trailing slash(es) so a caller-supplied relayerStatusUrl
    // ending in "/" doesn't produce a malformed ".../deposit//123" path.
    const statusBaseUrl = this.#config.relayerStatusUrl.replace(/\/+$/, "")
    const statusUrl = `${statusBaseUrl}/${encodeURIComponent(depositId)}`

    const response = await axios.get<RelayerDepositStatusResponse>(statusUrl, {
      timeout: 15000,
      headers: {
        "Content-Type": "application/json",
      },
    })

    // Require the literal boolean `true`. Axios does not validate decoded JSON
    // against the declared type, so a truthy non-boolean value such as
    // "false", "true", 1, or {} must not be treated as a verified status.
    if (response.data?.success !== true) {
      return undefined
    }

    return response.data
  }

  /**
   * Builds a human-readable message describing an unresolved deposit
   * conflict, tailored to whatever status information could be verified.
   * @param depositId Canonical decimal deposit ID, if known
   * @param status Verified relayer status, if known
   * @param statusVerified Whether status reflects a verified relayer response
   * @returns A descriptive error message
   */
  private formatConflictMessage(
    depositId: string | undefined,
    status: StarkNetRelayerDepositStatus | undefined,
    statusVerified: boolean
  ): string {
    const idSuffix = depositId ? ` (ID: ${depositId})` : ""

    if (statusVerified && status === StarkNetRelayerDepositStatus.QUEUED) {
      return (
        `the L1 depositor contract has no record of this deposit${idSuffix} yet (status 0); ` +
        "the deposit may still be pending initialization, or the relayer may be " +
        "reporting a stale conflict. Poll again or use the deposit ID to recover."
      )
    }

    if (
      statusVerified &&
      (status === StarkNetRelayerDepositStatus.INITIALIZED ||
        status === StarkNetRelayerDepositStatus.FINALIZED)
    ) {
      const statusName = StarkNetRelayerDepositStatus[status]
      return (
        `This deposit${idSuffix} has already been ${statusName.toLowerCase()} ` +
        "at the relayer, but the SDK could not obtain a verified " +
        "transaction receipt for it. Check the deposit status " +
        "independently before retrying."
      )
    }

    return (
      `The relayer reports this deposit${idSuffix} already exists, but ` +
      "its status could not be verified. This may indicate a prior " +
      "request partially succeeded; check the deposit status " +
      "independently before retrying."
    )
  }

  /**
   * Determines if an error is retryable. A 409 (Conflict) is intentionally not
   * handled here: it is dispatched to {@link handleDepositConflict} in
   * `initializeDeposit` before this classifier is ever consulted, and an
   * ordinary 409 would fall through to the default `false` regardless.
   * @param error The error to check
   * @returns True if the error is retryable
   */
  private isRetryableError(error: any): boolean {
    // Network/timeout errors
    if (
      error.code === "ECONNABORTED" ||
      error.code === "ECONNREFUSED" ||
      error.code === "ENOTFOUND"
    ) {
      return true
    }

    // Server errors (5xx)
    if (error.response?.status >= 500 && error.response?.status < 600) {
      return true
    }

    return false
  }

  /**
   * Formats relayer errors into user-friendly messages
   * @param error The error to format
   * @returns Formatted error message
   */
  private formatRelayerError(error: any): string {
    // Check if it's an Axios error
    const isAxiosError = error.isAxiosError || axios.isAxiosError?.(error)

    if (isAxiosError || error.code === "ECONNABORTED") {
      // Handle timeout errors
      if (error.code === "ECONNABORTED") {
        return "Relayer request timed out. Please try again."
      }

      // Handle HTTP errors
      if (error.response) {
        const status = error.response.status
        const data = error.response.data as RelayerRevealResponse | any

        if (status === 500) {
          // Check if there's more specific error info
          const errorDetail =
            data?.error || data?.message || "Internal server error"
          return `Relayer service error: ${errorDetail}. Please try again in a few moments.`
        }

        if (status === 400) {
          // Check for structured error response
          const errorMessage =
            data?.error ||
            data?.message ||
            (data?.details
              ? `Invalid request: ${JSON.stringify(data.details)}`
              : "Invalid request")
          return `Relayer error: ${errorMessage}`
        }

        if (status === 401) {
          return "Relayer request failed: Unauthorized"
        }

        if (status === 403) {
          return "Relayer request failed: Forbidden"
        }

        if (status === 404) {
          return "Relayer request failed: Not Found"
        }

        // 409 (Conflict) is handled separately in handleDepositConflict,
        // which verifies deposit status before ever resolving or throwing,
        // so it never reaches this generic formatter.

        if (status >= 502 && status < 600) {
          return `Network error: ${error.message}`
        }
      }

      // Handle network errors (no response)
      if (error.code === "ECONNREFUSED" || error.code === "ENOTFOUND") {
        return `Network error: ${error.message}`
      }
    }

    // Default error message
    return `Failed to initialize deposit through relayer: ${error.message}`
  }

  /**
   * Formats a StarkNet address to ensure it's a valid bytes32 value.
   * @param address The StarkNet address to format
   * @returns The formatted address with 0x prefix and 64 hex characters
   * @throws Error if the address is invalid
   */
  private formatStarkNetAddressAsBytes32(address: string): string {
    return StarkNetAddress.from(address).toBytes32()
  }
}

/**
 * @deprecated Use StarkNetBitcoinDepositor instead
 */
export const StarkNetDepositor = StarkNetBitcoinDepositor
