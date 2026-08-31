import {
  ChainIdentifier,
  CrossChainInterfaces,
  DepositorProxy,
  DepositReceipt,
  DestinationChainName,
  TBTCContracts,
} from "../../lib/contracts"
import {
  BitcoinAddressConverter,
  BitcoinClient,
  BitcoinHashUtils,
  BitcoinLocktimeUtils,
  BitcoinScriptUtils,
  BitcoinTxHash,
} from "../../lib/bitcoin"
import { Hex } from "../../lib/utils"
import { Deposit } from "./deposit"
import * as crypto from "crypto"
import { CrossChainDepositor } from "./cross-chain"
import { EthereumAddress } from "../../lib/ethereum/address"
import { utils as ethersUtils } from "ethers"
import { extractBitcoinRawTxVectors } from "../../lib/bitcoin/tx"

/**
 * Canonical list of destination chains supported by the gasless deposit flow.
 * Literal source of truth; `GaslessDestination` is derived from it so the
 * type and runtime list cannot drift.
 */
export const SUPPORTED_GASLESS_CHAINS = [
  "L1",
  "Arbitrum",
  "Base",
  "Sui",
  "StarkNet",
] as const

/**
 * Destination chain name accepted by `initiateGaslessDeposit` and
 * `buildGaslessRelayPayload`. Derived from `SUPPORTED_GASLESS_CHAINS`.
 */
export type GaslessDestination = (typeof SUPPORTED_GASLESS_CHAINS)[number]

/**
 * Result of initiating a gasless deposit where the relayer backend pays all
 * gas fees.
 *
 * This structure contains both the Deposit object for Bitcoin operations and
 * the typed deposit receipt needed to build the relay payload once the
 * funding transaction is confirmed.
 *
 * @see {GaslessRevealPayload} for the payload structure needed after funding
 */
export interface GaslessDepositResult {
  /**
   * Deposit object for Bitcoin address generation and funding detection.
   * Use `deposit.getBitcoinAddress()` to get the deposit address.
   * Use `deposit.detectFunding()` to monitor for Bitcoin transactions.
   */
  deposit: Deposit

  /**
   * Deposit receipt containing all deposit parameters.
   * Contains `Hex`/`ChainIdentifier` class instances, not plain JSON — a
   * `JSON.parse(JSON.stringify(receipt))` round trip does NOT reproduce a
   * usable receipt. Callers needing to persist this across page reloads
   * must implement their own serialize/deserialize step that reconstructs
   * these class instances.
   */
  receipt: DepositReceipt

  /**
   * Target chain name for the deposit.
   * Can be "L1" or any L2 chain name (e.g., "Arbitrum", "Base", "Sui").
   */
  destinationChainName: GaslessDestination
}

/**
 * Payload structure for backend gasless reveal endpoint.
 *
 * This payload contains all information needed by the relayer backend to
 * submit a gasless deposit reveal transaction. The backend will:
 * 1. Verify the Bitcoin funding transaction
 * 2. Construct the reveal transaction
 * 3. Pay gas fees and submit to the target chain
 *
 * All hex string fields should be prefixed with "0x".
 * The fundingTx structure matches BitcoinRawTxVectors format.
 *
 * @see {BitcoinRawTxVectors} for transaction vector structure reference
 */
export interface GaslessRevealPayload {
  /**
   * Bitcoin funding transaction decomposed into vectors.
   * This structure matches the on-chain contract requirements.
   */
  fundingTx: {
    /**
     * Transaction version as 4-byte hex string (e.g., "0x01000000").
     */
    version: string

    /**
     * All transaction inputs prepended by input count as hex string.
     */
    inputVector: string

    /**
     * All transaction outputs prepended by output count as hex string.
     */
    outputVector: string

    /**
     * Transaction locktime as 4-byte hex string.
     */
    locktime: string
  }

