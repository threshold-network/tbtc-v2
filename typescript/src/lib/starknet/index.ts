import { L2CrossChainContracts } from "../contracts"
import { StarkNetDepositorInterface } from "./starknet-depositor-interface"
import { StarkNetTBTCToken, StarkNetTBTCTokenConfig } from "./starknet-tbtc-token"
import { StarkNetAddress } from "./address"
import { StarkNetProvider } from "./types"
import { Chains } from "../contracts/chain"

export * from "./address"
export * from "./extra-data-encoder"
export * from "./starknet-depositor-interface"
export * from "./starknet-depositor"
export * from "./starknet-tbtc-token"
export * from "./types"
export * from "./abi"

/**
 * Contract addresses for deployed tBTC contracts on StarkNet
 */
const TBTC_CONTRACT_ADDRESSES: Record<string, string> = {
  [Chains.StarkNet.Mainnet]: "0x04a909347487d909a6629b56880e6e03ad3859e772048c4481f3fba88ea02c32f",
  [Chains.StarkNet.Sepolia]: "0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276"
}

/**
 * Loads StarkNet implementation of tBTC cross-chain contracts.
 * Now supports balance queries with deployed tBTC contracts.
 *
 * @param walletAddress The StarkNet wallet address to use as deposit owner
 * @param provider Optional StarkNet provider for balance queries
 * @param chainId Optional chain ID (defaults to Sepolia)
 * @returns Handle to the contracts
 */
export async function loadStarkNetCrossChainContracts(
  walletAddress: string,
  provider?: StarkNetProvider,
  chainId: string = Chains.StarkNet.Sepolia
): Promise<L2CrossChainContracts> {
  const starkNetDepositorInterface = new StarkNetDepositorInterface()
  starkNetDepositorInterface.setDepositOwner(
    StarkNetAddress.from(walletAddress)
  )

  // Create token instance based on whether provider is available
  let starkNetTbtcToken: StarkNetTBTCToken
  
  if (provider) {
    // Provider available - create full implementation with balance queries
    const tokenContract = TBTC_CONTRACT_ADDRESSES[chainId]
    if (!tokenContract) {
      throw new Error(`No tBTC contract address for chain ${chainId}`)
    }
    
    const config: StarkNetTBTCTokenConfig = {
      chainId,
      tokenContract
    }
    
    starkNetTbtcToken = new StarkNetTBTCToken(config, provider)
  } else {
    // No provider - create interface-only implementation
    // This maintains backward compatibility
    const mockConfig: StarkNetTBTCTokenConfig = {
      chainId,
      tokenContract: "0x0" // Placeholder
    }
    
    // Create a mock provider that throws errors
    const mockProvider = {
      getChainId: () => Promise.resolve(chainId)
    } as any
    
    starkNetTbtcToken = new StarkNetTBTCToken(mockConfig, mockProvider)
  }

  return {
    l2BitcoinDepositor: starkNetDepositorInterface,
    l2TbtcToken: starkNetTbtcToken,
  }
}