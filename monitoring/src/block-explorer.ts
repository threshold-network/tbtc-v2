import { context, Environment } from "./context"

import type { BitcoinTxHash, Hex } from "@keep-network/tbtc-v2.ts/core"

const ethTxUrlPrefixMapping = {
  [Environment.Mainnet]: "https://etherscan.io/tx",
  [Environment.Testnet]: "https://sepolia.etherscan.io/tx",
}

export function createEthTxUrl(txHash: Hex) {
  return `${
    ethTxUrlPrefixMapping[context.environment]
  }/${txHash.toPrefixedString()}`
}

const btcTxUrlPrefixMapping = {
  [Environment.Mainnet]: "https://mempool.space/tx",
  [Environment.Testnet]: "https://mempool.space/testnet/tx",
}

export function createBtcTxUrl(txHash: BitcoinTxHash) {
  return `${btcTxUrlPrefixMapping[context.environment]}/${txHash.toString()}`
}