  /**
   * Deposit reveal information matching on-chain reveal structure.
   */
  reveal: {
    /**
     * Zero-based index of the deposit output in the funding transaction.
     */
    fundingOutputIndex: number

    /**
     * 8-byte blinding factor as hex string (e.g., "0xf9f0c90d00039523").
     */
    blindingFactor: string

    /**
     * 20-byte wallet public key hash as hex string.
     *
     * You can use `computeHash160` function to get the hash from a public key.
     */
    walletPubKeyHash: string

    /**
     * 20-byte refund public key hash as hex string.
     *
     * You can use `computeHash160` function to get the hash from a public key.
     */
    refundPubKeyHash: string

    /**
     * 4-byte refund locktime as hex string (little-endian).
     */
    refundLocktime: string

    /**
     * Vault contract address as hex string (e.g., "0x1234...").
     */
    vault: string
  }

  /**
   * Destination chain deposit owner address.
   * Format varies by chain based on the contract parameter type:
   * - L1 (Ethereum): bytes32 - 32-byte hex (left-padded Ethereum address, e.g., "0x000000000000000000000000" + address)
   * - Arbitrum: address - 20-byte Ethereum address hex (e.g., "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1")
   * - Base: address - 20-byte Ethereum address hex (e.g., "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1")
   * - Sui: bytes32 - 32-byte hex (left-padded Ethereum address)
   * - StarkNet: bytes32 - 32-byte hex (left-padded Ethereum address)
   *
   * Note: Backend will automatically pad 20-byte addresses to bytes32 for chains that require it.
   */
  destinationChainDepositOwner: string

  /**
   * Target chain name for backend routing (normalized to lowercase).
   * - "L1" remains as-is for L1 deposits
   * - L2 chain names are lowercase: "arbitrum", "base", "sui", "starknet"
   */
  destinationChainName: string
}

/**
 * Service exposing features related to tBTC v2 deposits.
 */
/**
 * Deposit refund locktime duration in seconds.
 * This is 180 days (6 months assuming 1 month = 30 days).
 */
export const DEPOSIT_REFUND_LOCKTIME_DURATION_SECONDS = 15552000

export class DepositsService {
  /**
   * Deposit refund locktime duration in seconds.
   * This is 180 days (6 months assuming 1 month = 30 days).
   */
  private readonly depositRefundLocktimeDuration =
    DEPOSIT_REFUND_LOCKTIME_DURATION_SECONDS

