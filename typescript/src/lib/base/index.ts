import { connectEvm, EthereumAddress, EthereumSigner } from "../ethereum"
import { BaseBitcoinDepositor } from "./l2-bitcoin-depositor"
import { BaseTBTCToken } from "./l2-tbtc-token"
import { Chains, DestinationChainInterfaces } from "../contracts"
import { BaseL2BitcoinRedeemer } from "./l2-bitcoin-redeemer"

export * from "./l2-bitcoin-depositor"
export * from "./l2-tbtc-token"

/**
 * Loads Base implementation of tBTC cross-chain contracts for the given Base
 * chain ID and attaches the given signer there.
 * @param signer Signer that should be attached to the contracts.
 * @param chainId Base chain ID.
 * @returns Handle to the contracts.
 * @throws Throws an error if the signer's Base chain ID is other than
 *         the one used to load contracts.
 */
export async function loadBaseCrossChainInterfaces(
  signer: EthereumSigner,
  chainId: Chains.Base
): Promise<DestinationChainInterfaces> {
  // Normalize the signer once; every contract handle constructed here reuses
  // the same connection.
  const connection = await connectEvm(signer)
  if (connection.chainId !== chainId) {
    throw new Error(
      "Signer uses different chain than Base cross-chain contracts"
    )
  }

  const destinationChainBitcoinDepositor = new BaseBitcoinDepositor(
    { signerOrProvider: connection },
    chainId
  )
  destinationChainBitcoinDepositor.setDepositOwner(
    connection.account !== undefined
      ? EthereumAddress.from(connection.account)
      : undefined
  )

  const l2BitcoinRedeemer = new BaseL2BitcoinRedeemer(
    { signerOrProvider: connection },
    chainId
  )

  const destinationChainTbtcToken = new BaseTBTCToken(
    { signerOrProvider: connection },
    chainId
  )

  return {
    destinationChainBitcoinDepositor,
    destinationChainTbtcToken,
    l2BitcoinRedeemer,
  }
}

// Backward compatibility alias
/**
 * @deprecated Use loadBaseCrossChainInterfaces instead
 */
export const loadBaseCrossChainContracts = loadBaseCrossChainInterfaces
