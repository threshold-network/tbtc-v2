import {
  chainIdFromSigner,
  ethereumAddressFromSigner,
  EthereumSigner,
} from "../ethereum"
import { ArbitrumL2BitcoinDepositor } from "./l2-bitcoin-depositor"
import { ArbitrumL2TBTCToken } from "./l2-tbtc-token"
import { Chains, DestinationChainInterfaces } from "../contracts"

export * from "./l2-bitcoin-depositor"
export * from "./l2-tbtc-token"

/**
 * Loads Arbitrum implementation of tBTC cross-chain contracts for the given Arbitrum
 * chain ID and attaches the given signer there.
 * @param signer Signer that should be attached to the contracts.
 * @param chainId Arbitrum chain ID.
 * @returns Handle to the contracts.
 * @throws Throws an error if the signer's Arbitrum chain ID is other than
 *         the one used to load contracts.
 */
export async function loadArbitrumCrossChainContracts(
  signer: EthereumSigner,
  chainId: Chains.Arbitrum
): Promise<DestinationChainInterfaces> {
  const signerChainId = await chainIdFromSigner(signer)
  if (signerChainId !== chainId) {
    throw new Error(
      "Signer uses different chain than Arbitrum cross-chain contracts"
    )
  }

  const l2BitcoinDepositor = new ArbitrumL2BitcoinDepositor(
    { signerOrProvider: signer },
    chainId
  )
  l2BitcoinDepositor.setDepositOwner(await ethereumAddressFromSigner(signer))

  const l2TbtcToken = new ArbitrumL2TBTCToken(
    { signerOrProvider: signer },
    chainId
  )

  return {
    destinationChainBitcoinDepositor: l2BitcoinDepositor,
    destinationChainTbtcToken: l2TbtcToken,
  }
}
