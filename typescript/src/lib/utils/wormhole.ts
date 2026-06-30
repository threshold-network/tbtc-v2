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
 *   WORMHOLE_CHAIN_IDS[Chains.Base.BaseSepolia],
 *   "0x1234567890123456789012345678901234567890"
 * )
 * ```
 */
export const WORMHOLE_CHAIN_IDS = {
  [Chains.Ethereum.Sepolia]: 10002,
  [Chains.Ethereum.Mainnet]: 2,
  [Chains.Arbitrum.ArbitrumSepolia]: 10003,
  [Chains.Arbitrum.Arbitrum]: 23,
  [Chains.Base.BaseSepolia]: 10004,
  [Chains.Base.Base]: 30,
  [Chains.Solana.Devnet]: 1,
  [Chains.Solana.Solana]: 1,
  [Chains.Sui.Testnet]: 21,
  [Chains.Sui.Mainnet]: 21,
  [Chains.Sui.Devnet]: 21,
} as const

export const WORMHOLE_NTT_CHAIN_IDS = {
  Ethereum: {
    Sepolia: 10002,
    Mainnet: 2,
  },
  Arbitrum: {
    ArbitrumSepolia: 10003,
    Arbitrum: 23,
  },
  Base: {
    BaseSepolia: 10004,
    Base: 30,
  },
  Optimism: {
    OptimismSepolia: 10005,
    Optimism: 24,
  },
  Solana: {
    Devnet: 1,
    Solana: 1,
  },
  Sui: {
    Testnet: 21,
    Mainnet: 21,
    Devnet: 21,
  },
} as const