  /**
   * Handle to tBTC contracts.
   */
  private readonly tbtcContracts: TBTCContracts
  /**
   * Bitcoin client handle.
   */
  private readonly bitcoinClient: BitcoinClient
  /**
   * Chain-specific identifier of the default depositor used for deposits
   * initiated by this service.
   */
  #defaultDepositor: ChainIdentifier | undefined
  /**
   * Gets cross-chain contracts for the given supported L2 chain.
   * @param _ Name of the L2 chain for which to get cross-chain contracts.
   * @returns Cross-chain contracts for the given L2 chain or
   *          undefined if not initialized.
   */
  #crossChainContracts: (
    _: DestinationChainName
  ) => CrossChainInterfaces | undefined
  /**
   * Chain-specific identifier of the NativeBTCDepositor contract used for
   * L1 gasless deposits.
   */
  #nativeBTCDepositor: ChainIdentifier | undefined

  constructor(
    tbtcContracts: TBTCContracts,
    bitcoinClient: BitcoinClient,
    crossChainContracts?: (
      _: DestinationChainName
    ) => CrossChainInterfaces | undefined,
    nativeBTCDepositor?: ChainIdentifier
  ) {
    this.tbtcContracts = tbtcContracts
    this.bitcoinClient = bitcoinClient
    this.#crossChainContracts = crossChainContracts ?? (() => undefined)
    this.#nativeBTCDepositor = nativeBTCDepositor
  }

  /**
   * Sets the cross-chain contracts resolver after construction. This is
   * used by the TBTC class to wire up cross-chain contract resolution
   * once the loader is ready.
   * @param resolver Function that returns cross-chain contracts for a
   *                 given destination chain name, or undefined if not
   *                 initialized.
   * @returns {void}
   */
  setCrossChainContractsResolver(
    resolver: (_: DestinationChainName) => CrossChainInterfaces | undefined
  ) {
    this.#crossChainContracts = resolver
  }

  /**
   * Initiates the tBTC v2 deposit process.
   * @param bitcoinRecoveryAddress P2PKH or P2WPKH Bitcoin address that can
   *                               be used for emergency recovery of the
   *                               deposited funds.
   * @param extraData Optional 32-byte extra data to be included in the
   *                  deposit script. Cannot be equal to 32 zero bytes.
   * @returns Handle to the initiated deposit process.
   * @throws Throws an error if one of the following occurs:
   *         - The default depositor is not set
   *         - There are no active wallet in the Bridge contract
   *         - The Bitcoin recovery address is not a valid P2(W)PKH
   *         - The optional extra data is set but is not 32-byte or equals
   *           to 32 zero bytes.
   */
  async initiateDeposit(
    bitcoinRecoveryAddress: string,
    extraData?: Hex
  ): Promise<Deposit> {
    if (this.#defaultDepositor === undefined) {
      throw new Error(
        "Default depositor is not set; use setDefaultDepositor first"
      )
    }

    const receipt = await this.generateDepositReceipt(
      bitcoinRecoveryAddress,
      this.#defaultDepositor,
      extraData
    )

    return Deposit.fromReceipt(receipt, this.tbtcContracts, this.bitcoinClient)
  }

  /**
   * Initiates the tBTC v2 deposit process using a depositor proxy.
   * The depositor proxy initiates minting on behalf of the user (i.e. original
   * depositor) and receives minted TBTC. This allows the proxy to provide
   * additional services to the user, such as routing the minted TBTC tokens
   * to another protocols, in an automated way.
   * @see DepositorProxy
   * @param bitcoinRecoveryAddress P2PKH or P2WPKH Bitcoin address that can
   *                               be used for emergency recovery of the
   *                               deposited funds.
   * @param depositorProxy Depositor proxy used to initiate the deposit.
   * @param extraData Optional 32-byte extra data to be included in the
   *                  deposit script. Cannot be equal to 32 zero bytes.
   * @returns Handle to the initiated deposit process.
   * @throws Throws an error if one of the following occurs:
   *         - There are no active wallet in the Bridge contract
   *         - The Bitcoin recovery address is not a valid P2(W)PKH
   *         - The optional extra data is set but is not 32-byte or equals
   *           to 32 zero bytes.
   */
  async initiateDepositWithProxy(
    bitcoinRecoveryAddress: string,
    depositorProxy: DepositorProxy,
    extraData?: Hex
  ): Promise<Deposit> {
    const receipt = await this.generateDepositReceipt(
      bitcoinRecoveryAddress,
      depositorProxy.getChainIdentifier(),
      extraData
    )

    return Deposit.fromReceipt(
      receipt,
      this.tbtcContracts,
      this.bitcoinClient,
      depositorProxy
    )
  }

  /**
   * Initiates the tBTC v2 cross-chain deposit process. A cross-chain deposit
   * is a deposit that targets an L2 chain other than the L1 chain the tBTC
   * system is deployed on. Such a deposit is initiated using a transaction
   * on the L2 chain. To make it happen, the given L2 cross-chain contracts
   * must be initialized along with a L2 signer first.
   *
   * @experimental THIS IS EXPERIMENTAL CODE THAT CAN BE CHANGED OR REMOVED
   *               IN FUTURE RELEASES. IT SHOULD BE USED ONLY FOR INTERNAL
   *               PURPOSES AND EXTERNAL APPLICATIONS SHOULD NOT DEPEND ON IT.
   *               CROSS-CHAIN SUPPORT IS NOT FULLY OPERATIONAL YET.
   *
   * @param bitcoinRecoveryAddress P2PKH or P2WPKH Bitcoin address that can
   *                               be used for emergency recovery of the
   *                               deposited funds.
   * @param destinationChainName Name of the L2 chain the deposit is targeting.
   * @returns Handle to the initiated deposit process.
   * @throws Throws an error if one of the following occurs:
   *         - There are no active wallet in the Bridge contract
   *         - The Bitcoin recovery address is not a valid P2(W)PKH
   *         - The cross-chain contracts for the given L2 chain are not
   *           initialized
   *         - The L2 deposit owner cannot be resolved. This typically
   *           happens if the L2 cross-chain contracts operate with a
   *           read-only signer whose address cannot be resolved.
   * @see {TBTC#initializeCrossChain} for cross-chain contracts initialization.
   * @dev This is actually a call to initiateDepositWithProxy with a built-in
   *      depositor proxy.
   */
  async initiateCrossChainDeposit(
    bitcoinRecoveryAddress: string,
    destinationChainName: DestinationChainName
  ): Promise<Deposit> {
    const crossChainContracts = this.#crossChainContracts(destinationChainName)
    if (!crossChainContracts) {
      throw new Error(
        `Cross-chain contracts for ${destinationChainName} not initialized`
      )
    }

    const depositorProxy = new CrossChainDepositor(crossChainContracts)

    return this.initiateDepositWithProxy(
      bitcoinRecoveryAddress,
      depositorProxy,
      depositorProxy.extraData()
    )
  }

  /**
   * Initiates a gasless tBTC v2 deposit where the backend relayer pays all gas fees.
   *
   * @experimental THIS IS EXPERIMENTAL CODE THAT CAN BE CHANGED OR REMOVED
   *               IN FUTURE RELEASES. IT SHOULD BE USED ONLY FOR INTERNAL
   *               PURPOSES AND EXTERNAL APPLICATIONS SHOULD NOT DEPEND ON IT.
   *               CROSS-CHAIN SUPPORT IS NOT FULLY OPERATIONAL YET.
   *
   * For L1 destinations the `depositOwner` is encoded as bytes32 in extraData.
   * For L2 destinations the SDK throws if `depositOwner` does not match the
   * L2 signer's resolved owner (the resolved owner is authoritative — the
   * caller cannot override it).
   *
   * @param bitcoinRecoveryAddress P2PKH or P2WPKH Bitcoin recovery address.
   * @param depositOwner Ethereum address that will receive the minted tBTC.
   * @param destinationChainName Target chain name (one of `SUPPORTED_GASLESS_CHAINS`).
   * @returns GaslessDepositResult containing deposit, receipt, and chain name.
   */
  async initiateGaslessDeposit(
    bitcoinRecoveryAddress: string,
    depositOwner: string,
    destinationChainName: GaslessDestination
  ): Promise<GaslessDepositResult> {
    if (!SUPPORTED_GASLESS_CHAINS.includes(destinationChainName)) {
      throw new Error(
        `Gasless deposits are not supported for chain: ${destinationChainName}. ` +
          `Supported chains: ${SUPPORTED_GASLESS_CHAINS.join(", ")}`
      )
    }

    if (destinationChainName === "L1") {
      return this.initiateL1GaslessDeposit(bitcoinRecoveryAddress, depositOwner)
    }
    return this.initiateL2GaslessDeposit(
      bitcoinRecoveryAddress,
      destinationChainName as Exclude<GaslessDestination, "L1">,
      depositOwner
    )
  }

  /**
   * Internal helper for L1 gasless deposits using the NativeBTCDepositor contract
   * configured via the constructor or `setNativeBTCDepositor`.
   *
   * @experimental THIS IS EXPERIMENTAL CODE THAT CAN BE CHANGED OR REMOVED
   *               IN FUTURE RELEASES. IT SHOULD BE USED ONLY FOR INTERNAL
   *               PURPOSES AND EXTERNAL APPLICATIONS SHOULD NOT DEPEND ON IT.
   *               CROSS-CHAIN SUPPORT IS NOT FULLY OPERATIONAL YET.
   *
   * @param bitcoinRecoveryAddress P2PKH or P2WPKH Bitcoin recovery address.
   * @param depositOwner Ethereum address that will receive the minted tBTC on L1.
   *                     Validated and encoded as bytes32 in extraData.
   * @returns Promise resolving to the GaslessDepositResult for the L1 deposit.
   * @throws Error if `depositOwner` is not a valid 20-byte Ethereum address or
   *         if no NativeBTCDepositor address has been configured.
   */
  private async initiateL1GaslessDeposit(
    bitcoinRecoveryAddress: string,
    depositOwner: string
  ): Promise<GaslessDepositResult> {
    // Validate depositOwner as an Ethereum address BEFORE encoding. A bad
    // depositOwner is unrecoverable because the deposit script is committed
    // to the Bitcoin funding address.
    const owner = EthereumAddress.from(depositOwner)
    const ownerHex = `0x${owner.identifierHex}`

    if (!this.#nativeBTCDepositor) {
      throw new Error(
        "NativeBTCDepositor address not set; call setNativeBTCDepositor or pass it via the DepositsService constructor before initiating a gasless L1 deposit"
      )
    }

    const depositOwnerBytes32 = Hex.from(ethersUtils.hexZeroPad(ownerHex, 32))

    const receipt = await this.generateDepositReceipt(
      bitcoinRecoveryAddress,
      this.#nativeBTCDepositor,
      depositOwnerBytes32
    )

    const deposit = await Deposit.fromReceipt(
      receipt,
      this.tbtcContracts,
      this.bitcoinClient
    )

    return {
      deposit,
      receipt,
      destinationChainName: "L1",
    }
  }

  /**
   * Internal helper for L2 gasless deposits using L1BitcoinDepositor with
   * L1-transaction reveal mode.
   *
   * @experimental THIS IS EXPERIMENTAL CODE THAT CAN BE CHANGED OR REMOVED
   *               IN FUTURE RELEASES. IT SHOULD BE USED ONLY FOR INTERNAL
   *               PURPOSES AND EXTERNAL APPLICATIONS SHOULD NOT DEPEND ON IT.
   *               CROSS-CHAIN SUPPORT IS NOT FULLY OPERATIONAL YET.
   *
   * @param bitcoinRecoveryAddress P2PKH or P2WPKH Bitcoin recovery address.
   * @param destinationChainName L2 destination chain.
   * @param depositOwner Ethereum address that the caller wants to receive the
   *                       minted tBTC. Must match the resolved L2 signer
   *                       owner; otherwise throws (the resolved owner is
   *                       authoritative — callers cannot override).
   * @returns Promise resolving to the GaslessDepositResult for the L2 deposit.
   */
  private async initiateL2GaslessDeposit(
    bitcoinRecoveryAddress: string,
    destinationChainName: Exclude<GaslessDestination, "L1">,
    depositOwner: string
  ): Promise<GaslessDepositResult> {
    const crossChainContracts = this.#crossChainContracts(destinationChainName)
    if (!crossChainContracts) {
      throw new Error(
        `Cross-chain contracts for ${destinationChainName} not initialized`
      )
    }

    // L1-transaction reveal mode: the relayer reveals directly on L1
    // (opposite of the default `L2Transaction` mode where the user reveals
    // from L2). See typescript/src/services/deposits/cross-chain.ts.
    const depositorProxy = new CrossChainDepositor(
      crossChainContracts,
      "L1Transaction"
    )

    // The L2 resolved owner is authoritative: depositOwner must match it.
    const resolvedOwner =
      await crossChainContracts.destinationChainBitcoinDepositor.getDepositOwner()
    if (
      !resolvedOwner ||
      EthereumAddress.from(depositOwner).identifierHex !==
        resolvedOwner.identifierHex
    ) {
      throw new Error(
        `depositOwner ${depositOwner} does not match the resolved L2 signer owner ${
          resolvedOwner ? resolvedOwner.identifierHex : "(unset)"
        }; for L2 gasless deposits the resolved owner is authoritative`
      )
    }

    const receipt = await this.generateDepositReceipt(
      bitcoinRecoveryAddress,
      depositorProxy.getChainIdentifier(),
      depositorProxy.extraData()
    )

    const deposit = await Deposit.fromReceipt(
      receipt,
      this.tbtcContracts,
      this.bitcoinClient,
      depositorProxy
    )

    return {
      deposit,
      receipt,
      destinationChainName,
    }
  }

  /**
   * Builds the payload for backend gasless reveal endpoint.
   *
   * @experimental THIS IS EXPERIMENTAL CODE THAT CAN BE CHANGED OR REMOVED
   *               IN FUTURE RELEASES. IT SHOULD BE USED ONLY FOR INTERNAL
   *               PURPOSES AND EXTERNAL APPLICATIONS SHOULD NOT DEPEND ON IT.
   *               CROSS-CHAIN SUPPORT IS NOT FULLY OPERATIONAL YET.
   *
   * The payload carries the Bitcoin funding transaction (decomposed into
   * version / inputVector / outputVector / locktime), the reveal parameters
   * from the receipt, the destination-chain deposit owner (32-byte extraData
   * passed through unchanged; the relayer or on-chain contract decodes per
   * chain type — see `EthereumExtraDataEncoder.decodeDepositOwner` and the
   * per-chain encoders under `typescript/src/lib/contracts/cross-chain.ts`),
   * and the destination chain name (lowercased for backend routing, except
   * "L1" which is preserved).
   *
   * NOTE: The backend recovers the funding txid by `hash256` over the supplied
   * vectors, then computes
   * `depositKey = keccak256(abi.encodePacked(reversedTxHash, fundingOutputIndex))`
   * — see `EthereumBridge.buildDepositKey` at
   * `typescript/src/lib/ethereum/bridge.ts:478-481`. The SDK does not compute
   * the depositKey directly.
   *
   * @param receipt Deposit receipt from `initiateGaslessDeposit`. `receipt.extraData`
   *                MUST be present.
   * @param fundingTxHash Bitcoin transaction hash of the funding transaction.
   * @param fundingOutputIndex Zero-based index of the deposit output in the
   *                           funding transaction (non-negative integer).
   * @param destinationChainName One of `SUPPORTED_GASLESS_CHAINS`. The wire
   *                              format lowercases L2 chain names.
   * @returns Payload ready for submission to the backend gasless-reveal endpoint.
   */
  async buildGaslessRelayPayload(
    receipt: DepositReceipt,
    fundingTxHash: BitcoinTxHash,
    fundingOutputIndex: number,
    destinationChainName: GaslessDestination
  ): Promise<GaslessRevealPayload> {
    if (!SUPPORTED_GASLESS_CHAINS.includes(destinationChainName)) {
      throw new Error(
        `Gasless deposits are not supported for chain: ${destinationChainName}. ` +
          `Supported chains: ${SUPPORTED_GASLESS_CHAINS.join(", ")}`
      )
    }

    if (!Number.isInteger(fundingOutputIndex) || fundingOutputIndex < 0) {
      throw new Error(
        `Invalid fundingOutputIndex: ${fundingOutputIndex}. Must be a non-negative integer.`
      )
    }

    if (!receipt.extraData) {
      throw new Error(
        `receipt.extraData is required for ${destinationChainName} gasless deposits. ` +
          `Use initiateGaslessDeposit() to generate the receipt.`
      )
    }

    const fundingTx = await this.bitcoinClient.getRawTransaction(fundingTxHash)
    const fundingTxVectors = extractBitcoinRawTxVectors(fundingTx)

    const vaultChainIdentifier =
      this.tbtcContracts.tbtcVault.getChainIdentifier()
    const vaultAddress = `0x${vaultChainIdentifier.identifierHex}`

    // All destination chains (L1 + L2) take a bytes32 `destinationChainDepositOwner`
    // — see AbstractL1BTCDepositor.initializeDeposit
    // (solidity/contracts/cross-chain/AbstractL1BTCDepositor.sol:283-293).
    // The SDK does not re-encode or re-extract; pass extraData through unchanged.
    const destinationOwner = receipt.extraData.toPrefixedString()

    const normalizedChainName =
      destinationChainName === "L1" ? "L1" : destinationChainName.toLowerCase()

    return {
      fundingTx: {
        version: fundingTxVectors.version.toPrefixedString(),
        inputVector: fundingTxVectors.inputs.toPrefixedString(),
        outputVector: fundingTxVectors.outputs.toPrefixedString(),
        locktime: fundingTxVectors.locktime.toPrefixedString(),
      },
      reveal: {
        fundingOutputIndex,
        blindingFactor: receipt.blindingFactor.toPrefixedString(),
        walletPubKeyHash: receipt.walletPublicKeyHash.toPrefixedString(),
        refundPubKeyHash: receipt.refundPublicKeyHash.toPrefixedString(),
        refundLocktime: receipt.refundLocktime.toPrefixedString(),
        vault: vaultAddress,
      },
      destinationChainDepositOwner: destinationOwner,
      destinationChainName: normalizedChainName,
    }
  }

  /**
   * Sets the NativeBTCDepositor address used for L1 gasless deposits.
   *
   * Required for any gasless L1 deposit. There is no auto-resolve from
   * `BitcoinNetwork` anymore — the SDK cannot verify a deployed contract
   * address, so the caller is responsible for supplying the canonical
   * NativeBTCDepositor contract address for the target Ethereum network.
   *
   * @param nativeBTCDepositor Chain identifier of the NativeBTCDepositor contract.
   *                           Must be a valid Ethereum address (40 hex chars,
   *                           non-zero). Solana/StarkNet/Sui/other identifiers
   *                           are rejected.
   * @returns {void}
   * @throws If the identifier is not a valid Ethereum address.
   */
  setNativeBTCDepositor(nativeBTCDepositor: ChainIdentifier) {
    let validated: ChainIdentifier
    try {
      validated = EthereumAddress.from(nativeBTCDepositor.identifierHex)
    } catch (err) {
      throw new Error(
        `NativeBTCDepositor must be a valid Ethereum address; received identifierHex='${nativeBTCDepositor.identifierHex}'`
      )
    }
    // EthereumAddress.identifierHex is UNPREFIXED (see address.ts:21).
    if (/^0{40}$/.test(validated.identifierHex)) {
      throw new Error("NativeBTCDepositor address cannot be the zero address")
    }
    this.#nativeBTCDepositor = validated
  }

  private async generateDepositReceipt(
    bitcoinRecoveryAddress: string,
    depositor: ChainIdentifier,
    extraData?: Hex
  ): Promise<DepositReceipt> {
    const blindingFactor = Hex.from(crypto.randomBytes(8))

    const walletPublicKey =
      await this.tbtcContracts.bridge.activeWalletPublicKey()

    if (!walletPublicKey) {
      throw new Error("Could not get active wallet public key")
    }

    const walletPublicKeyHash = BitcoinHashUtils.computeHash160(walletPublicKey)

    const bitcoinNetwork = await this.bitcoinClient.getNetwork()

    const recoveryOutputScript = BitcoinAddressConverter.addressToOutputScript(
      bitcoinRecoveryAddress,
      bitcoinNetwork
    )
    if (
      !BitcoinScriptUtils.isP2PKHScript(recoveryOutputScript) &&
      !BitcoinScriptUtils.isP2WPKHScript(recoveryOutputScript)
    ) {
      throw new Error("Bitcoin recovery address must be P2PKH or P2WPKH")
    }

    const refundPublicKeyHash = BitcoinAddressConverter.addressToPublicKeyHash(
      bitcoinRecoveryAddress,
      bitcoinNetwork
    )

    const currentTimestamp = Math.floor(new Date().getTime() / 1000)

    const refundLocktime = BitcoinLocktimeUtils.calculateLocktime(
      currentTimestamp,
      this.depositRefundLocktimeDuration
    )

    // If optional extra data is provided, check if it is valid and fail
    // fast if not.
    if (typeof extraData !== "undefined") {
      // Check if extra data vector has a correct length of 32 bytes.
      if (extraData.toString().length != 64) {
        throw new Error("Extra data is not 32-byte")
      }
      // Check if extra data vector is non-zero. This is important because a
      // deposit with defined extra data is handled via a special flow of
      // the Bridge and this vector is expected to be non-zero.
      if (
        extraData.toPrefixedString() ===
        "0x0000000000000000000000000000000000000000000000000000000000000000"
      ) {
        throw new Error("Extra data contains only zero bytes")
      }
    }

    return {
      depositor,
      blindingFactor,
      walletPublicKeyHash,
      refundPublicKeyHash,
      refundLocktime,
      extraData,
    }
  }

  // eslint-disable-next-line valid-jsdoc
  /**
   * Sets the default depositor used for deposits initiated by this service.
   * @param defaultDepositor Chain-specific identifier of the default depositor.
   * @dev Typically, there is no need to use this method when DepositsService
   *      is orchestrated automatically. However, there are some use cases
   *      where setting the default depositor explicitly may be useful.
   *      Make sure you know what you are doing while using this method.
   */
  setDefaultDepositor(defaultDepositor: ChainIdentifier) {
    this.#defaultDepositor = defaultDepositor
  }
}
