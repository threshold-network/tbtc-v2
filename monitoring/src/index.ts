import {
  ElectrumClient,
  loadEthereumCoreContracts,
  TBTC,
} from "@keep-network/tbtc-v2.ts"
import { providers } from "ethers"

import { Manager as SystemEventManager } from "./system-event"
import { DepositMonitor } from "./deposit-monitor"
import { DiscordReceiver } from "./discord-receiver"
import { SentryReceiver } from "./sentry-receiver"
import {
  SupplyMonitorFilePersistence,
  SystemEventFilePersistence,
} from "./file-persistence"
import { context } from "./context"
import { MintingMonitor } from "./minting-monitor"
import { WalletMonitor } from "./wallet-monitor"
import { SupplyMonitor } from "./supply-monitor"
import { RedemptionMonitor } from "./redemption-monitor"
import { RedemptionChain } from "./redemption-chain"
import { RedemptionLifecycleMonitor } from "./redemption-lifecycle-monitor"

import type {
  Monitor as SystemEventMonitor,
  Receiver as SystemEventReceiver,
} from "./system-event"

async function setupSDK(): Promise<TBTC> {
  const provider = new providers.JsonRpcProvider(context.ethereumUrl)
  const chainId = context.ethereumEnvironmentMapping[context.environment]
  const tbtcContracts = await loadEthereumCoreContracts(provider, chainId)

  const bitcoinNetwork = context.bitcoinEnvironmentMapping[context.environment]
  const btcClient = ElectrumClient.fromUrl(context.electrumUrl)
  if ((await btcClient.getNetwork()) !== bitcoinNetwork) {
    throw new Error("Bitcoin network mismatch")
  }

  return TBTC.initializeCustom(tbtcContracts, btcClient)
}

async function setupMonitoring(sdk: TBTC): Promise<SystemEventManager> {
  const { tbtcContracts, bitcoinClient } = sdk

  const monitors: SystemEventMonitor[] = [
    new DepositMonitor(tbtcContracts.bridge),
    new MintingMonitor(
      tbtcContracts.bridge,
      tbtcContracts.tbtcVault,
      bitcoinClient
    ),
    new SupplyMonitor(
      tbtcContracts.tbtcToken,
      new SupplyMonitorFilePersistence()
    ),
    new WalletMonitor(tbtcContracts.bridge),
    new RedemptionMonitor(tbtcContracts.bridge),
    new RedemptionLifecycleMonitor(
      new RedemptionChain(
        tbtcContracts.bridge,
        new providers.JsonRpcProvider(context.ethereumUrl)
      ),
      context.redemptionTimeoutWarningSeconds
    ),
  ]

  const receivers: SystemEventReceiver[] = ((): SystemEventReceiver[] => {
    const registered: SystemEventReceiver[] = []

    if (context.discordWebhookUrl) {
      // eslint-disable-next-line no-console
      console.log("registered Discord receiver")
      registered.push(new DiscordReceiver(context.discordWebhookUrl))
    }

    if (context.sentryDsn) {
      // eslint-disable-next-line no-console
      console.log("registered Sentry receiver")
      registered.push(new SentryReceiver(context.sentryDsn))
    }

    return registered
  })()

  return new SystemEventManager(
    monitors,
    receivers,
    new SystemEventFilePersistence()
  )
}

async function setup(): Promise<SystemEventManager> {
  const sdk = await setupSDK()
  return setupMonitoring(sdk)
}

setup().then((manager) => {
  // eslint-disable-next-line no-console
  console.log("setup completed; triggering monitoring manager")

  manager.trigger().then((report) => {
    // eslint-disable-next-line default-case
    switch (report.status) {
      case "success": {
        // eslint-disable-next-line no-console
        console.log(report)
        break
      }
      case "failure": {
        // eslint-disable-next-line no-console
        console.error(report)
        break
      }
    }
  })
})
