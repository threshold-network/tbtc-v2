import "dotenv/config"
import { HardhatUserConfig } from "hardhat/config"
import "./tasks"

import "@keep-network/hardhat-helpers"
import "@keep-network/hardhat-local-networks-config"
import "@nomiclabs/hardhat-waffle"
import "@nomicfoundation/hardhat-verify"
import "hardhat-gas-reporter"
import "hardhat-contract-sizer"
import "hardhat-deploy"
import "@tenderly/hardhat-tenderly"
import "@typechain/hardhat"
import "hardhat-dependency-compiler"
import "solidity-docgen"
import "@openzeppelin/hardhat-upgrades"

const ecdsaSolidityCompilerConfig = {
  version: "0.8.17",
  settings: {
    optimizer: {
      enabled: true,
      runs: 200,
    },
  },
}

// NOTE: For Etherscan/Tenderly verification we must match the exact optimizer
// runs used at deployment time per-contract. Deployment metadata shows:
// - BridgeGovernanceParameters: runs=1000
// - BridgeGovernance: runs=100 (current Sepolia deployment)
// Others default to 200.
const bridgeGovernanceCompilerConfig = {
  version: "0.8.17",
  settings: {
    optimizer: {
      enabled: true,
      runs: 100,
    },
  },
}

const bridgeGovernanceParametersCompilerConfig = {
  version: "0.8.17",
  settings: {
    optimizer: {
      enabled: true,
      runs: 1000,
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
            runs: 200,
          },
        },
      },
    ],
    overrides: {
      "@keep-network/ecdsa/contracts/WalletRegistry.sol":
        ecdsaSolidityCompilerConfig,
      "contracts/bridge/BridgeGovernance.sol": bridgeGovernanceCompilerConfig,
      "contracts/bridge/BridgeGovernanceParameters.sol":
        bridgeGovernanceParametersCompilerConfig,
      "contracts/cross-chain/wormhole/L1BTCDepositorNttWithExecutor.sol": {
        version: "0.8.17",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1, // Minimal runs to minimize bytecode size
          },
        },
      },
    },
  },

  // Etherscan (V2) configuration
  // Use a single Etherscan.io API key for all supported networks
  // to avoid the deprecated per-network (V1) API key format.
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
    // customChains: [] can be added here for non-Etherscan explorers
  },

  paths: {
    artifacts: "./build",
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
      // For Sepolia we prefer network-specific RPC and key env vars when
      // present, falling back to the generic ones for backwards compatibility.
      url: process.env.SEPOLIA_CHAIN_API_URL || process.env.CHAIN_API_URL || "",
      chainId: 11155111,
      // eslint-disable-next-line no-nested-ternary
      accounts: process.env.SEPOLIA_PRIVATE_KEYS
        ? process.env.SEPOLIA_PRIVATE_KEYS.split(",")
        : process.env.ACCOUNTS_PRIVATE_KEYS
        ? process.env.ACCOUNTS_PRIVATE_KEYS.split(",")
        : undefined,
      tags: ["tenderly"],
    },
    mainnet: {
      url: process.env.CHAIN_API_URL || "",
      chainId: 1,
      accounts: process.env.CONTRACT_OWNER_ACCOUNT_PRIVATE_KEY
        ? [process.env.CONTRACT_OWNER_ACCOUNT_PRIVATE_KEY]
        : undefined,
      tags: ["etherscan", "tenderly"],
      timeout: 300000, // 5 minutes
      httpHeaders: {},
    },
  },

  tenderly: {
    // Allow overriding via env; fall back to empty string so we don't publish
    username: process.env.TENDERLY_USERNAME || "",
    project: process.env.TENDERLY_PROJECT || "",
  },

  // Define local networks configuration file path to load networks from file.
  // localNetworksConfig: "./.hardhat/networks.ts",

  external: {
    contracts:
      process.env.USE_EXTERNAL_DEPLOY === "true"
        ? [
            {
              artifacts: "node_modules/@keep-network/tbtc/artifacts",
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
      sepolia: [
        "node_modules/@keep-network/tbtc/artifacts",
        "node_modules/@keep-network/random-beacon/artifacts",
        "node_modules/@keep-network/ecdsa/artifacts",
      ],
      mainnet: ["./external/mainnet"],
    },
  },

  namedAccounts: {
    deployer: {
      default: 1,
      sepolia: 0,
      mainnet: 0, // "0x123694886DBf5Ac94DDA07135349534536D14cAf"
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
    ],
    keep: true,
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
    require: ["./test/helpers/smock-compat.ts"],
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
