import { HardhatRuntimeEnvironment } from "hardhat/types"
import { DeployFunction } from "hardhat-deploy/types"

/**
 * L1BTCDepositorNtt Deployment Script
 * 
 * Deploys L1BTCDepositorNtt contract for Hub-and-Spoke Bitcoin deposits
 * Supports multiple networks with proper configuration for each
 * 
 * Usage:
 *   npx hardhat deploy --network baseSepolia --tags L1BTCDepositorNtt
 *   npx hardhat deploy --network sepolia --tags L1BTCDepositorNtt  
 *   npx hardhat deploy --network seiTestnet --tags L1BTCDepositorNtt
 *   npx hardhat deploy --network seiMainnet --tags L1BTCDepositorNtt
 *   npx hardhat deploy --network mainnet --tags L1BTCDepositorNtt
 */

interface NetworkConfig {
  // Threshold Protocol Addresses
  bridge: string;
  tbtcVault: string;
  tbtcToken: string;
  
  // NTT Manager Addresses
  nttManager: string;
  
  // Wormhole Chain IDs for destination chains
  supportedChains: { chainId: number; name: string }[];
  
  // Network specific settings
  gasPrice?: string;
  verifyContract: boolean;
}

const NETWORK_CONFIGS: Record<string, NetworkConfig> = {
  // Base Sepolia Testnet
  baseSepolia: {
    bridge: "0x0000000000000000000000000000000000000000", // TODO: Add Base Sepolia Bridge address
    tbtcVault: "0x0000000000000000000000000000000000000000", // TODO: Add Base Sepolia TBTCVault address
    tbtcToken: "0xdDFeABcCf2063CD66f53a1218e23c681Ba6e7962", // Base Sepolia tBTC from NTT test config
    nttManager: "0x8b9E328bE1b1Bc7501B413d04EBF7479B110775c", // Base Sepolia NTT Manager from test config
    supportedChains: [
      { chainId: 32, name: "Sei" }, // Sei Wormhole Chain ID
      { chainId: 10002, name: "Sepolia" }, // Ethereum Sepolia
    ],
    gasPrice: "1000000000", // 1 gwei
    verifyContract: true,
  },

  // Ethereum Sepolia Testnet
  sepolia: {
    bridge: "0x0000000000000000000000000000000000000000", // TODO: Add Sepolia Bridge address
    tbtcVault: "0x0000000000000000000000000000000000000000", // TODO: Add Sepolia TBTCVault address  
    tbtcToken: "0x738141EFf659625F2eAD4feECDfCD94155C67f18", // Sepolia tBTC from NTT test config
    nttManager: "0x06413c42e913327Bc9a08B7C1E362BAE7C0b9598", // Sepolia NTT Manager from test config
    supportedChains: [
      { chainId: 10004, name: "Base Sepolia" }, // Base Sepolia Wormhole Chain ID
      { chainId: 32, name: "Sei" }, // Sei Wormhole Chain ID
    ],
    gasPrice: "20000000000", // 20 gwei
    verifyContract: true,
  },

  // Sei Testnet (Arctic)  
  seiTestnet: {
    bridge: "0x0000000000000000000000000000000000000000", // TODO: Add Sei Testnet Bridge address if applicable
    tbtcVault: "0x0000000000000000000000000000000000000000", // TODO: Add Sei Testnet TBTCVault address if applicable
    tbtcToken: "0x0000000000000000000000000000000000000000", // TODO: Add Sei Testnet tBTC token address
    nttManager: "0x0000000000000000000000000000000000000000", // TODO: Deploy NTT Manager on Sei Testnet
    supportedChains: [
      { chainId: 10002, name: "Sepolia" }, // Ethereum Sepolia as Hub
      { chainId: 10004, name: "Base Sepolia" }, // Base Sepolia
    ],
    gasPrice: "20000000000", // 20 gwei equivalent
    verifyContract: true,
  },

  // Sei Mainnet (Pacific)
  seiMainnet: {
    bridge: "0x0000000000000000000000000000000000000000", // TODO: Add Sei Mainnet Bridge address if applicable
    tbtcVault: "0x0000000000000000000000000000000000000000", // TODO: Add Sei Mainnet TBTCVault address if applicable  
    tbtcToken: "0x0000000000000000000000000000000000000000", // TODO: Add Sei Mainnet tBTC token address
    nttManager: "0x0000000000000000000000000000000000000000", // TODO: Deploy NTT Manager on Sei Mainnet
    supportedChains: [
      { chainId: 2, name: "Ethereum" }, // Ethereum Mainnet as Hub
      { chainId: 8453, name: "Base" }, // Base Mainnet
    ],
    gasPrice: "20000000000", // 20 gwei equivalent
    verifyContract: true,
  },

  // Ethereum Mainnet
  mainnet: {
    bridge: "0x5e4861a80B55f035D899f66772b54e65D5E4221f", // Ethereum Mainnet Bridge address
    tbtcVault: "0x9C070027cdC9dc8F82416B2e5314E11DFb4FE3CD", // Ethereum Mainnet TBTCVault address
    tbtcToken: "0x18084fbA666a33d37592fA2633fD49a74DD93a88", // Ethereum Mainnet tBTC token address
    nttManager: "0x0000000000000000000000000000000000000000", // TODO: Deploy NTT Manager on Ethereum Mainnet
    supportedChains: [
      { chainId: 32, name: "Sei" }, // Sei Mainnet
      { chainId: 8453, name: "Base" }, // Base Mainnet  
      { chainId: 10, name: "Optimism" }, // Optimism Mainnet
      { chainId: 4, name: "Polygon" }, // Polygon Mainnet
    ],
    gasPrice: "30000000000", // 30 gwei
    verifyContract: true,
  },
};

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy, log, get } = deployments;
  const { deployer, governance } = await getNamedAccounts();

  const networkName = network.name;
  const config = NETWORK_CONFIGS[networkName];

  if (!config) {
    throw new Error(`No configuration found for network: ${networkName}`);
  }

  log(`Deploying L1BTCDepositorNtt on ${networkName}...`);

  // Validate configuration
  const hasZeroAddresses = [
    config.bridge,
    config.tbtcVault, 
    config.tbtcToken,
    config.nttManager
  ].some(addr => addr === "0x0000000000000000000000000000000000000000");

  if (hasZeroAddresses) {
    log("⚠️  WARNING: Some addresses are placeholder values (0x0000...)");
    log("   Please update the configuration with actual deployed contract addresses");
  }

  // Deploy the L1BTCDepositorNtt contract
  const l1BtcDepositorNtt = await deploy("L1BTCDepositorNtt", {
    from: deployer,
    log: true,
    waitConfirmations: network.live ? 3 : 1,
    gasPrice: config.gasPrice,
    proxy: {
      proxyContract: "TransparentUpgradeableProxy",
      viaAdminContract: {
        name: "ProxyAdmin",
        artifact: "ProxyAdmin",
      },
      execute: {
        init: {
          methodName: "initialize",
          args: [
            config.bridge,
            config.tbtcVault,
            config.nttManager, 
            config.tbtcToken,
          ],
        },
      },
    },
  });

  log(`✅ L1BTCDepositorNtt deployed at: ${l1BtcDepositorNtt.address}`);

  // Configure supported chains
  if (l1BtcDepositorNtt.newlyDeployed && config.supportedChains.length > 0) {
    log("🔧 Configuring supported destination chains...");
    
    const contract = await hre.ethers.getContractAt(
      "L1BTCDepositorNtt", 
      l1BtcDepositorNtt.address
    );

    for (const chain of config.supportedChains) {
      try {
        const tx = await contract.setSupportedChain(chain.chainId, true);
        await tx.wait();
        log(`   ✅ Added supported chain: ${chain.name} (ID: ${chain.chainId})`);
      } catch (error) {
        log(`   ❌ Failed to add chain ${chain.name}: ${error.message}`);
      }
    }
  }

  // Contract verification
  if (config.verifyContract && network.live) {
    log("🔍 Verifying contract...");
    try {
      await hre.run("verify:verify", {
        address: l1BtcDepositorNtt.address,
        constructorArguments: [],
      });
      log("✅ Contract verified successfully");
    } catch (error) {
      log(`❌ Contract verification failed: ${error.message}`);
    }
  }

  // Output deployment summary
  log("\n📋 Deployment Summary:");
  log(`   Network: ${networkName}`);
  log(`   Contract: ${l1BtcDepositorNtt.address}`);
  log(`   Bridge: ${config.bridge}`);
  log(`   TBTCVault: ${config.tbtcVault}`);
  log(`   tBTC Token: ${config.tbtcToken}`);
  log(`   NTT Manager: ${config.nttManager}`);
  log(`   Supported Chains: ${config.supportedChains.map(c => `${c.name}(${c.chainId})`).join(", ")}`);

  // Post-deployment instructions
  log("\n🚀 Next Steps:");
  log("1. Update any placeholder addresses (0x0000...) with actual contract addresses");
  log("2. Configure NTT Manager peers for cross-chain transfers");
  log("3. Set appropriate rate limits on the NTT Manager");
  log("4. Test deposits and cross-chain transfers on testnet");
  log("5. Transfer ownership to governance/multisig if needed");

  return true;
};

func.tags = ["L1BTCDepositorNtt"];
func.dependencies = []; // Add dependencies if needed

export default func;
