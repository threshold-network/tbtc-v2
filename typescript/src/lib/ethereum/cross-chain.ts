import {
  ChainMappings,
  Chains,
  CrossChainContractsLoader,
  DestinationChainName,
} from "../contracts"
import { EthereumL1BitcoinDepositor } from "./l1-bitcoin-depositor"
import { EthereumL1BitcoinRedeemer } from "./l1-bitcoin-redeemer"
import { chainIdFromSigner, EthereumSigner } from "./index"

// Re-export cross-chain classes for backward compatibility. These were
// previously exported from the barrel (index.ts) but are separated to
// avoid pulling in chain-specific dependencies (solana, starknet, etc.)
// into the /core subpath.
export * from "./l1-bitcoin-depositor"
export * from "./l1-bitcoin-redeemer"

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
