// Vendored from @keep-network/hardhat-local-networks-config@0.1.0-pre.4
// (https://github.com/keep-network/hardhat-local-networks-config, itself a
// fork of https://github.com/facuspagnuolo/hardhat-local-networks-config-plugin),
// which is dead upstream (4.5+ years frozen, no further releases). Vendored
// directly to drop the cross-org dependency. Licensed MIT — see ./LICENSE.
// Do not add new features here beyond what upstream published — this is a
// frozen copy, semantically identical to the published tarball
// (sha1 cc0c8ac1f5e30f33378e7451f696ab17d504ab86).
//
// Known upstream quirks, kept for parity (tracked in
// threshold-network/tbtc-v2#1146):
// - deepmerge concatenates array-valued network fields (accounts, tags,
//   deploy), duplicating them for networks declared in hardhat.config.ts.
// - For a network declared in both the project-local config and
//   ~/.hardhat/networks.json (absent from hardhat.config.ts), the home
//   per-network entry is dropped (loop order + guard interaction).
// - In the home-only merge path, the home per-network entry wins over
//   localNetworksConfig.defaultConfig — the reverse of the user-declared
//   path.
// - undefined-valued keys in hardhat.config.ts network entries overwrite
//   home-config values for the same key.
// - A malformed home/local config surfaces a raw Node error from the
//   unguarded require instead of a plugin-attributed error.
import fs from "fs"
import path from "path"
import { homedir } from "os"
import deepmerge from "deepmerge"
import { extendConfig } from "hardhat/config"
import {
  HardhatConfig,
  NetworkConfig,
  NetworksUserConfig,
  NetworkUserConfig,
  HardhatUserConfig,
} from "hardhat/types"
import { HardhatPluginError } from "hardhat/plugins"
import { parseLocalNetworksConfigPath } from "./utils"
import "./type-extensions"

const HARDHAT_CONFIG_DIR = ".hardhat"
const HARDHAT_NETWORK_CONFIG_FILE = "networks.json"

export interface LocalNetworksConfig {
  networks?: NetworksUserConfig
  defaultConfig?: NetworkUserConfig
}

interface LocalNetworksConfigInternal extends LocalNetworksConfig {
  networks: NetworksUserConfig
  defaultConfig: NetworkUserConfig
}

extendConfig(
  (hardhatConfig: HardhatConfig, userConfig: HardhatUserConfig): void => {
    const homeLocalNetworksConfig = readHomeNetworksConfig()
    const localNetworksConfig = readLocalNetworksConfig(
      hardhatConfig,
      userConfig
    )

    const userNetworkConfigs = userConfig.networks || []
    Object.entries(userNetworkConfigs).forEach(
      ([networkName, userNetworkConfig]) => {
        hardhatConfig.networks[networkName] = deepmerge.all([
          hardhatConfig.networks[networkName] || {},
          homeLocalNetworksConfig.defaultConfig,
          homeLocalNetworksConfig.networks[networkName] || {},
          localNetworksConfig.defaultConfig,
          userNetworkConfig as object,
          localNetworksConfig.networks[networkName] || {},
        ]) as NetworkConfig
      }
    )

    Object.entries(localNetworksConfig.networks).forEach(
      ([networkName, localNetworkConfig]) => {
        if (!hardhatConfig.networks[networkName]) {
          hardhatConfig.networks[networkName] = deepmerge.all([
            hardhatConfig.networks[networkName] || {},
            homeLocalNetworksConfig.defaultConfig,
            localNetworksConfig.defaultConfig,
            localNetworkConfig as object,
          ]) as NetworkConfig
        }
      }
    )

    Object.entries(homeLocalNetworksConfig.networks).forEach(
      ([networkName, localNetworkConfig]) => {
        if (!hardhatConfig.networks[networkName]) {
          hardhatConfig.networks[networkName] = deepmerge.all([
            hardhatConfig.networks[networkName] || {},
            homeLocalNetworksConfig.defaultConfig,
            localNetworksConfig.defaultConfig,
            localNetworkConfig as object,
          ]) as NetworkConfig
        }
      }
    )
  }
)

export function readHomeNetworksConfig(): LocalNetworksConfigInternal {
  const configPath = getDefaultHomeLocalNetworksConfigPath()
  const networksConfig = fs.existsSync(configPath) ? require(configPath) : {}

  if (!networksConfig.networks) networksConfig.networks = []
  if (!networksConfig.defaultConfig) networksConfig.defaultConfig = {}

  return networksConfig
}

export function readLocalNetworksConfig(
  hardhatConfig: HardhatConfig,
  userConfig: HardhatUserConfig
): LocalNetworksConfigInternal {
  const localNetworksConfigPath = parseLocalNetworksConfigPath(
    userConfig,
    hardhatConfig.paths.root
  )

  if (localNetworksConfigPath && !fs.existsSync(localNetworksConfigPath)) {
    throw new HardhatPluginError(
      `hardhat-local-networks-config-plugin`,
      `configuration file not found under "localNetworksConfig" path: ${userConfig.localNetworksConfig}; ` +
        `resolved path: ${localNetworksConfigPath}`
    )
  }

  const localNetworksConfig = localNetworksConfigPath
    ? require(localNetworksConfigPath)
    : {}

  if (!localNetworksConfig.networks) localNetworksConfig.networks = []
  if (!localNetworksConfig.defaultConfig) localNetworksConfig.defaultConfig = {}

  return localNetworksConfig
}

export function getDefaultHomeLocalNetworksConfigPath() {
  return path.join(getHomeConfigDir(), HARDHAT_NETWORK_CONFIG_FILE)
}

export function getHomeConfigDir() {
  return path.join(homedir(), HARDHAT_CONFIG_DIR)
}
