import { Chains } from "../contracts/chain"

/**
 * Normalizes a StarkNet chain ID to its canonical hex form.
 *
 * Accepts either a human-readable alias (`SN_MAIN`, `SN_SEPOLIA`) or an
 * already-canonical hex chain ID, and returns the canonical lowercase hex
 * form in both cases. Unrecognized input is lowercased and passed through
 * unchanged (intentionally not rejected here) - downstream chain-ID
 * recognition (e.g. `hasDefaultStarkNetRelayerRoute`) is responsible for
 * rejecting values that don't correspond to a real chain.
 *
 * This is the single source of truth for chain-ID normalization, shared by
 * both {@link loadStarkNetCrossChainInterfaces} (via `./index`) and
 * {@link StarkNetBitcoinDepositor}'s constructor (via `./starknet-depositor`),
 * so the two public entry points can never disagree on which chain IDs are
 * valid.
 *
 * @param chainId The StarkNet chain ID or alias.
 * @returns The canonical lowercase hex chain ID.
 */
export function normalizeStarkNetChainId(chainId: string): string {
  const aliases: Record<string, string> = {
    SN_MAIN: Chains.StarkNet.Mainnet,
    SN_SEPOLIA: Chains.StarkNet.Sepolia,
  }

  return Object.prototype.hasOwnProperty.call(aliases, chainId)
    ? aliases[chainId]
    : chainId.toLowerCase()
}
