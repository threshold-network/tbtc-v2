import { L2CrossChainContracts } from "../contracts"
import { StarkNetDepositorInterface } from "./starknet-depositor-interface"
import { StarkNetTBTCToken } from "./starknet-tbtc-token"
import { StarkNetAddress } from "./address"

export * from "./address"
export * from "./extra-data-encoder"
export * from "./starknet-depositor-interface"
export * from "./starknet-tbtc-token"

/**
 * Loads StarkNet implementation of tBTC cross-chain contracts.
 * Since StarkNet doesn't have L2 contracts, this returns interface-only
 * implementations that throw errors for unsupported operations.
 *
 * @param walletAddress The StarkNet wallet address to use as deposit owner
 * @returns Handle to the contracts
 */
export async function loadStarkNetCrossChainContracts(
  walletAddress: string
): Promise<L2CrossChainContracts> {
  const starkNetDepositorInterface = new StarkNetDepositorInterface()
  starkNetDepositorInterface.setDepositOwner(
    StarkNetAddress.from(walletAddress)
  )

  const starkNetTbtcToken = new StarkNetTBTCToken()

  return {
    l2BitcoinDepositor: starkNetDepositorInterface,
    l2TbtcToken: starkNetTbtcToken,
  }
}
