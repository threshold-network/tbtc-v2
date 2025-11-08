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
import { BitcoinNetwork } from "../../lib/bitcoin/network"
import { Hex } from "../../lib/utils"
import { Deposit } from "./deposit"
import * as crypto from "crypto"
import { CrossChainDepositor } from "./cross-chain"
import { NATIVE_BTC_DEPOSITOR_ADDRESSES } from "../../lib/ethereum/constants"
import { EthereumAddress } from "../../lib/ethereum/address"

/**
 * Supported destination chains for gasless deposits.
 * Includes "L1" for direct Ethereum L1 deposits and all supported L2 chains.
 */
export type GaslessDestination = "L1" | DestinationChainName

/**
 * Result of initiating a gasless deposit where the relayer backend pays all
 * gas fees.
 *
 * This structure contains both the Deposit object for Bitcoin operations and
 * serializable data that can be stored (e.g., in localStorage) for later use
 * in building the relay payload.
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
   * This is serializable and can be stored for later payload construction.
   */
  receipt: DepositReceipt

  /**
   * Target chain name for the deposit.
   * Can be "L1" or any L2 chain name (e.g., "Arbitrum", "Base", "Optimism").
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
export class DepositsService {
  /**
   * Deposit refund locktime duration in seconds.
   * This is 9 month in seconds assuming 1 month = 30 days
   */
  private readonly depositRefundLocktimeDuration = 23328000

  /**
   * List of chains that support gasless deposits.
   * - "L1": Direct L1 deposits via NativeBTCDepositor
   * - "Arbitrum", "Base", "Sui", "StarkNet": L2 deposits via L1BitcoinDepositor
   *
   * Note: "Solana" is excluded as it uses a different architecture and
   * gasless deposit support is not yet confirmed.
   */
  private readonly SUPPORTED_GASLESS_CHAINS = [
    "L1",
    "Arbitrum",
    "Base",
    "Sui",
    "StarkNet",
  ] as const

  /**
   * Hex string length for a bytes32 value (0x prefix + 64 hex characters).
   * Used for L1 deposit owner encoding and extraData validation.
   */
  private readonly BYTES32_HEX_LENGTH = 66

  /**
   * Hex string length for an Ethereum address (0x prefix + 40 hex characters).
   * Used for L2 deposit owner encoding and extraData validation.
   */
  private readonly ADDRESS_HEX_LENGTH = 42

  /**
   * Number of hex characters representing a 20-byte Ethereum address (40 chars).
   * Used when extracting address from bytes32 extraData.
   */
  private readonly ADDRESS_HEX_CHARS = 40

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
  readonly #crossChainContracts: (
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
    crossChainContracts: (
      _: DestinationChainName
    ) => CrossChainInterfaces | undefined,
    nativeBTCDepositor?: ChainIdentifier
  ) {
    this.tbtcContracts = tbtcContracts
    this.bitcoinClient = bitcoinClient
    this.#crossChainContracts = crossChainContracts
    this.#nativeBTCDepositor = nativeBTCDepositor
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
   * This method generates a deposit for backend relay, supporting both L1 and L2
   * (cross-chain) destinations. For L1 deposits, the NativeBTCDepositor contract
   * is used. For L2 deposits, the L1BitcoinDepositor contract is used with
   * proper extraData encoding for the destination chain.
   *
   * @param bitcoinRecoveryAddress P2PKH or P2WPKH Bitcoin address for emergency recovery
   * @param depositOwner Ethereum address that will receive the minted tBTC.
   *                     For L1 deposits, this is the user's Ethereum address.
   *                     For L2 deposits, this is typically the signer's address
   *                     (obtained from the destination chain BitcoinDepositor).
   * @param destinationChainName Target chain name for the deposit. Must be one of the
   *                             supported chains (case-sensitive):
   *                             - "L1" - Direct L1 deposits via NativeBTCDepositor
   *                             - "Arbitrum" - Arbitrum L2 deposits
   *                             - "Base" - Base L2 deposits
   *                             - "Sui" - Sui L2 deposits
   *                             - "StarkNet" - StarkNet L2 deposits (note: capital 'N')
   *                             Note: "Solana" is not currently supported for gasless deposits
   * @returns GaslessDepositResult containing deposit object, receipt, and chain name
   * @throws Throws an error if:
   *         - Bitcoin recovery address is not P2PKH or P2WPKH
   *         - Deposit owner is not a valid Ethereum address
   *         - Destination chain name is not in the supported list
   *         - Destination chain contracts not initialized (for L2 deposits)
   *         - NativeBTCDepositor address not available (for L1 deposits)
   *         - Deposit owner cannot be resolved (for L2 deposits)
   *         - No active wallet in Bridge contract
   */
  async initiateGaslessDeposit(
    bitcoinRecoveryAddress: string,
    depositOwner: string,
    destinationChainName: string
  ): Promise<GaslessDepositResult> {
    // Validate that the chain supports gasless deposits
    if (!this.SUPPORTED_GASLESS_CHAINS.includes(destinationChainName as any)) {
      throw new Error(
        `Gasless deposits are not supported for chain: ${destinationChainName}. ` +
          `Supported chains: ${this.SUPPORTED_GASLESS_CHAINS.join(", ")}`
      )
    }

    if (destinationChainName === "L1") {
      return this.initiateL1GaslessDeposit(bitcoinRecoveryAddress, depositOwner)
    } else {
      return this.initiateL2GaslessDeposit(
        bitcoinRecoveryAddress,
        destinationChainName as DestinationChainName
      )
    }
  }

  /**
   * Internal helper for L1 gasless deposits using NativeBTCDepositor.
   * @param bitcoinRecoveryAddress - Bitcoin address for recovery if deposit fails (P2PKH or P2WPKH).
   * @param depositOwner - Ethereum address that will receive the minted tBTC on L1.
   * @returns Promise resolving to GaslessDepositResult containing deposit, receipt, and "L1" chain name.
   */
  private async initiateL1GaslessDeposit(
    bitcoinRecoveryAddress: string,
    depositOwner: string
  ): Promise<GaslessDepositResult> {
    let depositor = this.getNativeBTCDepositorAddress()
    if (!depositor) {
      depositor = await this.resolveNativeBTCDepositorFromNetwork()
    }
    if (!depositor) {
      const network = await this.bitcoinClient.getNetwork()
      throw new Error(
        `NativeBTCDepositor address not available for Bitcoin network: ${network}`
      )
    }

    // Encode depositOwner as bytes32 for L1 contract
    const { ethers } = await import("ethers")
    const depositOwnerBytes32 = Hex.from(
      ethers.utils.hexZeroPad(depositOwner, 32)
    )

    const receipt = await this.generateDepositReceipt(
      bitcoinRecoveryAddress,
      depositor,
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
   * Internal helper for L2 gasless deposits using L1BitcoinDepositor.
   * Pattern based on initiateCrossChainDeposit.
   * @param bitcoinRecoveryAddress - Bitcoin address for recovery if deposit fails (P2PKH or P2WPKH).
   * @param destinationChainName - Name of the L2 destination chain (e.g., "Base", "Arbitrum", "Optimism").
   * @returns Promise resolving to GaslessDepositResult containing deposit, receipt, and destination chain name.
   */
  private async initiateL2GaslessDeposit(
    bitcoinRecoveryAddress: string,
    destinationChainName: DestinationChainName
  ): Promise<GaslessDepositResult> {
    const crossChainContracts = this.#crossChainContracts(destinationChainName)
    if (!crossChainContracts) {
      throw new Error(
        `Cross-chain contracts for ${destinationChainName} not initialized`
      )
    }

    const depositorProxy = new CrossChainDepositor(crossChainContracts)

    const receipt = await this.generateDepositReceipt(
      bitcoinRecoveryAddress,
      depositorProxy.getChainIdentifier(),
      depositorProxy.extraData()
    )

    const deposit = await Deposit.fromReceipt(
      receipt,
      this.tbtcContracts,
      this.bitcoinClient
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
   * This public method constructs the complete payload needed by the relayer
   * backend to submit a gasless deposit reveal transaction after the Bitcoin
   * funding transaction is confirmed. The method handles chain-specific owner
   * encoding requirements:
   * - L1 deposits: Encode owner as bytes32 (left-padded Ethereum address)
   * - L2 deposits: Extract 20-byte address from 32-byte extraData
   *
   * The payload includes:
   * - Bitcoin funding transaction decomposed into vectors (version, inputs,
   *   outputs, locktime) - used by backend for deposit key computation
   * - Deposit reveal parameters from the receipt (blinding factor, wallet PKH,
   *   refund PKH, refund locktime, vault)
   * - Destination chain deposit owner (encoding varies by chain type)
   * - Destination chain name for backend routing (normalized to lowercase)
   *
   * CRITICAL: This method provides raw Bitcoin transaction vectors to the
   * backend. The backend computes the depositKey using Bitcoin's hash256
   * (double-SHA256) algorithm, NOT keccak256. The SDK does not compute the
   * depositKey directly.
   *
   * IMPORTANT: Chain names are automatically normalized to lowercase for
   * backend compatibility. The SDK accepts capitalized chain names (e.g.,
   * "Arbitrum", "Base") but converts them to lowercase (e.g., "arbitrum",
   * "base") in the returned payload. The exception is "L1" which remains
   * as-is.
   *
   * @param receipt - Deposit receipt from initiateGaslessDeposit containing
   *                  all deposit parameters. For L2 deposits, receipt MUST
   *                  include extraData with the deposit owner address encoded.
   * @param fundingTxHash - Bitcoin transaction hash of the funding transaction.
   *                        This transaction must be confirmed on Bitcoin network
   *                        before calling this method.
   * @param fundingOutputIndex - Zero-based index of the deposit output in the
   *                             funding transaction. Use the output index where
   *                             the deposit script address received the funds.
   * @param destinationChainName - Target chain name for the deposit. Should match
   *                               the chain name used in initiateGaslessDeposit:
   *                               - "L1" for direct L1 deposits (remains "L1")
   *                               - L2 chain names: "Arbitrum", "Base", "Sui",
   *                                 "StarkNet" (converted to lowercase in payload)
   * @returns Promise resolving to GaslessRevealPayload ready for submission to
   *          backend POST /tbtc/gasless-reveal endpoint. The
   *          destinationChainName field will be lowercase (except "L1")
   * @throws Error if extraData is missing for L2 deposits (cross-chain)
   * @throws Error if extraData has invalid length for L2 deposits (must be 20
   *         or 32 bytes)
   * @throws Error if Bitcoin transaction cannot be fetched from the client
   * @throws Error if vault address cannot be retrieved from contracts
   */
  async buildGaslessRelayPayload(
    receipt: DepositReceipt,
    fundingTxHash: BitcoinTxHash,
    fundingOutputIndex: number,
    destinationChainName: string
  ): Promise<GaslessRevealPayload> {
    // Import needed here to avoid circular dependency
    const { extractBitcoinRawTxVectors } = await import("../../lib/bitcoin/tx")
    const { ethers } = await import("ethers")

    // Step 1: Get Bitcoin transaction and extract vectors
    const fundingTx = await this.bitcoinClient.getRawTransaction(fundingTxHash)
    const fundingTxVectors = extractBitcoinRawTxVectors(fundingTx)

    // Step 2: Get vault address
    const vaultChainIdentifier =
      this.tbtcContracts.tbtcVault.getChainIdentifier()
    const vaultAddress = `0x${vaultChainIdentifier.identifierHex}`

    // Step 3: Determine owner encoding based on chain
    // L1 contracts expect bytes32 owner (32 bytes), L2 contracts expect address (20 bytes)
    let destinationOwner: string

    if (destinationChainName === "L1") {
      // L1: Use bytes32 encoding for owner
      if (receipt.extraData) {
        // If extraData is present, use it directly (already bytes32)
        destinationOwner = receipt.extraData.toPrefixedString()
      } else {
        // If no extraData, encode depositor address as bytes32 (left-padded)
        destinationOwner = ethers.utils.hexZeroPad(
          `0x${receipt.depositor.identifierHex}`,
          32
        )
      }
    } else {
      // L2: extraData is required and must contain the deposit owner address
      if (!receipt.extraData) {
        throw new Error(
          `extraData required for cross-chain gasless deposits but was not found in the receipt. ` +
            `This should not happen - please ensure you used initiateGaslessDeposit() to generate the deposit.`
        )
      }

      const extraDataHex = receipt.extraData.toPrefixedString()

      // L2 contracts (e.g., Arbitrum, Base) expect address type, not bytes32
      if (extraDataHex.length === this.BYTES32_HEX_LENGTH) {
        // 32 bytes: Extract last 20 bytes (address) from bytes32 extraData
        // The address is stored in the rightmost 20 bytes of the 32-byte value
        destinationOwner = `0x${extraDataHex.slice(-this.ADDRESS_HEX_CHARS)}`
      } else if (extraDataHex.length === this.ADDRESS_HEX_LENGTH) {
        // Already 20 bytes (address format) - use directly
        destinationOwner = extraDataHex
      } else {
        throw new Error(
          `Invalid extraData length for L2 deposit owner: received ${
            (extraDataHex.length - 2) / 2
          } bytes, expected 20 or 32 bytes. ` +
            `ExtraData must contain the destination chain deposit owner address.`
        )
      }
    }

    // Step 4: Normalize chain name for backend compatibility
    // Backend expects lowercase chain names (e.g., "arbitrum", "base")
    // except "L1" which should remain as-is
    const normalizedChainName =
      destinationChainName === "L1" ? "L1" : destinationChainName.toLowerCase()

    // Step 5: Build and return payload
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
   * Gets the chain identifier of the NativeBTCDepositor contract.
   * This contract is used for L1 gasless deposits.
   * @returns Chain identifier of the NativeBTCDepositor or undefined if not available.
   */
  private getNativeBTCDepositorAddress(): ChainIdentifier | undefined {
    return this.#nativeBTCDepositor
  }

  /**
   * Sets the NativeBTCDepositor address override used for L1 gasless deposits.
   * Useful for custom deployments or testing environments.
   * @param nativeBTCDepositor - Chain identifier of the NativeBTCDepositor contract to use.
   * @returns {void}
   */
  setNativeBTCDepositor(nativeBTCDepositor: ChainIdentifier) {
    this.#nativeBTCDepositor = nativeBTCDepositor
  }

  /**
   * Resolves the NativeBTCDepositor address from the current Bitcoin network
   * using the NATIVE_BTC_DEPOSITOR_ADDRESSES mapping.
   * @returns Chain identifier of the NativeBTCDepositor contract, or undefined
   *          if the mapping is missing or invalid for the network.
   */
  private async resolveNativeBTCDepositorFromNetwork(): Promise<
    ChainIdentifier | undefined
  > {
    const network = await this.bitcoinClient.getNetwork()
    if (
      network !== BitcoinNetwork.Mainnet &&
      network !== BitcoinNetwork.Testnet
    ) {
      return undefined
    }

    const address = NATIVE_BTC_DEPOSITOR_ADDRESSES[network]
    if (!address) return undefined

    try {
      return EthereumAddress.from(address)
    } catch {
      return undefined
    }
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
