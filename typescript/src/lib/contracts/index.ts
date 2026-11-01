export * from "./bridge"
export * from "./chain"
export * from "./chain-event"
export * from "./chain-identifier"
export * from "./cross-chain"
export * from "./depositor-proxy"
export * from "./reservations"
export * from "./tbtc-token"
export * from "./tbtc-vault"
export * from "./wallet-registry"

import { Bridge } from "./bridge"
import { Reservations } from "./reservations"
import { TBTCToken } from "./tbtc-token"
import { TBTCVault } from "./tbtc-vault"
import { WalletRegistry } from "./wallet-registry"

/**
 * Convenience type aggregating all TBTC core contracts.
 */
export type TBTCContracts = {
  bridge: Bridge
  reservations: Reservations
  tbtcToken: TBTCToken
  tbtcVault: TBTCVault
  walletRegistry: WalletRegistry
}
