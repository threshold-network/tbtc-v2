import { AnchorProvider } from "@coral-xyz/anchor"
import { Chains, DestinationChainInterfaces } from "../contracts"

import { SolanaDepositorInterface } from "./solana-depositor-interface"
import { SolanaTBTCToken } from "./solana-tbtc-token"
import { SolanaAddress } from "./address"

export * from "./address"
export * from "./extra-data-encoder"

/**
 * Loads Solana implementation of tBTC cross-chain interfaces using
 * an AnchorProvider (which includes the connection and the wallet).
 *
 * @param solanaProvider Anchor provider for Solana. Must include both `connection` and `wallet`.
 * @param genesisHash The expected Solana genesis hash (from `Chains.Solana.*`).
 * @returns Handle to the cross-chain interfaces for the TBTC interface on Solana.
 * @throws If the connection's genesis hash does not match the expected `genesisHash`.
 */
export async function loadSolanaCrossChainInterfaces(
  solanaProvider: AnchorProvider,
  genesisHash: Chains.Solana
): Promise<DestinationChainInterfaces> {
  if (!solanaProvider.wallet || !solanaProvider.wallet.publicKey) {
    throw new Error("No connected wallet found in the provided AnchorProvider.")
  }

  const providerGenesisHash = await solanaProvider.connection.getGenesisHash()
  if (providerGenesisHash !== genesisHash) {
    throw new Error(
      `Solana provider genesis hash mismatch: expected ${genesisHash}, got ${providerGenesisHash}`
    )
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
