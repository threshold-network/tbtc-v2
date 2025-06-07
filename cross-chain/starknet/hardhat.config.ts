import "@keep-network/hardhat-helpers"

import type { HardhatUserConfig } from "hardhat/config"

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.17",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    ],
  },

  paths: {
    artifacts: "./artifacts",
    cache: "./cache",
    deploy: "./deploy_l1",
    sources: "../../solidity/contracts",
    deployments: "./deployments",
  },

  namedAccounts: {
    deployer: {
      default: 0,
      sepolia: 0,
      mainnet: "0x123...", // TODO: Set mainnet deployer
    },
    governance: {
      default: 1,
      sepolia: "0xB175474E89094C44Da98b954EedeAC495271d0F", // TODO: Update for sepolia
      mainnet: "0x9040e41eF5E8b281535a96D9a48aCb8cfaBD9a48", // TODO: Update for mainnet
    },
  },

  networks: {
    hardhat: {
      forking: {
        // forking is enabled only if FORKING_URL env is provided
        enabled: !!process.env.FORKING_URL,
        // URL should point to a node with archival data
        url: process.env.FORKING_URL || "",
        // latest block is taken if FORKING_BLOCK env is not provided
        blockNumber: process.env.FORKING_BLOCK
          ? parseInt(process.env.FORKING_BLOCK)
          : undefined,
      },
      tags: ["local"],
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "",
      chainId: 11155111,
      accounts: process.env.SEPOLIA_PRIVATE_KEY
        ? [process.env.SEPOLIA_PRIVATE_KEY]
        : undefined,
      tags: ["sepolia", "testnet"],
    },
    mainnet: {
      url: process.env.MAINNET_RPC_URL || "",
      chainId: 1,
      accounts: process.env.MAINNET_PRIVATE_KEY
        ? [process.env.MAINNET_PRIVATE_KEY]
        : undefined,
      tags: ["mainnet"],
    },
  },

  // Hardhat Deploy
  external: {
    deployments: {
      mainnet: ["../../solidity/deployments/mainnet"],
      sepolia: ["../../solidity/deployments/sepolia"],
    },
  },

  // Etherscan API key for contract verification
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY,
  },

  typechain: {
    outDir: "../../solidity/typechain",
    target: "ethers-v5",
    alwaysGenerateOverloads: false,
    dontOverrideCompile: true,
  },

  mocha: {
    timeout: 60_000,
  },
}

export default config