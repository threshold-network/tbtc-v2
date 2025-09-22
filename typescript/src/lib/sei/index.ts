import { chainIdFromSigner, EthereumSigner } from "../ethereum"
// Note: Sei uses L1 NTT depositor for deposits, no separate L2 depositor needed
import { SeiTBTCToken } from "./l2-tbtc-token"
import { Chains } from "../contracts"
import { SeiL1BTCDepositorNttWithExecutor } from "./l1-bitcoin-depositor-ntt-executor"

// Note: L2 depositor exports removed - Sei uses L1 NTT depositor only
export * from "./l2-tbtc-token"
export * from "./l1-bitcoin-depositor-ntt-executor"
export * from "./extra-data-encoder"
export * from "./types"

/**
 * Loads Sei implementation of tBTC cross-chain contracts for the given Sei
 * chain ID and attaches the given signer there.
 *
 * Note: Sei uses a different architecture where deposits are handled on L1
 * via L1BTCDepositorNttWithExecutor and bridged to Sei. This function only
 * loads the L2 tBTC token contract.
 *
 * @param signer Signer that should be attached to the contracts.
 * @param chainId Sei chain ID.
 * @returns Handle to the Sei tBTC token contract.
 * @throws Throws an error if the signer's Sei chain ID is other than
 *         the one used to load contracts.
 */
export async function loadSeiCrossChainInterfaces(
  signer: EthereumSigner,
  chainId: Chains.Sei
): Promise<{ destinationChainTbtcToken: SeiTBTCToken }> {
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

  return {
    destinationChainTbtcToken,
  }
}

/**
 * Loads Sei L1 NTT-based depositor for Ethereum mainnet/testnet deployment
 * @param signer Ethereum signer for L1 operations
 * @param chainId Ethereum chain ID (mainnet or sepolia)
 * @returns Handle to the L1 NTT depositor with executor
 */
export async function loadSeiL1NttDepositor(
  signer: EthereumSigner,
  chainId: Chains.Ethereum
): Promise<SeiL1BTCDepositorNttWithExecutor> {
  const signerChainId = await chainIdFromSigner(signer)
  if (signerChainId !== chainId) {
    throw new Error("Signer uses different chain than expected Ethereum chain")
  }

  const l1Depositor = new SeiL1BTCDepositorNttWithExecutor(
    { signerOrProvider: signer },
    chainId
  )

  return l1Depositor
}

// Backward compatibility alias
/**
 * @deprecated Use loadSeiCrossChainInterfaces instead
 */
export const loadSeiCrossChainContracts = loadSeiCrossChainInterfaces
