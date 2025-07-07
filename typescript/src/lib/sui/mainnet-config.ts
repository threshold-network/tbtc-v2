/**
 * Mainnet configuration for SUI tBTC integration.
 *
 * NOTE: This is a placeholder file. Actual mainnet configuration
 * will be added once the contracts are deployed on SUI mainnet.
 */

import { SuiArtifacts } from "./index"

/**
 * Mainnet configuration for SUI tBTC integration.
 */
export const MAINNET_CONFIG: SuiArtifacts = {
  // Package ID for mainnet deployment
  packageId:
    "0x77045f1b9f811a7a8fb9ebd085b5b0c55c5cb0d1520ff55f7037f89b5da9f5f1",

  // tBTC coin type on mainnet
  // Format: {package_id}::TBTC::TBTC
  tbtcCoinType:
    "0x77045f1b9f811a7a8fb9ebd085b5b0c55c5cb0d1520ff55f7037f89b5da9f5f1::TBTC::TBTC",

  // Shared object IDs for mainnet
  receiverStateId:
    "0x164f463fdc60bbbff19c30ad9597ea7123c643d3671e9719cd982e3912176d94",
  gatewayStateId:
    "0x76eb72899418719b2db5fbc12f5fb42e93bb75f67116420f5dbf971dd31fe7f7",
  tokenStateId:
    "0x2ff31492339e06859132b8db199f640ca37a5dc8ab1713782c4372c678f2f85c",
}

/**
 * L1 Bitcoin Depositor configuration for mainnet.
 */
export const MAINNET_L1_CONFIG = {
  // Ethereum mainnet L1 Bitcoin Depositor for SUI
  // Deployed as BTCDepositorWormhole
  depositorAddress: "0xb810AbD43d8FCFD812d6FEB14fefc236E92a341A",

  // Wormhole configuration
  wormholeChainId: 21, // SUI chain ID in Wormhole
  wormholeCore: "0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B", // Mainnet Wormhole Core
  wormholeTokenBridge: "0x3ee18B2214AFF97000D974cf647E7C347E8fa585", // Mainnet Token Bridge
}

/**
 * Checks if mainnet configuration is ready for use.
 * @returns true if mainnet is configured, false otherwise
 */
export function isMainnetConfigured(): boolean {
  return (
    MAINNET_CONFIG.packageId !==
    "0x0000000000000000000000000000000000000000000000000000000000000000"
  )
}
