/** @format */

import dotenv from 'dotenv';
import { HardhatUserConfig } from 'hardhat/config';
// import '@keep-network/hardhat-helpers';
import '@nomiclabs/hardhat-waffle';
import 'hardhat-gas-reporter';
import 'hardhat-contract-sizer';
import 'hardhat-deploy';
import '@typechain/hardhat';
import 'hardhat-dependency-compiler';
import '@openzeppelin/hardhat-upgrades';
import '@nomiclabs/hardhat-etherscan';

/**
 * Config dotenv first
 */
dotenv.config();

/**
 * Default hardhat configs following Sei tutorial
 */
const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.15",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1000
          }
        }
      }
    ]
  },

  paths: {
    artifacts: "./build",
  },

  // Compile external dependencies so their artifacts are available
  dependencyCompiler: {
    paths: [
      "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol",
    ],
  },

  // Hardhat-deploy configuration
  deploy: ["deploy"],
  
  networks: {
    hardhat: {},
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    // Sei networks following tutorial format
    sei_atlantic_2: {
      url: 'https://evm-rpc-testnet.sei-apis.com',
      chainId: 1328,
      accounts: process.env.ACCOUNTS_PRIVATE_KEYS ? [process.env.ACCOUNTS_PRIVATE_KEYS] : [],
      gas: 'auto',
      gasPrice: 'auto'
    },
    seiTestnet: {
      url: process.env.SEI_TESTNET_RPC_URL || "https://evm-rpc-testnet.sei-apis.com",
      chainId: 1328,
      accounts: process.env.ACCOUNTS_PRIVATE_KEYS ? [process.env.ACCOUNTS_PRIVATE_KEYS] : [],
      tags: ["seitrace"],
      gasPrice: 10000000000, // 10 gwei
    },
    seiMainnet: {
      url: process.env.SEI_MAINNET_RPC_URL || "https://evm-rpc.sei-apis.com",
      chainId: 1329,
      accounts: process.env.ACCOUNTS_PRIVATE_KEYS ? [process.env.ACCOUNTS_PRIVATE_KEYS] : [],
      tags: ["seitrace"],
      gasPrice: 10000000000, // 10 gwei
    },
    "pacific-1": {
      url: process.env.SEI_MAINNET_RPC_URL || "https://evm-rpc.sei-apis.com",
      chainId: 1329,
      accounts: process.env.ACCOUNTS_PRIVATE_KEYS ? [process.env.ACCOUNTS_PRIVATE_KEYS] : [],
      tags: ["seitrace"],
      gasPrice: 10000000000, // 10 gwei
    },
    // BaseSepolia network
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      chainId: 84532,
      accounts: process.env.ACCOUNTS_PRIVATE_KEYS ? [process.env.ACCOUNTS_PRIVATE_KEYS] : [],
      tags: ["basescan"],
      gasPrice: 1000000000, // 1 gwei
    },
    // Ethereum Sepolia network
    ethereumSepolia: {
      url: process.env.ETHEREUM_SEPOLIA_RPC_URL || "https://ethereum-sepolia.publicnode.com",
      chainId: 11155111,
      accounts: process.env.ACCOUNTS_PRIVATE_KEYS ? [process.env.ACCOUNTS_PRIVATE_KEYS] : [],
      tags: ["etherscan"],
      gasPrice: 20000000000, // 20 gwei
    },
  },

  namedAccounts: {
    deployer: {
      default: 0,
      seiTestnet: 0,
      seiMainnet: 0,
      "pacific-1": 0,
      baseSepolia: 0,
      ethereumSepolia: 0,
    },
    governance: {
      default: 1,
      seiTestnet: 0,
      seiMainnet: "0x0000000000000000000000000000000000000000", // TBD - To be determined
      "pacific-1": "0x0000000000000000000000000000000000000000", // TBD - To be determined
      baseSepolia: 0,
      ethereumSepolia: 0,
    },
  },
  
  mocha: {
    timeout: 60_000,
  },
  
  typechain: {
    outDir: "typechain",
  },

  /**
   * Setup verification config for Seitrace
   */
  sourcify: {
    enabled: false
  },
  etherscan: {
    apiKey: {
      "pacific-1": "dummy"
    },
    customChains: [
      {
        network: "pacific-1",
        chainId: 1329,
        urls: {
          apiURL: "https://seitrace.com/pacific-1/api",
          browserURL: "https://seitrace.com/pacific-1",
        },
      },
      {
        network: "sei_atlantic_2",
        chainId: 1328,
        urls: {
          apiURL: "https://seitrace.com/atlantic-2/api",
          browserURL: "https://seitrace.com/atlantic-2",
        },
      }
    ]
  }
};

export default config;
