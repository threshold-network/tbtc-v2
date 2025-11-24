import { Chains } from "../contracts"

/**
 * Mapping of chain identifiers to their corresponding Wormhole chain IDs.
 * Use these constants instead of hardcoded chain IDs when encoding destination
 * receivers for NTT (Native Token Transfer) bridges.
 *
 * @example
 * ```typescript
 * import { WORMHOLE_CHAIN_IDS, Chains, encodeDestinationReceiver } from "@keep-network/tbtc-v2"
 *
 * const encoded = encodeDestinationReceiver(
 *   WORMHOLE_CHAIN_IDS[Chains.Sei.Testnet],
 *   "0x1234567890123456789012345678901234567890"
 * )
 * ```
 */
export const WORMHOLE_CHAIN_IDS = {
  [Chains.Ethereum.Sepolia]: 10002,
  [Chains.Ethereum.Mainnet]: 2,
  [Chains.Sei.Testnet]: 40,
  [Chains.Sei.Mainnet]: 40,
}
