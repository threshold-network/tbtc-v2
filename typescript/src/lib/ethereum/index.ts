import {
  ChainMappings,
  Chains,
  CrossChainContractsLoader,
  DestinationChainName,
  TBTCContracts,
} from "../contracts"
import { providers, Signer } from "ethers"
import { EthereumBridge } from "./bridge"
import { EthereumWalletRegistry } from "./wallet-registry"
import { EthereumTBTCToken } from "./tbtc-token"
import { EthereumTBTCVault } from "./tbtc-vault"
import { EthereumAddress } from "./address"
import { EthereumL1BitcoinDepositor } from "./l1-bitcoin-depositor"
import { EthereumL1BitcoinRedeemer } from "./l1-bitcoin-redeemer"

export * from "./address"
export * from "./bridge"
export * from "./depositor-proxy"
export * from "./l1-bitcoin-depositor"
export * from "./tbtc-token"
export * from "./tbtc-vault"
export * from "./wallet-registry"

// The `adapter` module should not be re-exported directly as it
// contains low-level contract integration code. Re-export only components
// that are relevant for `lib/ethereum` clients.
export { EthersContractConfig as EthereumContractConfig } from "./adapter"

/**
 * Represents an Ethereum signer. This type is a wrapper for Ethers-specific
 * types and can be either a Signer that can make write transactions
 * or a Provider that works only in the read-only mode.
 */
export type EthereumSigner = Signer | providers.Provider

/**
 * Resolves the chain ID from the given signer.
 * @param signer The signer whose chain ID should be resolved.
 * @returns Chain ID as a string.
 */
export async function chainIdFromSigner(
  signer: EthereumSigner
): Promise<string> {
  let chainId: number
  if (Signer.isSigner(signer)) {
    chainId = await signer.getChainId()
  } else {
    const network = await signer.getNetwork()
    chainId = network.chainId
  }

  return chainId.toString()
}

/**
 * Resolves the Ethereum address tied to the given signer. The address
 * cannot be resolved for signers that works in the read-only mode
 * @param signer The signer whose address should be resolved.
 * @returns Ethereum address or undefined for read-only signers.
 * @throws Throws an error if the address of the signer is not a proper
 *         Ethereum address.
 */
export async function ethereumAddressFromSigner(
  signer: EthereumSigner
): Promise<EthereumAddress | undefined> {
  if (Signer.isSigner(signer)) {
    return EthereumAddress.from(await signer.getAddress())
  } else {
    return undefined
  }
}

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
  const signerChainId = await chainIdFromSigner(signer)
  if (signerChainId !== chainId) {
    throw new Error("Signer uses different chain than Ethereum core contracts")
  }

  const bridge = new EthereumBridge({ signerOrProvider: signer }, chainId)
  const tbtcToken = new EthereumTBTCToken({ signerOrProvider: signer }, chainId)
  const tbtcVault = new EthereumTBTCVault({ signerOrProvider: signer }, chainId)
  const walletRegistry = new EthereumWalletRegistry(
    { signerOrProvider: signer },
    chainId
  )

  return {
    bridge,
    tbtcToken,
    tbtcVault,
    walletRegistry,
  }
}

/**
 * Creates the Ethereum implementation of tBTC cross-chain contracts loader.
 * The provided signer is attached to loaded L1 contracts. The given
 * Ethereum chain ID is used to load the L1 contracts and resolve the chain
 * mapping that provides corresponding L2 chains IDs.
 * @param signer Ethereum L1 signer.
 * @param chainId Ethereum L1 chain ID.
 * @returns Loader for tBTC cross-chain contracts.
 * @throws Throws an error if the signer's Ethereum chain ID is other than
 *         the one used to construct the loader.
 */
export async function ethereumCrossChainContractsLoader(
  signer: EthereumSigner,
  chainId: Chains.Ethereum
): Promise<CrossChainContractsLoader> {
  const signerChainId = await chainIdFromSigner(signer)
  if (signerChainId !== chainId) {
    throw new Error(
      "Signer uses different chain than Ethereum cross-chain contracts"
    )
  }

  const loadChainMapping = () =>
    ChainMappings.find((ecm) => ecm.ethereum === chainId)

  const loadL1Contracts = async (
    destinationChainName: DestinationChainName
  ) => {
    let l1BitcoinRedeemer: EthereumL1BitcoinRedeemer | null = null
    if (
      destinationChainName === "Base" ||
      destinationChainName === "Arbitrum"
    ) {
      l1BitcoinRedeemer = new EthereumL1BitcoinRedeemer(
        { signerOrProvider: signer },
        chainId,
        destinationChainName
      )
    }

    return {
      l1BitcoinDepositor: new EthereumL1BitcoinDepositor(
        { signerOrProvider: signer },
        chainId,
        destinationChainName
      ),
      l1BitcoinRedeemer,
    }
  }

  return {
    loadChainMapping,
    loadL1Contracts,
  }
}
