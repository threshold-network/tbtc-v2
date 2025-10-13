import { HardhatUserConfig } from "hardhat/config"
import "@keep-network/hardhat-helpers"
import "@nomiclabs/hardhat-ethers"
import "@nomiclabs/hardhat-etherscan"
import "@nomiclabs/hardhat-waffle"
import "@openzeppelin/hardhat-upgrades"
import "@typechain/hardhat"
import "hardhat-contract-sizer"
import "hardhat-dependency-compiler"
import "hardhat-deploy"
import "hardhat-gas-reporter"
import "dotenv/config"

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
      {
        version: "0.8.15",
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
    artifacts: "../../solidity/build",
    sources: "./contracts",
    cache: "./cache",
    tests: "./test",
  },

  // Compile external dependencies so their artifacts are available
  dependencyCompiler: {
    paths: [
      "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol",
      "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol",
    ],
  },

  // External configuration to use artifacts from solidity directory
  external: {
    contracts: [
      {
        artifacts: "../../solidity/build",
      },
    ],
  },

  // Hardhat-deploy configuration
  namedAccounts: {
    deployer: {
      default: 0,
    },
    governance: {
      default: 1,
      seiTestnet: 0,
      seiMainnet: "0xd101f2B25bCBF992BdF55dB67c104FE7646F5447", // TokenholderGovernor
    },
  },

  networks: {
    hardhat: {},
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    seiTestnet: {
      url:
        process.env.SEI_TESTNET_RPC_URL ||
        "https://evm-rpc-testnet.sei-apis.com",
      chainId: 1328,
      accounts: process.env.ACCOUNTS_PRIVATE_KEYS
        ? process.env.ACCOUNTS_PRIVATE_KEYS.split(",")
        : [],
      tags: ["seitrace"],
      gasPrice: 10000000000, // 10 gwei
    },
    seiMainnet: {
      url: process.env.SEI_MAINNET_RPC_URL || "https://evm-rpc.sei-apis.com",
      chainId: 1329,
      accounts: process.env.ACCOUNTS_PRIVATE_KEYS
        ? process.env.ACCOUNTS_PRIVATE_KEYS.split(",")
        : [],
      tags: ["seitrace"],
      gasPrice: 10000000000, // 10 gwei
    },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      chainId: 84532,
      accounts: process.env.ACCOUNTS_PRIVATE_KEYS
        ? process.env.ACCOUNTS_PRIVATE_KEYS.split(",")
        : [],
      tags: ["basescan"],
      gasPrice: 1000000000, // 1 gwei
    },
    sepolia: {
      url:
        process.env.SEPOLIA_RPC_URL ||
        "https://ethereum-sepolia.publicnode.com",
      chainId: 11155111,
      accounts: process.env.ACCOUNTS_PRIVATE_KEYS
        ? process.env.ACCOUNTS_PRIVATE_KEYS.split(",")
        : [],
      tags: ["etherscan"],
      gasPrice: 20000000000, // 20 gwei
    },
    mainnet: {
      url: process.env.MAINNET_RPC_URL || "https://ethereum.publicnode.com",
      chainId: 1,
      accounts: process.env.ACCOUNTS_PRIVATE_KEYS
        ? process.env.ACCOUNTS_PRIVATE_KEYS.split(",")
        : [],
      tags: ["etherscan"],
      gasPrice: 20000000000, // 20 gwei
    },
  },

  mocha: {
    timeout: 60_000,
  },

  typechain: {
    outDir: "typechain",
  },

  etherscan: {
    apiKey: {
      seiTestnet: "dummy",
      seiMainnet: "dummy",
    },
    customChains: [
      {
        network: "seiTestnet",
        chainId: 1328,
        urls: {
          apiURL: "https://seitrace.com/atlantic-2/api",
          browserURL: "https://seitrace.com/atlantic-2",
        },
      },
      {
        network: "seiMainnet",
        chainId: 1329,
        urls: {
          apiURL: "https://seitrace.com/pacific-1/api",
          browserURL: "https://seitrace.com/pacific-1",
        },
      },
    ],
  },
}

export default config
