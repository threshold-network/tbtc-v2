import {
  chainIdFromSigner,
  ethereumAddressFromSigner,
  EthereumSigner,
} from "../ethereum"
import { BaseBitcoinDepositor } from "./l2-bitcoin-depositor"
import { BaseTBTCToken } from "./l2-tbtc-token"
import { Chains, DestinationChainInterfaces } from "../contracts"
import { BaseL2BitcoinRedeemer } from "./l2-bitcoin-redeemer"
import { EthersContractConfig } from "../ethereum/adapter-ethers"

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
  const signerChainId = await chainIdFromSigner(signer)
  if (signerChainId !== chainId) {
    throw new Error(
      "Signer uses different chain than Base cross-chain contracts"
    )
  }

  // Transitional (migration phase 2): the Base handles still run on the
  // ethers adapter while `lib/ethereum` is already on viem, so the signer is
  // force-cast to the ethers shape. Runtime behavior is unchanged for ethers
  // v5 signers - the only inputs these handles can operate on until they move
  // to the viem adapter in the next phase, when this cast is deleted.
  const signerOrProvider =
    signer as unknown as EthersContractConfig["signerOrProvider"]

  const destinationChainBitcoinDepositor = new BaseBitcoinDepositor(
    { signerOrProvider },
    chainId
  )
  destinationChainBitcoinDepositor.setDepositOwner(
    await ethereumAddressFromSigner(signer)
  )

  const l2BitcoinRedeemer = new BaseL2BitcoinRedeemer(
    { signerOrProvider },
    chainId
  )

  const destinationChainTbtcToken = new BaseTBTCToken(
    { signerOrProvider },
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
