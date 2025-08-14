/** @format */

import dotenv from 'dotenv';
import { HardhatUserConfig } from 'hardhat/config';
import '@nomiclabs/hardhat-etherscan';
import '@keep-network/hardhat-helpers';
import '@nomiclabs/hardhat-waffle';
import 'hardhat-gas-reporter';
import 'hardhat-contract-sizer';
import 'hardhat-deploy';
import '@typechain/hardhat';
import 'hardhat-dependency-compiler';
import '@openzeppelin/hardhat-upgrades';

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

  networks: {
    hardhat: {
      deploy: [
        "scripts",
      ],
    },
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    // Sei networks following tutorial format
    sei_atlantic_2: {
      url: 'https://evm-rpc-testnet.sei-apis.com',
      chainId: 1328,
      accounts: [], // Will be populated by getPrivateKey() when needed
      gas: 'auto',
      gasPrice: 'auto'
    },
    seiTestnet: {
      url: process.env.SEI_TESTNET_RPC_URL || "https://evm-rpc-testnet.sei-apis.com",
      chainId: 1328,
      accounts: [], // Will be populated by getPrivateKey() when needed
      tags: ["seitrace"],
      gasPrice: 10000000000, // 10 gwei
    },
    seiMainnet: {
      url: process.env.SEI_MAINNET_RPC_URL || "https://evm-rpc.sei-apis.com",
      chainId: 1329,
      accounts: [], // Will be populated by getPrivateKey() when needed
      tags: ["seitrace"],
      gasPrice: 10000000000, // 10 gwei
    },
  },

  namedAccounts: {
    deployer: {
      default: 0,
      seiTestnet: 0,
      seiMainnet: 0,
    },
    governance: {
      default: 1,
      seiTestnet: 0,
      seiMainnet: "0x9f6e831c8f8939dc0c830c6e492e7cef4f9c2f5f", // Threshold Council
    },
  },
  
  mocha: {
    timeout: 60_000,
  },
  
  typechain: {
    outDir: "typechain",
  },

  /**
   * Setup etherscan config following Sei tutorial
   */
  etherscan: {
    apiKey: {
      sei_atlantic_2: 'dummy',
      seiTestnet: "dummy",
      seiMainnet: "dummy",
    },
    customChains: [
      {
        network: 'sei_atlantic_2',
        chainId: 1328,
        urls: {
          apiURL: 'https://seitrace.com/atlantic-2/api',
          browserURL: 'https://seitrace.com'
        }
      },
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
    ]
  }
};

export default config;