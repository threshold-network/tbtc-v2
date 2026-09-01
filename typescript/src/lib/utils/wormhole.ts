import { Chains } from "../contracts"

/**
 * Mapping of chain identifiers to their corresponding Wormhole chain IDs.
 * Use these constants instead of hardcoded chain IDs when configuring Wormhole
 * routes and Native Token Transfer (NTT) peers.
 *
 * @example
 * ```typescript
 * import { WORMHOLE_CHAIN_IDS, Chains } from "@keep-network/tbtc-v2"
 *
 * const baseWormholeChain = WORMHOLE_CHAIN_IDS[Chains.Base.BaseSepolia]
 * ```
 */
export const WORMHOLE_CHAIN_IDS = {
  [Chains.Ethereum.Sepolia]: 10002,
  [Chains.Ethereum.Mainnet]: 2,
  [Chains.Arbitrum.ArbitrumSepolia]: 10003,
  [Chains.Arbitrum.Arbitrum]: 23,
  [Chains.Base.BaseSepolia]: 10004,
  [Chains.Base.Base]: 30,
  [Chains.Optimism.OptimismSepolia]: 10005,
  [Chains.Optimism.Optimism]: 24,
  [Chains.Solana.Devnet]: 1,
  [Chains.Solana.Solana]: 1,
  [Chains.Sui.Testnet]: 21,
  [Chains.Sui.Mainnet]: 21,
  [Chains.Sui.Devnet]: 21,
} as const

/**
 * EVM-only subset of WORMHOLE_CHAIN_IDS scoped to NTT migration destinations.
 *
 * Non-EVM chains (Solana, Sui) are intentionally omitted because NTT
 * fixed-destination depositors are only used for EVM destination chains in
 * the current migration.
 */
export const WORMHOLE_NTT_CHAIN_IDS = {
  Ethereum: {
    Sepolia: WORMHOLE_CHAIN_IDS[Chains.Ethereum.Sepolia],
    Mainnet: WORMHOLE_CHAIN_IDS[Chains.Ethereum.Mainnet],
  },
  Arbitrum: {
    ArbitrumSepolia: WORMHOLE_CHAIN_IDS[Chains.Arbitrum.ArbitrumSepolia],
    Arbitrum: WORMHOLE_CHAIN_IDS[Chains.Arbitrum.Arbitrum],
  },
  Base: {
    BaseSepolia: WORMHOLE_CHAIN_IDS[Chains.Base.BaseSepolia],
    Base: WORMHOLE_CHAIN_IDS[Chains.Base.Base],
  },
  Optimism: {
    OptimismSepolia: WORMHOLE_CHAIN_IDS[Chains.Optimism.OptimismSepolia],
    Optimism: WORMHOLE_CHAIN_IDS[Chains.Optimism.Optimism],
  },
} as const
