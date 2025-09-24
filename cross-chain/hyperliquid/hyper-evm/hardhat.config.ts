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
        "deploy_hl",
      ],
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
    sepolia: {
      url: process.env.L1_CHAIN_API_URL || "",
      chainId: 11155111,
      deploy: ["deploy_l1"],
      accounts: process.env.L1_ACCOUNTS_PRIVATE_KEYS
        ? process.env.L1_ACCOUNTS_PRIVATE_KEYS.split(",")
        : undefined,
      tags: ["etherscan"],
    },
    hyperEvmMainnet: {
      url: process.env.HYPER_EVM_API_URL || "",
      chainId: 999,
      deploy: ["deploy_hl"],
      accounts: process.env.HL_ACCOUNTS_PRIVATE_KEYS
        ? process.env.HL_ACCOUNTS_PRIVATE_KEYS.split(",")
        : undefined,
    },
    hyperEvmTestnet: {
      url: process.env.HYPER_EVM_API_URL || "",
      chainId: 998,
      deploy: ["deploy_hl"],
      accounts: process.env.HL_ACCOUNTS_PRIVATE_KEYS
        ? process.env.HL_ACCOUNTS_PRIVATE_KEYS.split(",")
        : undefined,
    },
  },

  external: {
    deployments: {
      mainnet: ["./external/mainnet"],
      sepolia: ["./external/sepolia"],
      hyperEvmMainnet: ["./external/hyperEvmMainnet"],
      hyperEvmTestnet: ["./external/hyperEvmTestnet"],
    },
  },

  deploymentArtifactsExport: {
    mainnet: "artifacts/l1",
    sepolia: "artifacts/l1",
    hyperEvmMainnet: "artifacts/hl",
    hyperEvmTestnet: "artifacts/hl",
  },

  etherscan: {
    apiKey: {
      sepolia: process.env.ETHERSCAN_API_KEY,
      mainnet: process.env.ETHERSCAN_API_KEY,
    }
  },

  namedAccounts: {
    deployer: {
      default: 1,
      mainnet: "0x15424dC94D4da488DB0d0e0B7aAdB86835813a63",
      sepolia: "0x15424dC94D4da488DB0d0e0B7aAdB86835813a63",
      hyperEvmMainnet: "0x15424dC94D4da488DB0d0e0B7aAdB86835813a63",
      hyperEvmTestnet: "0x15424dC94D4da488DB0d0e0B7aAdB86835813a63",
    },
    governance: {
      default: 2,
      mainnet: "0x9f6e831c8f8939dc0c830c6e492e7cef4f9c2f5f",
      sepolia: "0x9f6e831c8f8939dc0c830c6e492e7cef4f9c2f5f",
      hyperEvmMainnet: "0x9f6e831c8f8939dc0c830c6e492e7cef4f9c2f5f",
      hyperEvmTestnet: "0x9f6e831c8f8939dc0c830c6e492e7cef4f9c2f5f",
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
