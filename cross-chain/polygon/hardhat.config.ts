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
        // "deploy_parentchain",
        "deploy_sidechain",
      ],
    },
    goerli: {
      url: process.env.PARENTCHAIN_API_URL || "",
      chainId: 5,
      deploy: ["deploy_parentchain"],
      accounts: process.env.PARENTCHAIN_ACCOUNTS_PRIVATE_KEYS
        ? process.env.PARENTCHAIN_ACCOUNTS_PRIVATE_KEYS.split(",")
        : undefined,
      tags: ["etherscan"],
    },
    sepolia: {
      url: process.env.PARENTCHAIN_API_URL || "",
      chainId: 11155111,
      deploy: ["deploy_parentchain"],
      accounts: process.env.PARENTCHAIN_ACCOUNTS_PRIVATE_KEYS
        ? process.env.PARENTCHAIN_ACCOUNTS_PRIVATE_KEYS.split(",")
        : undefined,
      tags: ["etherscan"],
    },
    mainnet: {
      url: process.env.PARENTCHAIN_API_URL || "",
      chainId: 1,
      deploy: ["deploy_parentchain"],
      accounts: process.env.PARENTCHAIN_ACCOUNTS_PRIVATE_KEYS
        ? process.env.PARENTCHAIN_ACCOUNTS_PRIVATE_KEYS.split(",")
        : undefined,
      tags: ["etherscan"],
    },
    mumbai: {
      url: process.env.SIDECHAIN_API_URL || "",
      chainId: 80001,
      deploy: ["deploy_sidechain"],
      accounts: process.env.SIDECHAIN_ACCOUNTS_PRIVATE_KEYS
        ? process.env.SIDECHAIN_ACCOUNTS_PRIVATE_KEYS.split(",")
        : undefined,
      tags: ["polygonscan"],
      // companionNetworks: {
      //   parentchain: "goerli",
      // },
    },
    amoy: {
      url: process.env.SIDECHAIN_API_URL || "",
      chainId: 80002,
      deploy: ["deploy_sidechain"],
      accounts: process.env.SIDECHAIN_ACCOUNTS_PRIVATE_KEYS
        ? process.env.SIDECHAIN_ACCOUNTS_PRIVATE_KEYS.split(",")
        : undefined,
      // Uncomment once Polygonscan supports Amoy testnet.
      // tags: ["polygonscan"],
      // companionNetworks: {
      //   parentchain: "goerli",
      // },
    },
    polygon: {
      url: process.env.SIDECHAIN_API_URL || "",
      chainId: 137,
      deploy: ["deploy_sidechain"],
      accounts: process.env.SIDECHAIN_ACCOUNTS_PRIVATE_KEYS
        ? process.env.SIDECHAIN_ACCOUNTS_PRIVATE_KEYS.split(",")
        : undefined,
      tags: ["polygonscan"],
      // companionNetworks: {
      //   parentchain: "mainnet",
      // },
    },
  },

  external: {
    deployments: {
      goerli: ["./external/goerli"],
      sepolia: ["./external/sepolia"],
      mainnet: ["./external/mainnet"],
      mumbai: ["./external/mumbai"],
      amoy: ["./external/amoy"],
      polygon: ["./external/polygon"],
    },
  },

  deploymentArtifactsExport: {
    goerli: "artifacts/parentchain",
    sepolia: "artifacts/parentchain",
    mainnet: "artifacts/parentchain",
    mumbai: "artifacts/sidechain",
    amoy: "artifacts/sidechain",
    polygon: "artifacts/sidechain",
  },

  etherscan: {
    apiKey: {
      goerli: process.env.ETHERSCAN_API_KEY,
      sepolia: process.env.ETHERSCAN_API_KEY,
      mainnet: process.env.ETHERSCAN_API_KEY,
      polygonMumbai: process.env.POLYGONSCAN_API_KEY,
      // TODO: uncomment once Amoy testnet is live and supported by Polygonscan.
      // polygonAmoy: process.env.POLYGONSCAN_API_KEY,
      polygon: process.env.POLYGONSCAN_API_KEY,
    },
    // TODO: Uncomment once Amoy testnet is live and supported by Polygonscan.
    // The custom config will not be needed if `polygonAmoy` will be added to
    // https://github.com/NomicFoundation/hardhat/blame/main/packages/hardhat-verify/src/internal/chain-config.ts.
    // In that case we'll need to update `hardhat-verify` dependency.
    // customChains: [
    //   {
    //     networkName: "polygonAmoy",
    //     chainId: 80002,
    //     urls: {
    //       // Check below values in https://docs.polygonscan.com/getting-started/endpoint-urls
    //       // once Polygonscan supports Amoy testnet.
    //       apiURL: "https://api-testnet.polygonscan.com/api",
    //       browserURL: "https://amoy.polygonscan.com/",
    //     }
    //   }
    // ]
  },

  namedAccounts: {
    deployer: {
      default: 1,
      goerli: 0,
      sepolia: 0,
      mumbai: 0,
      amoy: 0,
      mainnet: "0x123694886DBf5Ac94DDA07135349534536D14cAf",
      polygon: "0x123694886DBf5Ac94DDA07135349534536D14cAf",
    },
    governance: {
      default: 2,
      goerli: 0,
      sepolia: 0,
      mumbai: 0,
      amoy: 0,
      mainnet: "0x9f6e831c8f8939dc0c830c6e492e7cef4f9c2f5f",
      polygon: "0x9f6e831c8f8939dc0c830c6e492e7cef4f9c2f5f",
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
