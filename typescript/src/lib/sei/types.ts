/* eslint-disable no-unused-vars */
import { BigNumber } from "ethers"

/**
 * Sei-specific chain identifiers and constants
 */
export const SeiChains = {
  // / Sei Pacific-1 Mainnet (Wormhole Chain ID: 32)
  MAINNET: 32,
  // / Sei Atlantic-2 Testnet (Wormhole Chain ID: 32, but different network)
  TESTNET: 32,
} as const

/**
 * Sei network configuration
 */
export interface SeiNetworkConfig {
  // / Network name (e.g., "sei-mainnet", "sei-testnet")
  name: string
  // / Chain ID for the Sei network
  chainId: number
  // / Wormhole chain ID (32 for Sei)
  wormholeChainId: number
  // / RPC endpoint URL
  rpcUrl: string
  // / Block explorer URL
  explorerUrl: string
  // / Whether this is a testnet
  isTestnet: boolean
}

/**
 * Predefined Sei network configurations
 */
export const SeiNetworks: Record<string, SeiNetworkConfig> = {
  mainnet: {
    name: "sei-mainnet",
    chainId: 1329, // Sei Pacific-1 EVM chain ID
    wormholeChainId: SeiChains.MAINNET,
    rpcUrl: "https://evm-rpc.sei-apis.com",
    explorerUrl: "https://seitrace.com",
    isTestnet: false,
  },
  testnet: {
    name: "sei-testnet",
    chainId: 1328, // Sei Atlantic-2 EVM chain ID
    wormholeChainId: SeiChains.TESTNET,
    rpcUrl: "https://evm-rpc-testnet.sei-apis.com",
    explorerUrl: "https://seitrace.com/?chain=atlantic-2",
    isTestnet: true,
  },
}

/**
 * Wormhole Executor service configuration for Sei
 */
export interface SeiExecutorConfig {
  // / Executor service API endpoint
  apiEndpoint: string
  // / Default gas limit for Sei destination execution
  defaultGasLimit: number
  // / Default executor fee in basis points
  defaultFeeBps: number
  // / Maximum executor fee in basis points
  maxFeeBps: number
  // / Timeout for executor API calls in milliseconds
  apiTimeout: number
}

/**
 * Default Sei executor configurations
 */
export const SeiExecutorConfigs: Record<string, SeiExecutorConfig> = {
  mainnet: {
    apiEndpoint: "https://api.wormhole.com/v1/executor", // TODO: Update with actual endpoint
    defaultGasLimit: 500000,
    defaultFeeBps: 0,
    maxFeeBps: 1000, // 10%
    apiTimeout: 30000, // 30 seconds
  },
  testnet: {
    apiEndpoint: "https://api.testnet.wormhole.com/v1/executor", // TODO: Update with actual endpoint
    defaultGasLimit: 500000,
    defaultFeeBps: 0,
    maxFeeBps: 1000, // 10%
    apiTimeout: 30000, // 30 seconds
  },
}

/**
 * Sei bridging transaction status
 */
export enum SeiBridgeStatus {
  // / Transaction is pending
  PENDING = "pending",
  // / Transaction is being processed by Wormhole
  PROCESSING = "processing",
  // / Transaction completed successfully
  COMPLETED = "completed",
  // / Transaction failed
  FAILED = "failed",
  // / Transaction was cancelled
  CANCELLED = "cancelled",
}

/**
 * Sei bridge transaction details
 */
export interface SeiBridgeTransaction {
  // / Transaction hash on source chain (Ethereum)
  sourceTransactionHash: string
  // / Transaction hash on destination chain (Sei)
  destinationTransactionHash?: string
  // / Wormhole sequence number
  sequence?: string
  // / Bridge status
  status: SeiBridgeStatus
  // / Amount being bridged (in wei)
  amount: BigNumber
  // / Recipient address on Sei
  recipient: string
  // / Timestamp when bridging was initiated
  timestamp: number
  // / Estimated completion time
  estimatedCompletion?: number
  // / Error message if failed
  error?: string
}

/**
 * Sei deposit parameters for cross-chain deposits
 */
export interface SeiDepositParams {
  // / Recipient address on Sei (EVM format)
  recipient: string
  // / Amount to deposit (in satoshi)
  amount: BigNumber
  // / Wormhole chain ID for Sei
  destinationChain: number
  // / Extra data for the deposit (encoded recipient)
  extraData: string
  // / Executor parameters for automatic execution
  executorParams?: {
    // / Value to pay executor
    value: BigNumber
    // / Refund address
    refundAddress: string
    // / Signed quote from executor API
    signedQuote: string
    // / Gas limit for destination execution
    gasLimit?: number
  }
  // / Fee parameters
  feeParams?: {
    // / Fee in basis points
    feeBps: number
    // / Fee recipient address
    feeRecipient: string
  }
}

