/* eslint-disable no-console */
import { ethers } from "hardhat"
import { HardhatRuntimeEnvironment } from "hardhat/types"

/**
 * L1BTCDepositorNtt Configuration Script
 *
 * Validates a fixed-destination L1BTCDepositorNtt deployment and prints the
 * NTT Manager peer/rate-limit calls required for that destination. Each
 * destination chain uses a separate L1BTCDepositorNtt instance so the full
 * 32-byte deposit extra data remains available for the destination recipient.
 *
 * Usage:
 *   NTT_DESTINATION=base \
 *   L1_BTC_DEPOSITOR_NTT_ADDRESS=0x... \
 *   npx hardhat run scripts/configure-l1-btc-depositor-ntt.ts --network mainnet
 *
 * Supported NTT_DESTINATION values:
 *   - arbitrum
 *   - base
 *   - optimism
 *
 * Environment Variables:
 *   L1_BTC_DEPOSITOR_NTT_ADDRESS - Address of deployed L1BTCDepositorNtt contract
 *   NTT_DESTINATION - Destination key for this depositor instance
 *   NTT_MANAGER_ADDRESS - Optional expected NTT Manager address
 */

interface DestinationConfig {
  chainId: number
  name: string
  peerAddress?: string
  peerDecimals: number
  inboundLimitAmount: string
  outboundLimitAmount: string
}

interface NetworkConfiguration {
  networkName: string
  destinations: Record<string, DestinationConfig>
}

const ZERO_PEER_ADDRESS =
  "0x0000000000000000000000000000000000000000000000000000000000000000"

const WORMHOLE_CHAIN_IDS = {
  arbitrum: {
    mainnet: 23,
    sepolia: 10003,
  },
  optimism: {
    mainnet: 24,
    sepolia: 10005,
  },
  base: {
    mainnet: 30,
    sepolia: 10004,
  },
} as const

function tbtcAmount(amount: string): string {
  return ethers.utils.parseEther(amount).toString()
}

function evmPeerAddress(address: string): string {
  return ethers.utils.hexZeroPad(address, 32)
}

function destination(
  chainId: number,
  name: string,
  inboundLimitAmount: string,
  outboundLimitAmount: string,
  peerAddress = ZERO_PEER_ADDRESS
): DestinationConfig {
  return {
    chainId,
    name,
    peerAddress,
    peerDecimals: 18,
    inboundLimitAmount: tbtcAmount(inboundLimitAmount),
    outboundLimitAmount: tbtcAmount(outboundLimitAmount),
  }
}

const NETWORK_CONFIGURATIONS: Record<string, NetworkConfiguration> = {
  sepolia: {
    networkName: "Ethereum Sepolia",
    destinations: {
      arbitrum: destination(
        WORMHOLE_CHAIN_IDS.arbitrum.sepolia,
        "Arbitrum Sepolia",
        "1000",
        "1000"
      ),
      base: destination(
        WORMHOLE_CHAIN_IDS.base.sepolia,
        "Base Sepolia",
        "1000",
        "1000",
        evmPeerAddress("0x8b9E328bE1b1Bc7501B413d04EBF7479B110775c")
      ),
      optimism: destination(
        WORMHOLE_CHAIN_IDS.optimism.sepolia,
        "Optimism Sepolia",
        "1000",
        "1000"
      ),
    },
  },
  mainnet: {
    networkName: "Ethereum Mainnet",
    destinations: {
      arbitrum: destination(
        WORMHOLE_CHAIN_IDS.arbitrum.mainnet,
        "Arbitrum One",
        "100000",
        "100000"
      ),
      base: destination(
        WORMHOLE_CHAIN_IDS.base.mainnet,
        "Base Mainnet",
        "100000",
        "100000"
      ),
      optimism: destination(
        WORMHOLE_CHAIN_IDS.optimism.mainnet,
        "Optimism Mainnet",
        "100000",
        "100000"
      ),
    },
  },
}

function selectDestination(
  config: NetworkConfiguration,
  destinationKey?: string
): [string, DestinationConfig] {
  if (!destinationKey) {
    throw new Error(
      `Set NTT_DESTINATION to one of: ${Object.keys(config.destinations).join(
        ", "
      )}`
    )
  }

  const destinationConfig = config.destinations[destinationKey]
  if (!destinationConfig) {
    throw new Error(
      `Unsupported NTT_DESTINATION "${destinationKey}" for ${
        config.networkName
      }. Supported values: ${Object.keys(config.destinations).join(", ")}`
    )
  }

  return [destinationKey, destinationConfig]
}

