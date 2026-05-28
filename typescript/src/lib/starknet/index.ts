import { DestinationChainInterfaces } from "../contracts"
import {
  StarkNetBitcoinDepositor,
  StarkNetBitcoinDepositorConfig,
} from "./starknet-depositor"
import {
  StarkNetTBTCToken,
  StarkNetTBTCTokenConfig,
} from "./starknet-tbtc-token"
import { StarkNetAddress } from "./address"
import { StarkNetProvider } from "./types"
import { Chains } from "../contracts/chain"

export * from "./address"
export * from "./extra-data-encoder"
export * from "./starknet-depositor"
export * from "./starknet-tbtc-token"
export * from "./types"
export * from "./abi"

/**
 * Contract addresses for deployed tBTC contracts on StarkNet
 */
const TBTC_CONTRACT_ADDRESSES: Record<string, string> = {
  [Chains.StarkNet.Mainnet]:
    "0x04a909347487d909a6629b56880e6e03ad3859e772048c4481f3fba88ea02c32f",
  [Chains.StarkNet.Sepolia]:
    "0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276",
  // Test chain ID
  ["0x534e5f544553544e4554"]:
    "0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276", // Using Sepolia address for tests
}

/**
 * Guard to ensure we only emit the relayer status warning once.
 */
let relayerStatusWarningEmitted = false

/**
 * Loads StarkNet implementation of tBTC cross-chain contracts.
 * Now supports balance queries with deployed tBTC contracts and enhanced configuration.
 *
 * @param walletAddress The StarkNet wallet address to use as deposit owner
 * @param provider StarkNet provider for blockchain interactions
 * @param chainId Optional chain ID (defaults to Sepolia)
 * @param relayerStatusUrl Optional override for the relayer's deposit-status
 *        endpoint, used to verify 409 conflicts. Falls back to
 *        `STARKNET_RELAYER_STATUS_URL` when not supplied.
 * @returns Handle to the contracts
 * @throws Error if the chain ID is unrecognized and no URL overrides are provided.
 */
export async function loadStarkNetCrossChainInterfaces(
  walletAddress: string,
  provider: StarkNetProvider,
  chainId: string = Chains.StarkNet.Sepolia,
  relayerStatusUrl?: string
): Promise<DestinationChainInterfaces> {
  if (!provider) {
    throw new Error("StarkNet provider is required")
  }

  await validateProviderChain(provider, chainId)

  // Build depositor configuration with environment variable support
  const depositorConfig: StarkNetBitcoinDepositorConfig = {
    chainId,
    relayerUrl: process.env.STARKNET_RELAYER_URL, // Optional override
    relayerStatusUrl:
      relayerStatusUrl || process.env.STARKNET_RELAYER_STATUS_URL, // Optional override
    defaultVault: process.env.STARKNET_TBTC_VAULT, // Optional override
  }

  // Create the main depositor instance
  const starkNetBitcoinDepositor = new StarkNetBitcoinDepositor(
    depositorConfig,
    "StarkNet",
    provider
  )
  if (
    !relayerStatusWarningEmitted &&
    process.env.STARKNET_RELAYER_URL &&
    !process.env.STARKNET_RELAYER_STATUS_URL &&
    !relayerStatusUrl
  ) {
    console.warn(
      "STARKNET_RELAYER_URL is set without a corresponding status URL. " +
        "Conflict-status verification will be disabled. Set " +
        "STARKNET_RELAYER_STATUS_URL or pass relayerStatusUrl to enable it."
    )
    relayerStatusWarningEmitted = true
  }

  // Set the deposit owner
  starkNetBitcoinDepositor.setDepositOwner(StarkNetAddress.from(walletAddress))

  const tokenContract = Object.prototype.hasOwnProperty.call(
    TBTC_CONTRACT_ADDRESSES,
    chainId
  )
    ? TBTC_CONTRACT_ADDRESSES[chainId]
    : undefined
  if (!tokenContract) {
    throw new Error(`No tBTC contract address for chain ${chainId}`)
  }

  const tokenConfig: StarkNetTBTCTokenConfig = {
    chainId,
    tokenContract,
  }

  const starkNetTbtcToken = new StarkNetTBTCToken(tokenConfig, provider)

  return {
    destinationChainBitcoinDepositor: starkNetBitcoinDepositor,
    destinationChainTbtcToken: starkNetTbtcToken,
  }
}

/**
 * @deprecated Use loadStarkNetCrossChainInterfaces instead
 */
export const loadStarkNetCrossChainContracts = loadStarkNetCrossChainInterfaces

async function validateProviderChain(
  provider: StarkNetProvider,
  expectedChainId: string
): Promise<void> {
  const providerChainId = await resolveProviderChainId(provider)
  if (providerChainId !== normalizeStarkNetChainId(expectedChainId)) {
    throw new Error(
      `StarkNet provider chain mismatch: expected ${expectedChainId}, got ${providerChainId}`
    )
  }
}

async function resolveProviderChainId(
  provider: StarkNetProvider
): Promise<string> {
  if ("getChainId" in provider && typeof provider.getChainId === "function") {
    return normalizeStarkNetChainId(await provider.getChainId())
  }

  const nestedProvider = (provider as any).provider
  if (
    nestedProvider &&
    typeof nestedProvider === "object" &&
    "getChainId" in nestedProvider &&
    typeof nestedProvider.getChainId === "function"
  ) {
    return normalizeStarkNetChainId(await nestedProvider.getChainId())
  }

  throw new Error("StarkNet provider must expose getChainId")
}

function normalizeStarkNetChainId(chainId: string): string {
  const aliases: Record<string, string> = {
    SN_MAIN: Chains.StarkNet.Mainnet,
    SN_SEPOLIA: Chains.StarkNet.Sepolia,
    SN_GOERLI: Chains.StarkNet.Sepolia,
  }

  return aliases[chainId] || chainId.toLowerCase()
}
