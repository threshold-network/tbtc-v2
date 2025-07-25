import type { HardhatUserConfig } from "hardhat/config"

import "@nomiclabs/hardhat-etherscan"
import "@keep-network/hardhat-helpers"
import "@nomiclabs/hardhat-waffle"
import "hardhat-gas-reporter"
import "hardhat-contract-sizer"
import "hardhat-deploy"
import "@typechain/hardhat"
import "hardhat-dependency-compiler"

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.15",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1000,
          },
        },
      },
    ],
  },

  paths: {
    artifacts: "./build",
  },

  networks: {
    hardhat: {
      deploy: [
        // "deploy_l1",
        "deploy_l2",
      ],
      forking: {
        url: process.env.BOB_MAINNET_URL || "https://rpc.gobob.xyz/",
        blockNumber: 20191668,
      }
    },
    sepolia: {
      url: process.env.L1_CHAIN_API_URL || "",
      chainId: 11155111,
      deploy: ["deploy_l1"],
      accounts: process.env.L1_ACCOUNTS_PRIVATE_KEYS
        ? process.env.L1_ACCOUNTS_PRIVATE_KEYS.split(",")
        : undefined,
      tags: ["etherscan"],
    },
    mainnet: {
      url: process.env.L1_CHAIN_API_URL || "",
      chainId: 1,
      deploy: ["deploy_l1"],
      accounts: process.env.L1_ACCOUNTS_PRIVATE_KEYS
        ? process.env.L1_ACCOUNTS_PRIVATE_KEYS.split(",")
        : undefined,
      tags: ["etherscan"],
    },
    bobMainnet: {
      url: process.env.L2_CHAIN_API_URL || "https://rpc.gobob.xyz/",
      chainId: 60808,
      deploy: ["deploy_l2"],
      accounts: process.env.L2_ACCOUNTS_PRIVATE_KEYS
        ? process.env.L2_ACCOUNTS_PRIVATE_KEYS.split(",")
        : undefined,
      tags: ["bobscan"],
    },
    bobSepolia: {
      url: process.env.L2_CHAIN_API_URL || "https://bob-sepolia.rpc.gobob.xyz/",
      chainId: 808813,
      deploy: ["deploy_l2"],
      accounts: process.env.L2_ACCOUNTS_PRIVATE_KEYS
        ? process.env.L2_ACCOUNTS_PRIVATE_KEYS.split(",")
        : undefined,
      tags: ["bobscan"],
    },
  },

  deploymentArtifactsExport: {
    goerli: "artifacts/l1",
    sepolia: "artifacts/l1",
    mainnet: "artifacts/l1",
    arbitrumGoerli: "artifacts/l2",
    arbitrumSepolia: "artifacts/l2",
    arbitrumOne: "artifacts/l2",
  },

  etherscan: {
    apiKey: {
      goerli: process.env.ETHERSCAN_API_KEY,
      sepolia: process.env.ETHERSCAN_API_KEY,
      mainnet: process.env.ETHERSCAN_API_KEY,
      bobMainnet: "empty",
      bobSepolia: "empty",
    },
    customChains: [
      {
        network: "bobMainnet",
        chainId: 60808,
        urls: {
          apiURL: "https://explorer-bob-mainnet-0.t.conduit.xyz/api",
          browserURL: "https://explorer-bob-mainnet-0.t.conduit.xyz:443"
        }
      },
      {
        network: "bobSepolia",
        chainId: 808813,
        urls: {
          apiURL: "https://explorer-bob-sepolia-dm6uw0yhh3.t.conduit.xyz/api",
          browserURL: "https://explorer-bob-sepolia-dm6uw0yhh3.t.conduit.xyz:443"
        }
      }
    ],
  },

  namedAccounts: {
    deployer: {
      default: 1,
      goerli: 0,
      sepolia: 0,
      mainnet: "0x15424dC94D4da488DB0d0e0B7aAdB86835813a63",
      bobMainnet: "0x15424dC94D4da488DB0d0e0B7aAdB86835813a63",
      bobSepolia: "0x15424dC94D4da488DB0d0e0B7aAdB86835813a63",
    },
    governance: {
      default: 2,
      goerli: 0,
      sepolia: 0,
      mainnet: "0x9f6e831c8f8939dc0c830c6e492e7cef4f9c2f5f",
      bobMainnet: "0x694DeC29F197c76eb13d4Cc549cE38A1e06Cd24C",
      bobSepolia: "0x15424dC94D4da488DB0d0e0B7aAdB86835813a63",
    },
  },
  mocha: {
    timeout: 60_000,
  },
  typechain: {
    outDir: "typechain",
  },
}

export default config