/**
 * Sei gas estimation result
 */
export interface SeiGasEstimate {
  // / Estimated gas limit for the transaction
  gasLimit: number
  // / Estimated gas price in wei
  gasPrice: BigNumber
  // / Total estimated cost in wei
  totalCost: BigNumber
  // / Executor service fee in wei
  executorFee: BigNumber
  // / Wormhole protocol fee in wei
  protocolFee: BigNumber
}

/**
 * Sei relayer configuration
 */
export interface SeiRelayerConfig {
  // / Relayer service endpoint
  endpoint: string
  // / API key for authentication (if required)
  apiKey?: string
  // / Timeout for relayer requests
  timeout: number
  // / Maximum number of retry attempts
  maxRetries: number
  // / Delay between retry attempts in milliseconds
  retryDelay: number
}

/**
 * Default Sei relayer configurations
 */
export const SeiRelayerConfigs: Record<string, SeiRelayerConfig> = {
  mainnet: {
    endpoint:
      "https://tbtc-crosschain-relayer.threshold.network/api/Sei/reveal", // TODO: Update with actual endpoint
    timeout: 90000, // 90 seconds
    maxRetries: 3,
    retryDelay: 5000, // 5 seconds
  },
  testnet: {
    endpoint:
      "https://tbtc-crosschain-relayer-testnet.threshold.network/api/Sei/reveal", // TODO: Update with actual endpoint
    timeout: 90000, // 90 seconds
    maxRetries: 3,
    retryDelay: 5000, // 5 seconds
  },
}

/**
 * Utility type for Sei-specific error codes
 */
export enum SeiErrorCode {
  // / Network not supported
  UNSUPPORTED_NETWORK = "UNSUPPORTED_NETWORK",
  // / Invalid recipient address
  INVALID_RECIPIENT = "INVALID_RECIPIENT",
  // / Insufficient balance for bridging
  INSUFFICIENT_BALANCE = "INSUFFICIENT_BALANCE",
  // / Executor service unavailable
  EXECUTOR_UNAVAILABLE = "EXECUTOR_UNAVAILABLE",
  // / Invalid executor quote
  INVALID_EXECUTOR_QUOTE = "INVALID_EXECUTOR_QUOTE",
  // / Transaction timeout
  TRANSACTION_TIMEOUT = "TRANSACTION_TIMEOUT",
  // / Bridge capacity exceeded
  BRIDGE_CAPACITY_EXCEEDED = "BRIDGE_CAPACITY_EXCEEDED",
  // / Relayer service error
  RELAYER_ERROR = "RELAYER_ERROR",
}

/**
 * Sei-specific error class
 */
export class SeiError extends Error {
  public readonly code: SeiErrorCode
  public readonly details?: any

  constructor(code: SeiErrorCode, message: string, details?: any) {
    super(message)
    this.name = "SeiError"
    this.code = code
    this.details = details
  }
}

/**
 * Utility functions for Sei address validation and conversion
 */
export class SeiAddressUtils {
  /**
   * Validates if an address is a valid Sei EVM address
   * @param address The address to validate
   * @returns True if valid, false otherwise
   */
  static isValidEvmAddress(address: string): boolean {
    return /^0x[0-9a-fA-F]{40}$/.test(address)
  }

  /**
   * Converts a Sei Bech32 address to EVM format (if needed in the future)
   * @param bech32Address The Bech32 address
   * @returns The EVM address
   * @throws Error if conversion is not supported or address is invalid
   */
  static bech32ToEvm(bech32Address: string): string {
    // TODO: Implement if needed for Sei Bech32 to EVM conversion
    throw new Error("Bech32 to EVM conversion not yet implemented")
  }

  /**
   * Converts an EVM address to Sei Bech32 format (if needed in the future)
   * @param evmAddress The EVM address
   * @returns The Bech32 address
   * @throws Error if conversion is not supported or address is invalid
   */
  static evmToBech32(evmAddress: string): string {
    // TODO: Implement if needed for EVM to Sei Bech32 conversion
    throw new Error("EVM to Bech32 conversion not yet implemented")
  }

  /**
   * Normalizes an address to ensure it has the correct format
   * @param address The address to normalize
   * @returns The normalized address with 0x prefix
   */
  static normalizeAddress(address: string): string {
    if (!address.startsWith("0x")) {
      address = "0x" + address
    }
    return address.toLowerCase()
  }
}
