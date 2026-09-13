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
    optimismSepolia: {
      url: process.env.L2_CHAIN_API_URL || "",
      chainId: 11155420,
      deploy: ["deploy_l2"],
      accounts: process.env.L2_ACCOUNTS_PRIVATE_KEYS
        ? process.env.L2_ACCOUNTS_PRIVATE_KEYS.split(",")
        : undefined,
      tags: ["optimism_etherscan"],
      // In case of deployment failing with underpriced transaction error set
      // the `gasPrice` parameter.
      // gasPrice: 1000000000,
      // companionNetworks: {
      //   l1: "sepolia",
      // },
    },
    optimism: {
      url: process.env.L2_CHAIN_API_URL || "",
      chainId: 10,
      deploy: ["deploy_l2"],
      accounts: process.env.L2_ACCOUNTS_PRIVATE_KEYS
        ? process.env.L2_ACCOUNTS_PRIVATE_KEYS.split(",")
        : undefined,
      tags: ["optimism_etherscan"],
      // companionNetworks: {
      //   l1: "mainnet",
      // },
    },
  },

  external: {
    deployments: {
      sepolia: ["./external/sepolia"],
      mainnet: ["./external/mainnet"],
      optimismSepolia: ["./external/optimismSepolia"],
      optimism: ["./external/optimism"],
    },
  },

  deploymentArtifactsExport: {
    sepolia: "artifacts/l1",
    mainnet: "artifacts/l1",
    optimismSepolia: "artifacts/l2",
    optimism: "artifacts/l2",
  },

  etherscan: {
    apiKey: {
      sepolia: process.env.ETHERSCAN_API_KEY,
      mainnet: process.env.ETHERSCAN_API_KEY,
      optimisticSepolia: process.env.OPTIMISM_ETHERSCAN_API_KEY,
      optimisticEthereum: process.env.OPTIMISM_ETHERSCAN_API_KEY,
    },
    customChains: [
      {
        network: "optimisticSepolia",
        chainId: 11155420,
        urls: {
          apiURL: "https://api-sepolia-optimistic.etherscan.io/api",
          browserURL: "https://sepolia-optimism.etherscan.io/",
        },
      },
    ],
  },

  namedAccounts: {
    deployer: {
      default: 1,
      sepolia: 0,
      optimismSepolia: 0,
      mainnet: "0x123694886DBf5Ac94DDA07135349534536D14cAf",
      optimism: "0x123694886DBf5Ac94DDA07135349534536D14cAf",
    },
    governance: {
      default: 2,
      sepolia: 0,
      optimismSepolia: 0,
      mainnet: "0x9f6e831c8f8939dc0c830c6e492e7cef4f9c2f5f",
      optimism: "0x7fB50BBabeDEE52b8760Ba15c0c199aF33Fc2EfA",
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
