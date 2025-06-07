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
}

/**
 * Loads StarkNet implementation of tBTC cross-chain contracts.
 * Now supports balance queries with deployed tBTC contracts and enhanced configuration.
 *
 * @param walletAddress The StarkNet wallet address to use as deposit owner
 * @param provider Optional StarkNet provider for blockchain interactions
 * @param chainId Optional chain ID (defaults to Sepolia)
 * @returns Handle to the contracts
 */
export async function loadStarkNetCrossChainInterfaces(
  walletAddress: string,
  provider?: StarkNetProvider,
  chainId: string = Chains.StarkNet.Sepolia
): Promise<DestinationChainInterfaces> {
  // Build depositor configuration with environment variable support
  const depositorConfig: StarkNetBitcoinDepositorConfig = {
    chainId,
    relayerUrl: process.env.STARKNET_RELAYER_URL, // Optional override
    defaultVault: process.env.STARKNET_TBTC_VAULT, // Optional override
  }

  // Create provider if not provided (for testing/backward compatibility)
  const actualProvider = provider || createMockProvider()

  // Create the main depositor instance
  const starkNetBitcoinDepositor = new StarkNetBitcoinDepositor(
    depositorConfig,
    "StarkNet",
    actualProvider
  )

  // Set the deposit owner
  starkNetBitcoinDepositor.setDepositOwner(StarkNetAddress.from(walletAddress))

  // Create token instance
  let starkNetTbtcToken: StarkNetTBTCToken

  if (provider) {
    // Provider available - create full implementation with balance queries
    const tokenContract = TBTC_CONTRACT_ADDRESSES[chainId]
    if (!tokenContract) {
      throw new Error(`No tBTC contract address for chain ${chainId}`)
    }

    const tokenConfig: StarkNetTBTCTokenConfig = {
      chainId,
      tokenContract,
    }

    starkNetTbtcToken = new StarkNetTBTCToken(tokenConfig, provider)
  } else {
    // No provider - create interface-only implementation
    // This maintains backward compatibility for tests
    const mockConfig: StarkNetTBTCTokenConfig = {
      chainId,
      tokenContract: "0x0", // Placeholder
    }

    // Create a mock provider that throws errors
    const mockProvider = {
      getChainId: () => Promise.resolve(chainId),
    } as any

    starkNetTbtcToken = new StarkNetTBTCToken(mockConfig, mockProvider)
  }

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
 * Creates a mock StarkNet provider for testing purposes
 * @returns A mock StarkNet provider with minimal interface
 */
function createMockProvider(): StarkNetProvider {
  return {
    getChainId: () => Promise.resolve("0x534e5f5345504f4c4941"),
    // Add minimal provider interface for testing
  } as any
}
