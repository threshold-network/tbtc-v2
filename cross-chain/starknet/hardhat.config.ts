import * as dotenv from "dotenv"

import { HardhatUserConfig } from "hardhat/config"

import "@keep-network/hardhat-helpers"
import "./local-networks-config"
import "@nomiclabs/hardhat-waffle"
import "@nomiclabs/hardhat-etherscan"
import "hardhat-gas-reporter"
import "hardhat-contract-sizer"
import "hardhat-deploy"
import "@tenderly/hardhat-tenderly"
import "@typechain/hardhat"
import "hardhat-dependency-compiler"
import "solidity-docgen"

dotenv.config()

// Configuration for testing environment.
export const testConfig = {
  // How many accounts we expect to define for non-staking related signers, e.g.
  // deployer, thirdParty, governance.
  nonStakingAccountsCount: 10,
}

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
    sources: "./contracts",
  },

  networks: {
    hardhat: {
      forking: {
        // forking is enabled only if FORKING_URL env is provided
        enabled: !!process.env.FORKING_URL,
        // URL should point to a node with archival data (Alchemy recommended)
        url: process.env.FORKING_URL || "",
        // latest block is taken if FORKING_BLOCK env is not provided
        blockNumber:
          process.env.FORKING_BLOCK && parseInt(process.env.FORKING_BLOCK, 10),
      },
      accounts: {
        count: testConfig.nonStakingAccountsCount,
      },
      deploy: ["deploy_l1"],
      tags: ["allowStubs"],
      // we use higher gas price for tests to obtain more realistic results
      // for gas refund tests than when the default hardhat ~1 gwei gas price is
      // used
      gasPrice: 200000000000, // 200 gwei
      // Ignore contract size on deployment to hardhat network, to be able to
      // deploy stub contracts in tests.
      allowUnlimitedContractSize: process.env.TEST_USE_STUBS_TBTC === "true",
    },
    system_tests: {
      url: "http://127.0.0.1:8545",
      tags: ["allowStubs"],
    },
    development: {
      url: "http://localhost:8545",
      chainId: 1101,
      tags: ["allowStubs"],
    },
    sepolia: {
      url: process.env.L1_CHAIN_SEPOLIA_API_URL || "",
      chainId: 11155111,
      deploy: ["deploy_l1"],
      accounts: process.env.L1_ACCOUNTS_PK_SEPOLIA
        ? process.env.L1_ACCOUNTS_PK_SEPOLIA.split(",").map((key) =>
            key.startsWith("0x") ? key : `0x${key}`
          )
        : undefined,
      tags: [
        "etherscan",
        // "tenderly" // TODO: Enable
      ],
      timeout: 60000, // 60 seconds
      httpHeaders: {},
    },
    mainnet: {
      url: process.env.L1_CHAIN_MAINNET_API_URL || "",
      chainId: 1,
      deploy: ["deploy_l1"],
      accounts: process.env.L1_ACCOUNTS_PK_MAINNET
        ? process.env.L1_ACCOUNTS_PK_MAINNET.split(",").map((key) =>
            key.startsWith("0x") ? key : `0x${key}`
          )
        : undefined,
      tags: [
        "etherscan",
        // "tenderly" // TODO: Enable
      ],
      timeout: 60000, // 60 seconds
      httpHeaders: {},
    },
  },
  // TODO: Fix this
  // tenderly: {
  //   username: "thesis",
  //   project: "keep",
  // },

  external: {
    // Bridge and Vault are existing deployments, accessed through local
    // interfaces. This integration does not deploy the core protocol stack.
    deployments: {
      sepolia: ["./external/sepolia"],
      mainnet: ["./external/mainnet"],
    },
  },

  namedAccounts: {
    deployer: {
      default: 1,
      sepolia: 0,
      mainnet: "0x6CB1AdE9BA5B8D8988b989AeA3718Bc14D6F5B54", //StarkNet Bitcoin Depositor Deployer
    },
    governance: {
      default: 2,
      sepolia: 0,
      mainnet: "0x9f6e831c8f8939dc0c830c6e492e7cef4f9c2f5f", // Threshold Council
    },
  },
  dependencyCompiler: {
    paths: [
      "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol",
      "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol",
    ],
    keep: true,
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY,
  },
  contractSizer: {
    alphaSort: true,
    disambiguatePaths: false,
    runOnCompile: true,
    strict: true,
    except: [],
  },
  mocha: {
    timeout: 60_000,
  },
  typechain: {
    outDir: "typechain",
  },
  docgen: {
    outputDir: "generated-docs",
    templates: "docgen-templates",
    pages: "files", // `single`, `items` or `files`
    exclude: ["./test"],
  },
}

export default config
