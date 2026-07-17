import { Chains, TBTCContracts } from "../contracts"

import { EthereumBridge } from "./bridge"
import { EthereumWalletRegistry } from "./wallet-registry"
import { EthereumTBTCToken } from "./tbtc-token"
import { EthereumTBTCVault } from "./tbtc-vault"
import { connectEvm, EthereumSigner } from "./evm-connection"

export * from "./address"
export * from "./bridge"
export * from "./depositor-proxy"
export * from "./evm-connection"
export * from "./tbtc-token"
export * from "./tbtc-vault"
export * from "./wallet-registry"

// The `adapter` module should not be re-exported directly as it
// contains low-level contract integration code. Re-export only components
// that are relevant for `lib/ethereum` clients.
export { EthereumContractConfig } from "./adapter"

/**
 * Loads Ethereum implementation of tBTC core contracts for the given Ethereum
 * chain ID and attaches the given signer there.
 * @param signer Signer that should be attached to tBTC contracts.
 * @param chainId Ethereum chain ID.
 * @returns Handle to tBTC core contracts.
 * @throws Throws an error if the signer's Ethereum chain ID is other than
 *         the one used to load tBTC contracts.
 */
export async function loadEthereumCoreContracts(
  signer: EthereumSigner,
  chainId: Chains.Ethereum
): Promise<TBTCContracts> {
  // Normalize the signer once; every contract handle constructed here reuses
  // the same connection.
  const connection = await connectEvm(signer)
  if (connection.chainId !== chainId) {
    throw new Error("Signer uses different chain than Ethereum core contracts")
  }

  const bridge = new EthereumBridge({ signerOrProvider: connection }, chainId)
  const tbtcToken = new EthereumTBTCToken(
    { signerOrProvider: connection },
    chainId
  )
  const tbtcVault = new EthereumTBTCVault(
    { signerOrProvider: connection },
    chainId
  )
  const walletRegistry = new EthereumWalletRegistry(
    { signerOrProvider: connection },
    chainId
  )

  return {
    bridge,
    tbtcToken,
    tbtcVault,
    walletRegistry,
  }
}
