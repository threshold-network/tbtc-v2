import type { HardhatUserConfig } from "hardhat/config"
import { task } from "hardhat/config"
import { TASK_COMPILE } from "hardhat/builtin-tasks/task-names"

import * as dotenv from "dotenv"
dotenv.config()

import "@nomiclabs/hardhat-etherscan"
import "@keep-network/hardhat-helpers"
import "@nomiclabs/hardhat-waffle"
import "hardhat-gas-reporter"
import "hardhat-contract-sizer"
import "hardhat-deploy"
import "@typechain/hardhat"
import { copyBTCDepositorWormholeArtifact } from "../common/copyWormholeV2Artifact"

// Sui consumes the shared `BTCDepositorWormhole` implementation. Stage it from
// the local solidity build after compiling this package's own sources, so the
// package resolves the local source instead of the published npm copy.
task(TASK_COMPILE).setAction(async (args, hre, runSuper) => {
  await runSuper(args)
  await copyBTCDepositorWormholeArtifact(hre, __dirname)
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
    // Local mainnet-fork node (anvil) used by the upgrade fork regression test.
    // Hardhat's built-in forking cannot initialize against the project RPC
    // (reth omits `totalDifficulty`); pointing at an external anvil fork node
    // sidesteps that. Run: `anvil --fork-url <RPC> --port 8545 --chain-id 1`.
    system_tests: {
      url: "http://127.0.0.1:8545",
      chainId: 1,
    },
  },

  external: {
    deployments: {
      sepolia: ["./external/sepolia", "./external/suiTestnet"],
      mainnet: ["./external/mainnet", "./external/suiMainnet"],
      // Fork tests run under `--network system_tests` (chainId 1) and read the
      // committed mainnet deployment so deployments resolve the live proxy.
      system_tests: [
        "deployments/mainnet",
        "./external/mainnet",
        "./external/suiMainnet",
      ],
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
}

export default config
