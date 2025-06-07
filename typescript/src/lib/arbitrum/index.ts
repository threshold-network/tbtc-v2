import {
  chainIdFromSigner,
  ethereumAddressFromSigner,
  EthereumSigner,
} from "../ethereum"
import { ArbitrumBitcoinDepositor } from "./l2-bitcoin-depositor"
import { ArbitrumTBTCToken } from "./l2-tbtc-token"
import { Chains, DestinationChainInterfaces } from "../contracts"

export * from "./l2-bitcoin-depositor"
export * from "./l2-tbtc-token"

/**
 * Loads Arbitrum implementation of tBTC cross-chain interfaces for the given Arbitrum
 * chain ID and attaches the given signer there.
 * @param signer Signer that should be attached to the contracts.
 * @param chainId Arbitrum chain ID.
 * @returns Handle to the contracts.
 * @throws Throws an error if the signer's Arbitrum chain ID is other than
 *         the one used to load contracts.
 */
export async function loadArbitrumCrossChainInterfaces(
  signer: EthereumSigner,
  chainId: Chains.Arbitrum
): Promise<DestinationChainInterfaces> {
  const signerChainId = await chainIdFromSigner(signer)
  if (signerChainId !== chainId) {
    throw new Error(
      "Signer uses different chain than Arbitrum cross-chain contracts"
    )
  }

  const destinationChainBitcoinDepositor = new ArbitrumBitcoinDepositor(
    { signerOrProvider: signer },
    chainId
  )
  destinationChainBitcoinDepositor.setDepositOwner(
    await ethereumAddressFromSigner(signer)
  )

  const destinationChainTbtcToken = new ArbitrumTBTCToken(
    { signerOrProvider: signer },
    chainId
  )

  return {
    destinationChainBitcoinDepositor,
    destinationChainTbtcToken,
  }
}

/**
 * @deprecated Use loadArbitrumCrossChainInterfaces instead
 */
export const loadArbitrumCrossChainContracts = loadArbitrumCrossChainInterfaces
