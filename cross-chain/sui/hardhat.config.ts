import type { HardhatUserConfig } from "hardhat/config"

import * as dotenv from "dotenv"
dotenv.config()

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
      deploy: ["deploy_l1"],
    },
    sepolia: {
      url: process.env.L1_CHAIN_API_URL || "",
      chainId: 11155111,
      deploy: ["deploy_l1"],
      accounts: process.env.L1_ACCOUNTS_PRIVATE_KEYS
        ? process.env.L1_ACCOUNTS_PRIVATE_KEYS.split(",")
        : undefined,
      tags: ["etherscan"],
      // No companion network needed for Sui
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
  },

  external: {
    deployments: {
      sepolia: ["./external/sepolia", "./external/suiTestnet"],
      mainnet: ["./external/mainnet", "./external/suiMainnet"],
    },
  },

  deploymentArtifactsExport: {
    sepolia: "artifacts/l1",
    mainnet: "artifacts/l1",
  },

  etherscan: {
    apiKey: {
      sepolia: process.env.ETHERSCAN_API_KEY,
      mainnet: process.env.ETHERSCAN_API_KEY,
    },
    customChains: [],
  },

  namedAccounts: {
    deployer: {
      default: 1,
      sepolia: 0,
      mainnet: "0x5BFA07bCb65bbDa13Fc87400DB9b6A5685bDA329",
    },
    governance: {
      default: 2,
      sepolia: 0,
      mainnet: "0x9f6e831c8f8939dc0c830c6e492e7cef4f9c2f5f", // Threshold Council
    },
  },
  mocha: {
    timeout: 60_000,
  },
  typechain: {
    outDir: "typechain",
  },
  dependencyCompiler: {
    paths: [
      "@keep-network/tbtc-v2/contracts/cross-chain/wormhole/BTCDepositorWormhole.sol",
    ],
  },
}

export default config