async function main() {
  // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
  const hre = require("hardhat") as HardhatRuntimeEnvironment
  const { network } = hre
  const networkName = network.name

  console.log(`\nConfiguring L1BTCDepositorNtt on ${networkName}...`)

  const config = NETWORK_CONFIGURATIONS[networkName]
  if (!config) {
    throw new Error(
      `No L1 NTT depositor configuration found for network: ${networkName}. ` +
        "This script only configures Ethereum hub deployments."
    )
  }

  const [destinationKey, destinationConfig] = selectDestination(
    config,
    process.env.NTT_DESTINATION
  )

  const contractAddress = process.env.L1_BTC_DEPOSITOR_NTT_ADDRESS
  if (!contractAddress) {
    throw new Error(
      "Contract address not provided. Set L1_BTC_DEPOSITOR_NTT_ADDRESS."
    )
  }

  console.log(`Contract Address: ${contractAddress}`)
  console.log(
    `Destination: ${destinationConfig.name} (${destinationConfig.chainId})`
  )

  const [deployer] = await ethers.getSigners()
  const l1BtcDepositorNtt = await ethers.getContractAt(
    "L1BTCDepositorNtt",
    contractAddress,
    deployer
  )

  console.log(`Deployer: ${deployer.address}`)
  console.log(
    `Balance: ${ethers.utils.formatEther(await deployer.getBalance())} ETH`
  )

  const configuredDestinationChainId =
    await l1BtcDepositorNtt.destinationChainId()
  const configuredDestinationChainIdNumber = Number(
    configuredDestinationChainId
  )
  if (configuredDestinationChainIdNumber !== destinationConfig.chainId) {
    throw new Error(
      `Contract destinationChainId is ${configuredDestinationChainId.toString()}, ` +
        `but ${destinationKey} expects ${destinationConfig.chainId}.`
    )
  }

  const nttManagerAddress = await l1BtcDepositorNtt.nttManager()
  if (
    process.env.NTT_MANAGER_ADDRESS &&
    process.env.NTT_MANAGER_ADDRESS.toLowerCase() !==
      nttManagerAddress.toLowerCase()
  ) {
    throw new Error(
      `Contract NTT Manager is ${nttManagerAddress}, ` +
        `but NTT_MANAGER_ADDRESS is ${process.env.NTT_MANAGER_ADDRESS}.`
    )
  }

  console.log("\nCurrent Configuration Summary:")
  console.log(`   Network: ${config.networkName}`)
  console.log(`   Contract: ${contractAddress}`)
  console.log(`   NTT Manager: ${nttManagerAddress}`)
  console.log(
    `   Destination: ${destinationConfig.name} (${configuredDestinationChainId})`
  )

  console.log("\nNext Steps for NTT Manager Configuration:")
  if (
    destinationConfig.peerAddress &&
    destinationConfig.peerAddress !== ZERO_PEER_ADDRESS
  ) {
    console.log(
      `   await nttManager.setPeer(${destinationConfig.chainId}, "${destinationConfig.peerAddress}", ${destinationConfig.peerDecimals}, "${destinationConfig.inboundLimitAmount}");`
    )
  } else {
    console.log(
      `   // TODO: Set peer for ${destinationConfig.name} (${destinationConfig.chainId}) when the destination NTT Manager is deployed`
    )
  }

  console.log(
    `   await nttManager.setOutboundLimit("${destinationConfig.outboundLimitAmount}");`
  )
  console.log(
    "   // setOutboundLimit is global for this NTT Manager. Confirm the " +
      "manager constructor's rate-limit duration and aggregate outbound " +
      "policy before applying."
  )

  console.log(
    "\nSui and Solana are intentionally not configured here. They require " +
      "spoke-side NTT deployment plus token-authority and legacy lockbox " +
      "migration before their existing token representations can be moved " +
      "to NTT. Do not set them as L1 NTT peers until those chain-local " +
      "migration transactions are complete."
  )

  console.log(`\nConfiguration validation completed for ${config.networkName}.`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Configuration failed:", error)
    process.exit(1)
  })
