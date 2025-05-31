import { AnchorProvider } from "@coral-xyz/anchor"
import { DestinationChainInterfaces } from "../contracts"

import { SolanaDepositorInterface } from "./solana-depositor-interface"
import { SolanaTBTCToken } from "./solana-tbtc-token"
import { SolanaAddress } from "./address"

/**
 * Loads Solana implementation of tBTC cross-chain programs using
 * an AnchorProvider (which includes the connection and the wallet).
 *
 * @param solanaProvider Anchor provider for Solana. Must include both `connection` and `wallet`.
 * @param genesisHash The expected Solana genesis hash (from `Chains.Solana.*`).
 * @returns Handle to the cross-chain programs for the TBTC interface on Solana.
 * @throws If the connection's genesis hash does not match the expected `genesisHash`.
 */
export async function loadSolanaCrossChainPrograms(
  solanaProvider: AnchorProvider
): Promise<DestinationChainInterfaces> {
  if (!solanaProvider.wallet || !solanaProvider.wallet.publicKey) {
    throw new Error("No connected wallet found in the provided AnchorProvider.")
  }

  const solanaDepositorInterface = new SolanaDepositorInterface()
  solanaDepositorInterface.setDepositOwner(
    SolanaAddress.from(solanaProvider.wallet.publicKey.toBase58())
  )

  // Now instantiate your TBTC token handle, passing the provider:
  const solanaTbtcToken = new SolanaTBTCToken(solanaProvider)

  return {
    destinationChainBitcoinDepositor: solanaDepositorInterface,
    destinationChainTbtcToken: solanaTbtcToken,
  }
}
