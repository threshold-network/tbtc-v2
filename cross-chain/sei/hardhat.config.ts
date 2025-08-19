/** @format */

import dotenv from 'dotenv';
import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-verify';
import '@keep-network/hardhat-helpers';
import '@nomiclabs/hardhat-waffle';
import 'hardhat-gas-reporter';
import 'hardhat-contract-sizer';
import 'hardhat-deploy';
import '@typechain/hardhat';
import 'hardhat-dependency-compiler';
import '@openzeppelin/hardhat-upgrades';
import { secureKeyManager } from './scripts/secure-key-manager';

/**
 * Config dotenv first
 */
dotenv.config();

/**
 * Get private key for deployment
 */
async function getPrivateKey(): Promise<string> {
  try {
    return await secureKeyManager.getDecryptedKey();
  } catch (error) {
    console.warn('No encrypted key found, using empty accounts array');
    return '';
  }
}

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
    // BaseSepolia network
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      chainId: 84532,
      accounts: [], // Will be populated by getPrivateKey() when needed
      tags: ["basescan"],
      gasPrice: 1000000000, // 1 gwei
    },
  },

  namedAccounts: {
    deployer: {
      default: 0,
      seiTestnet: 0,
      seiMainnet: 0,
      baseSepolia: 0,
    },
    governance: {
      default: 1,
      seiTestnet: 0,
      seiMainnet: "0x0000000000000000000000000000000000000000", // TBD - To be determined
      baseSepolia: 0,
    },
  },
  
  mocha: {
    timeout: 60_000,
  },
  
  typechain: {
    outDir: "typechain",
  },

  /**
   * Setup verification config with new hardhat-verify plugin
   */
  sourcify: {
    enabled: false
  },
  etherscan: {
    enabled: true,
    apiKey: process.env.ETHERSCAN_API_KEY, // Using Etherscan v2 API key from env
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
      {
        network: "baseSepolia",
        chainId: 84532,
        urls: {
          apiURL: "https://api-sepolia.basescan.org/api",
          browserURL: "https://sepolia.basescan.org",
        },
      },
    ]
  }
};

export default config;