import type { HardhatUserConfig } from "hardhat/config"
import { task } from "hardhat/config"
import { TASK_COMPILE } from "hardhat/builtin-tasks/task-names"

import "@nomiclabs/hardhat-etherscan"
import "@keep-network/hardhat-helpers"
import "@nomiclabs/hardhat-waffle"
import "hardhat-gas-reporter"
import "hardhat-contract-sizer"
import "hardhat-deploy"
import "@typechain/hardhat"
import "hardhat-dependency-compiler"
import { copyWormholeV2Artifact } from "../common/copyWormholeV2Artifact"

task(TASK_COMPILE).setAction(async (args, hre, runSuper) => {
  await runSuper(args)
  await copyWormholeV2Artifact(hre, __dirname)
})

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.17",
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
    },
    goerli: {
      url: process.env.L1_CHAIN_API_URL || "",
      chainId: 5,
      deploy: ["deploy_l1"],
      accounts: process.env.L1_ACCOUNTS_PRIVATE_KEYS
        ? process.env.L1_ACCOUNTS_PRIVATE_KEYS.split(",")
        : undefined,
      tags: ["etherscan"],
    },
    sepolia: {
      url: process.env.L1_CHAIN_API_URL || "",
      chainId: 11155111,
      deploy: ["deploy_l1"],
      accounts: process.env.L1_ACCOUNTS_PRIVATE_KEYS
        ? process.env.L1_ACCOUNTS_PRIVATE_KEYS.split(",")
        : undefined,
      tags: ["etherscan"],
      companionNetworks: {
        l2: "baseSepolia",
      },
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
    baseGoerli: {
      url: process.env.L2_CHAIN_API_URL || "",
      chainId: 84531,
      deploy: ["deploy_l2"],
      accounts: process.env.L2_ACCOUNTS_PRIVATE_KEYS
        ? process.env.L2_ACCOUNTS_PRIVATE_KEYS.split(",")
        : undefined,
      tags: ["basescan"],
      // In case of deployment failing with underpriced transaction error set
      // the `gasPrice` parameter.
      // gasPrice: 1000000000,
      // companionNetworks: {
      //   l1: "goerli",
      // },
    },
    baseSepolia: {
      url: process.env.L2_CHAIN_API_URL || "",
      chainId: 84532,
      deploy: ["deploy_l2"],
      accounts: process.env.L2_ACCOUNTS_PRIVATE_KEYS
        ? process.env.L2_ACCOUNTS_PRIVATE_KEYS.split(",")
        : undefined,
      tags: ["basescan"],
      // In case of deployment failing with underpriced transaction error set
      // the `gasPrice` parameter.
      // gasPrice: 1000000000,
      companionNetworks: {
        l1: "sepolia",
      },
    },
    base: {
      url: process.env.L2_CHAIN_API_URL || "",
      chainId: 8453,
      deploy: ["deploy_l2"],
      accounts: process.env.L2_ACCOUNTS_PRIVATE_KEYS
        ? process.env.L2_ACCOUNTS_PRIVATE_KEYS.split(",")
        : undefined,
      tags: ["basescan"],
      // In case of deployment failing with underpriced transaction error set
      // the `gasPrice` parameter.
      // gasPrice: 1000000000,
      // companionNetworks: {
      //   l1: "mainnet",
      // },
    },
  },

  external: {
    deployments: {
      goerli: ["./external/goerli"],
      sepolia: ["./external/sepolia"],
      mainnet: ["./external/mainnet"],
      baseGoerli: ["./external/baseGoerli"],
      baseSepolia: ["./external/baseSepolia"],
      base: ["./external/base"],
    },
  },

  deploymentArtifactsExport: {
    goerli: "artifacts/l1",
    sepolia: "artifacts/l1",
    mainnet: "artifacts/l1",
    baseGoerli: "artifacts/l2",
    baseSepolia: "artifacts/l2",
    base: "artifacts/l2",
  },

  etherscan: {
    apiKey: {
      goerli: process.env.ETHERSCAN_API_KEY,
      sepolia: process.env.ETHERSCAN_API_KEY,
      mainnet: process.env.ETHERSCAN_API_KEY,
      "base-goerli": process.env.BASESCAN_API_KEY,
      "base-sepolia": process.env.BASESCAN_API_KEY,
      "base-mainnet": process.env.BASESCAN_API_KEY,
    },
    customChains: [
      {
        network: "base-goerli",
        chainId: 84531,
        urls: {
          apiURL: "https://api-goerli.basescan.org/api",
          browserURL: "https://goerli.basescan.org",
        },
      },
      {
        network: "base-sepolia",
        chainId: 84532,
        urls: {
          apiURL: "https://api-sepolia.basescan.org/api",
          browserURL: "https://sepolia.basescan.org",
        },
      },
      {
        network: "base-mainnet",
        chainId: 8453,
        urls: {
          apiURL: "https://api.basescan.org/api",
          browserURL: "https://basescan.org",
        },
      },
    ],
  },

  namedAccounts: {
    deployer: {
      default: 1,
      goerli: 0,
      sepolia: 0,
      baseGoerli: 0,
      baseSepolia: 0,
      mainnet: "0x716089154304f22a2F9c8d2f8C45815183BF3532",
      base: "0x716089154304f22a2F9c8d2f8C45815183BF3532",
    },
    governance: {
      default: 2,
      goerli: 0,
      sepolia: 0,
      baseGoerli: 0,
      baseSepolia: 0,
      mainnet: "0x9f6e831c8f8939dc0c830c6e492e7cef4f9c2f5f", // Threshold Council
      base: "0x518385dd31289F1000fE6382b0C65df4d1Cd3bfC", // Threshold Council
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
