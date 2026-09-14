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
import { normalizeStarkNetChainId } from "./chain-id"

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
    "0x04a909347487d909a6629b56880e6e03ad3859e772048c4481f3fba88ea02c32", // TODO: verify against deployed StarkNet mainnet tBTC contract
  [Chains.StarkNet.Sepolia]:
    "0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276",
  // Test chain ID
  ["0x534e5f544553544e4554"]:
    "0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276", // Using Sepolia address for tests
}

// Validate contract addresses shape at load time (0x + 64 hex characters)
for (const [chain, address] of Object.entries(TBTC_CONTRACT_ADDRESSES)) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(address)) {
    throw new Error(
      `Invalid tBTC contract address for chain ${chain}: expected 0x followed by 64 hex characters, got ${address}`
    )
  }
}

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

  const normalizedChainId = normalizeStarkNetChainId(chainId)

  await validateProviderChain(provider, normalizedChainId)

  // Build depositor configuration with environment variable support
  const depositorConfig: StarkNetBitcoinDepositorConfig = {
    chainId: normalizedChainId,
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
    process.env.STARKNET_RELAYER_URL &&
    !process.env.STARKNET_RELAYER_STATUS_URL &&
    !relayerStatusUrl
  ) {
    console.warn(
      "STARKNET_RELAYER_URL is set without a corresponding status URL. " +
        "Conflict-status verification will be disabled. Set " +
        "STARKNET_RELAYER_STATUS_URL or pass relayerStatusUrl to enable it."
    )
  }

  // Set the deposit owner
  starkNetBitcoinDepositor.setDepositOwner(StarkNetAddress.from(walletAddress))

  const tokenContract = Object.prototype.hasOwnProperty.call(
    TBTC_CONTRACT_ADDRESSES,
    normalizedChainId
  )
    ? TBTC_CONTRACT_ADDRESSES[normalizedChainId]
    : undefined
  if (!tokenContract) {
    throw new Error(`No tBTC contract address for chain ${normalizedChainId}`)
  }

  const tokenConfig: StarkNetTBTCTokenConfig = {
    chainId: normalizedChainId,
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

/**
 * Validates that the connected StarkNet provider's own chain ID matches the
 * expected chain ID for this depositor, so a caller cannot silently connect
 * a wallet on the wrong network.
 * @param provider The StarkNet provider to validate.
 * @param expectedChainId The chain ID the provider is expected to be on.
 * @returns Resolves when the provider's chain ID matches; never resolves a value.
 * @throws Error if the provider's chain ID does not match.
 */
export async function validateProviderChain(
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

/**
 * Resolves the chain ID a StarkNet provider is currently connected to.
 * @param provider The StarkNet provider (`Provider` or `Account`).
 * @returns The provider's normalized chain ID.
 * @throws Error if the provider does not expose `getChainId`.
 */
export async function resolveProviderChainId(
  provider: StarkNetProvider
): Promise<string> {
  if ("getChainId" in provider && typeof provider.getChainId === "function") {
    return normalizeStarkNetChainId(await provider.getChainId())
  }

  throw new Error("StarkNet provider must expose getChainId")
}
