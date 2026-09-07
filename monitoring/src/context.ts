import { BitcoinNetwork, Chains } from "@keep-network/tbtc-v2.ts"

// List of environment variables used by the monitoring package.
const {
  ENVIRONMENT,
  ETHEREUM_URL,
  ELECTRUM_URL,
  LARGE_DEPOSIT_THRESHOLD_SAT,
  LARGE_REDEMPTION_THRESHOLD_SAT,
  REDEMPTION_TIMEOUT_WARNING_SECONDS,
  DATA_DIR_PATH,
  SENTRY_DSN,
  DISCORD_WEBHOOK_URL,
} = process.env

export enum Environment {
  Mainnet = "mainnet",
  Testnet = "testnet",
}

const ethereumEnvironmentMapping = {
  [Environment.Mainnet]: Chains.Ethereum.Mainnet,
  [Environment.Testnet]: Chains.Ethereum.Sepolia,
}

const bitcoinEnvironmentMapping = {
  [Environment.Mainnet]: BitcoinNetwork.Mainnet,
  [Environment.Testnet]: BitcoinNetwork.Testnet,
}

const resolveEnvironment = () => {
  switch (ENVIRONMENT) {
    case Environment.Mainnet: {
      return Environment.Mainnet
    }
    case Environment.Testnet: {
      return Environment.Testnet
    }
    default: {
      throw new Error(
        "unknown environment; ENVIRONMENT env variable must be either " +
          `[${Environment.Mainnet}] or [${Environment.Testnet}]`
      )
    }
  }
}

const resolveEthereumUrl = () => {
  if (!ETHEREUM_URL) {
    throw new Error("ETHEREUM_URL env variable not set")
  }

  return ETHEREUM_URL
}

const resolveElectrumUrl = () => {
  if (!ELECTRUM_URL) {
    throw new Error("ELECTRUM_URL env variable not set")
  }

  return ELECTRUM_URL
}

export const context = {
  environment: resolveEnvironment(),
  ethereumUrl: resolveEthereumUrl(),
  electrumUrl: resolveElectrumUrl(),
  largeDepositThresholdSat: LARGE_DEPOSIT_THRESHOLD_SAT ?? 1000000000, // 10 BTC by default
  largeRedemptionThresholdSat: LARGE_REDEMPTION_THRESHOLD_SAT ?? 1000000000, // 10 BTC by default
  redemptionTimeoutWarningSeconds: Number(
    REDEMPTION_TIMEOUT_WARNING_SECONDS ?? 6 * 60 * 60
  ),
  dataDirPath: DATA_DIR_PATH ?? "./data",
  sentryDsn: SENTRY_DSN,
  discordWebhookUrl: DISCORD_WEBHOOK_URL,
  ethereumEnvironmentMapping,
  bitcoinEnvironmentMapping,
}
