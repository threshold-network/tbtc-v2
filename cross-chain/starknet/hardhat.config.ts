import * as dotenv from "dotenv"

import { HardhatUserConfig } from "hardhat/config"

import "@keep-network/hardhat-helpers"
import "@keep-network/hardhat-local-networks-config"
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

const ecdsaSolidityCompilerConfig = {
  version: "0.8.17",
  settings: {
    optimizer: {
      enabled: true,
      runs: 200,
    },
  },
}

// Reduce the number of optimizer runs to 100 to keep the contract size sane.
// BridgeGovernance contract does not need to be super gas-efficient.
const bridgeGovernanceCompilerConfig = {
  version: "0.8.17",
  settings: {
    optimizer: {
      enabled: true,
      runs: 200,
    },
  },
}

// Configuration for testing environment.
export const testConfig = {
  // How many accounts we expect to define for non-staking related signers, e.g.
  // deployer, thirdParty, governance.
  // It is used as an offset for getting accounts for operators and stakes registration.
  nonStakingAccountsCount: 10,

  // How many roles do we need to define for staking, i.e. stakeOwner, stakingProvider,
  // operator, beneficiary, authorizer.
  stakingRolesCount: 5,

  // Number of operators to register. Should be at least the same as group size.
  operatorsCount: 110,
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
    overrides: {
      "@keep-network/ecdsa/contracts/WalletRegistry.sol":
        ecdsaSolidityCompilerConfig,
      "contracts/bridge/BridgeGovernance.sol": bridgeGovernanceCompilerConfig,
    },
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
        // Number of accounts that should be predefined on the testing environment.
        count:
          testConfig.nonStakingAccountsCount +
          testConfig.stakingRolesCount * testConfig.operatorsCount,
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
      url: process.env.L1_CHAIN_SEPOLIA_API_URL,
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
      url: process.env.L1_CHAIN_MAINNET_API_URL,
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
    contracts:
      process.env.USE_EXTERNAL_DEPLOY === "true"
        ? [
            {
              artifacts: "node_modules/@keep-network/tbtc-v2/artifacts",
            },
            {
              artifacts:
                "node_modules/@threshold-network/solidity-contracts/export/artifacts",
              deploy:
                "node_modules/@threshold-network/solidity-contracts/export/deploy",
            },
            {
              artifacts:
                "node_modules/@keep-network/random-beacon/export/artifacts",
              deploy: "node_modules/@keep-network/random-beacon/export/deploy",
            },
            {
              artifacts: "node_modules/@keep-network/ecdsa/export/artifacts",
              deploy: "node_modules/@keep-network/ecdsa/export/deploy",
            },
          ]
        : undefined,
    deployments: {
      // For development environment we expect the local dependencies to be
      // linked with `yarn link` command.
      development: [
        "node_modules/@threshold-network/solidity-contracts/deployments/development",
        "node_modules/@keep-network/random-beacon/deployments/development",
        "node_modules/@keep-network/ecdsa/deployments/development",
      ],
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
    chaosnetOwner: {
      default: 3,
      sepolia: 0,
      // Not used for mainnet deployment scripts of `@keepn-network/tbtc-v2`.
      // Used by `@keep-network/random-beacon` and `@keep-network/ecdsa`
      // when deploying `SortitionPool`s.
    },
    esdm: {
      default: 4,
      sepolia: 0,
      mainnet: "0x9f6e831c8f8939dc0c830c6e492e7cef4f9c2f5f", // Threshold Council
    },
    keepTechnicalWalletTeam: {
      default: 5,
      sepolia: 0,
      mainnet: "0xB3726E69Da808A689F2607939a2D9E958724FC2A",
    },
    keepCommunityMultiSig: {
      default: 6,
      sepolia: 0,
      mainnet: "0x19FcB32347ff4656E4E6746b4584192D185d640d",
    },
    treasury: {
      default: 7,
      sepolia: 0,
      mainnet: "0x87F005317692D05BAA4193AB0c961c69e175f45f", // Token Holder DAO
    },
    spvMaintainer: {
      default: 8,
      sepolia: 0,
      // We are not setting SPV maintainer for mainnet in deployment scripts.
    },
    v1Redeemer: {
      default: 10,
      sepolia: 0,
      mainnet: "0x8Bac178fA95Cb56D11A94d4f1b2B1F5Fc48A30eA",
    },
    redemptionWatchtowerManager: {
      default: 11,
      sepolia: 0,
      mainnet: "0x87F005317692D05BAA4193AB0c961c69e175f45f", // Token Holder DAO
    },
  },
  dependencyCompiler: {
    paths: [
      "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol",
      "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol",
      // WalletRegistry contract is deployed with @open-zeppelin/hardhat-upgrades
      // plugin that doesn't work well with hardhat-deploy artifacts defined in
      // external artifacts section, hence we have to compile the contracts from
      // sources.
      "@keep-network/ecdsa/contracts/WalletRegistry.sol",
      "@keep-network/tbtc-v2/contracts/bridge/Bridge.sol",
      "@keep-network/tbtc-v2/contracts/vault/TBTCVault.sol",
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
    except: ["BridgeStub$"],
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
