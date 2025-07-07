export type WormholeChains = {
  l1ChainId: number
  l2ChainId: number
}

/**
 * Returns Wormhole L1 and L2 chain IDs for the given network.
 * Source: https://docs.wormhole.com/wormhole/reference/constants#chain-ids
 * @param network Network name.
 */
export function getWormholeChains(network: string): WormholeChains {
  let l1ChainId: number
  let l2ChainId: number

  switch (network) {
    case "mainnet":
      l1ChainId = 2 // L1 Ethereum mainnet
      l2ChainId = 21 // L2 Sui mainnet
      break
    case "sepolia":
      l1ChainId = 10002 // L1 Ethereum Sepolia testnet
      l2ChainId = 21 // L2 Sui (same chain ID for mainnet and testnet)
      break
    default:
      throw new Error("Unsupported network")
  }

  return { l1ChainId, l2ChainId }
}
