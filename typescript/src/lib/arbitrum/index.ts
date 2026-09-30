import { connectEvm, EthereumAddress, EthereumSigner } from "../ethereum"
import { ArbitrumBitcoinDepositor } from "./l2-bitcoin-depositor"
import { ArbitrumTBTCToken } from "./l2-tbtc-token"
import { Chains, DestinationChainInterfaces } from "../contracts"
import { ArbitrumL2BitcoinRedeemer } from "./l2-bitcoin-redeemer"

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
  // Normalize the signer once; every contract handle constructed here reuses
  // the same connection.
  const connection = await connectEvm(signer)
  if (connection.chainId !== chainId) {
    throw new Error(
      "Signer uses different chain than Arbitrum cross-chain contracts"
    )
  }

  const destinationChainBitcoinDepositor = new ArbitrumBitcoinDepositor(
    { signerOrProvider: connection },
    chainId
  )
  destinationChainBitcoinDepositor.setDepositOwner(
    connection.account !== undefined
      ? EthereumAddress.from(connection.account)
      : undefined
  )

  const l2BitcoinRedeemer = new ArbitrumL2BitcoinRedeemer(
    { signerOrProvider: connection },
    chainId
  )

  const destinationChainTbtcToken = new ArbitrumTBTCToken(
    { signerOrProvider: connection },
    chainId
  )

  return {
    destinationChainBitcoinDepositor,
    destinationChainTbtcToken,
    l2BitcoinRedeemer,
  }
}

/**
 * @deprecated Use loadArbitrumCrossChainInterfaces instead
 */
export const loadArbitrumCrossChainContracts = loadArbitrumCrossChainInterfaces
