import {
  chainIdFromSigner,
  EthereumSigner,
} from "../ethereum"
import { SeiTBTCToken } from "./l2-tbtc-token"
import { Chains, DestinationChainInterfaces } from "../contracts"

export * from "./l2-tbtc-token"

/**
 * Loads Sei implementation of tBTC cross-chain contracts.
 * Sei follows the Starknet pattern with L1BTCDepositorNttWithExecutor on
 * Ethereum L1 and only the L2TBTC token on Sei. An offchain relayer bot
 * handles the deposit bridging logic.
 * 
 * @param signer Signer that should be attached to the Sei contracts.
 * @param chainId Sei chain ID.
 * @returns Handle to the Sei tBTC token contract.
 * @throws Throws an error if the signer's Sei chain ID is other than
 *         the one used to load contracts.
 */
export async function loadSeiCrossChainInterfaces(
  signer: EthereumSigner,
  chainId: Chains.Sei
): Promise<DestinationChainInterfaces> {
  const signerChainId = await chainIdFromSigner(signer)
  if (signerChainId !== chainId) {
    throw new Error(
      "Signer uses different chain than Sei cross-chain contracts"
    )
  }

  const destinationChainTbtcToken = new SeiTBTCToken(
    { signerOrProvider: signer },
    chainId
  )

  // For Sei (Starknet pattern), there's no on-chain depositor on L2.
  // The offchain relayer bot handles deposits using the L1BTCDepositorNttWithExecutor
  // on Ethereum L1.
  return {
    destinationChainTbtcToken,
    destinationChainBitcoinDepositor: {} as any, // Not used in Starknet pattern
  }
}

// Backward compatibility alias
/**
 * @deprecated Use loadSeiCrossChainInterfaces instead
 */
export const loadSeiCrossChainContracts = loadSeiCrossChainInterfaces

