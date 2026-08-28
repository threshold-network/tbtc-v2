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
    // Local mainnet-fork node (anvil) used by the upgrade fork regression tests.
    // Hardhat's built-in forking cannot initialize against the project RPC
    // (reth omits `totalDifficulty`); pointing at an external anvil fork node
    // sidesteps that. Run: `anvil --fork-url <RPC> --port 8545 --chain-id 1`.
    system_tests: {
      url: "http://127.0.0.1:8545",
      chainId: 1,
    },
    arbitrumGoerli: {
      url: process.env.L2_CHAIN_API_URL || "",
      chainId: 421613,
      deploy: ["deploy_l2"],
      accounts: process.env.L2_ACCOUNTS_PRIVATE_KEYS
        ? process.env.L2_ACCOUNTS_PRIVATE_KEYS.split(",")
        : undefined,
      tags: ["arbiscan"],
      // companionNetworks: {
      //   l1: "goerli",
      // },
    },
    arbitrumSepolia: {
      url: process.env.L2_CHAIN_API_URL || "",
      chainId: 421614,
      deploy: ["deploy_l2"],
      accounts: process.env.L2_ACCOUNTS_PRIVATE_KEYS
        ? process.env.L2_ACCOUNTS_PRIVATE_KEYS.split(",")
        : undefined,
      tags: ["arbiscan"],
      // companionNetworks: {
      //   l1: "sepolia",
      // },
    },
    arbitrumOne: {
      url: process.env.L2_CHAIN_API_URL || "",
      chainId: 42161,
      deploy: ["deploy_l2"],
      accounts: process.env.L2_ACCOUNTS_PRIVATE_KEYS
        ? process.env.L2_ACCOUNTS_PRIVATE_KEYS.split(",")
        : undefined,
      tags: ["arbiscan"],
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
      arbitrumGoerli: ["./external/arbitrumGoerli"],
      arbitrumSepolia: ["./external/arbitrumSepolia"],
      arbitrumOne: ["./external/arbitrumOne"],
      // Fork tests run under `--network system_tests` (chainId 1) and read the
      // committed mainnet deployment (ArbitrumOneL1BitcoinDepositor) so
      // `deployments.get` resolves the live proxy on the anvil fork.
      system_tests: ["deployments/mainnet", "./external/mainnet"],
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
      arbitrumGoerli: process.env.ARBISCAN_API_KEY,
      arbitrumSepolia: process.env.ARBISCAN_API_KEY,
      arbitrumOne: process.env.ARBISCAN_API_KEY,
    },
    customChains: [
      {
        network: "arbitrumSepolia",
        chainId: 421614,
        urls: {
          apiURL: "https://api-sepolia.arbiscan.io/api",
          browserURL: "https://sepolia.arbiscan.io/",
        },
      },
    ],
  },

  namedAccounts: {
    deployer: {
      default: 1,
      goerli: 0,
      sepolia: 0,
      arbitrumGoerli: 0,
      arbitrumSepolia: 0,
      mainnet: "0x716089154304f22a2F9c8d2f8C45815183BF3532",
      arbitrumOne: "0x716089154304f22a2F9c8d2f8C45815183BF3532",
    },
    governance: {
      default: 2,
      goerli: 0,
      sepolia: 0,
      arbitrumGoerli: 0,
      arbitrumSepolia: 0,
      mainnet: "0x9f6e831c8f8939dc0c830c6e492e7cef4f9c2f5f",
      arbitrumOne: "0x9f6e831c8f8939dc0c830c6e492e7cef4f9c2f5f",
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
