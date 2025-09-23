/**
 * Generic L2TBTC Deployment Functions
 * Supports deployment to multiple networks with encrypted key management
 */

import { ethers } from 'hardhat';
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { secureKeyManager } from './secure-key-manager';

// 🎲 DEPLOYMENT SALT - Fixed salt for consistent CREATE2 deployments
// Change this only when you want completely new contract addresses
const DEPLOYMENT_SALT = "v2.2.0-sei-mainnet-fixed-salt"; // Fixed salt for consistent deployments

export interface NetworkConfig {
  tokenName: string;
  tokenSymbol: string;
  networkName: string;
  explorer: string;
  rpcUrl: string;
}

export interface DeploymentResult {
  proxy: string;
  implementation: string;
  admin: string;
  owner: string;
  network: string;
  transactionHash: string;
}

/**
 * Deploy L2TBTC with TransparentUpgradeableProxy using @openzeppelin/hardhat-upgrades
 */
export async function deployL2TBTC(
  hre: HardhatRuntimeEnvironment,
  networkConfig: NetworkConfig
): Promise<DeploymentResult> {
  const { ethers, upgrades } = hre;

  console.log(`🚀 Deploying L2TBTC on ${networkConfig.networkName}...`);
  console.log(`   Token Name: ${networkConfig.tokenName}`);
  console.log(`   Token Symbol: ${networkConfig.tokenSymbol}`);

  // Get deployer from secure key manager
  console.log('🔐 Loading deployer from encrypted key...');
  const privateKey = await secureKeyManager.getDecryptedKey();
  const wallet = new ethers.Wallet(privateKey);
  const deployer = wallet.address;
  console.log(`✅ Using deployer: ${deployer}`);
  
  // Connect to provider
  const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpcUrl);
  const connectedWallet = wallet.connect(provider);
  
  // Check balance
  const balance = await connectedWallet.getBalance();
  console.log(`💰 Deployer balance: ${ethers.utils.formatEther(balance)} ETH`);
  
  if (balance.eq(0)) {
    throw new Error('Deployer has no ETH for gas fees');
  }

  console.log('\n📦 Deploying L2TBTC with TransparentUpgradeableProxy...');
  console.log(`🧂 Using deployment salt: "${DEPLOYMENT_SALT}"`);
  
  // Deploy using OpenZeppelin upgrades plugin with custom salt
  const L2TBTC = await ethers.getContractFactory('L2TBTC', connectedWallet);
  const proxy = await upgrades.deployProxy(
    L2TBTC,
    [networkConfig.tokenName, networkConfig.tokenSymbol],
    { 
      kind: 'transparent',
      initializer: 'initialize',
      salt: ethers.utils.keccak256(ethers.utils.toUtf8Bytes(DEPLOYMENT_SALT))
    }
  );
  
  await proxy.deployed();
  
  // Get implementation address
  const implementationAddress = await upgrades.erc1967.getImplementationAddress(proxy.address);
  const adminAddress = await upgrades.erc1967.getAdminAddress(proxy.address);

  console.log('\n✅ L2TBTC deployed successfully!');
  console.log(`   Proxy Address: ${proxy.address}`);
  console.log(`   Implementation: ${implementationAddress}`);
  console.log(`   Proxy Admin: ${adminAddress}`);
  console.log(`   Owner: ${deployer}`);
  console.log(`   Explorer: ${networkConfig.explorer}/address/${proxy.address}`);

  // Try to verify contract setup
  console.log('\n🔍 Verifying contract setup...');
  try {
    const owner = await proxy.owner();
    const name = await proxy.name();
    const symbol = await proxy.symbol();
    const totalSupply = await proxy.totalSupply();
    
    console.log(`   Contract Owner: ${owner}`);
    console.log(`   Token Name: ${name}`);
    console.log(`   Token Symbol: ${symbol}`);
    console.log(`   Total Supply: ${ethers.utils.formatEther(totalSupply)} ${symbol}`);

    if (owner.toLowerCase() === deployer.toLowerCase()) {
      console.log('   ✅ Ownership correctly set to deployer');
    } else {
      console.log('   ⚠️  Warning: Owner is not the deployer');
    }
  } catch (error: any) {
    console.log('   ⚠️  Contract verification failed:', error.message);
    console.log('   💡 Use verify-deployment.ts script for detailed verification');
  }

  // Contract verification for block explorers
  if (hre.network.tags?.basescan || hre.network.tags?.seitrace || hre.network.tags?.etherscan) {
    console.log('\n🔍 Verifying contracts on block explorer...');
    
    try {
      await hre.run("verify:verify", {
        address: implementationAddress,
        constructorArguments: []
      });
      console.log('   ✅ Implementation verified');
    } catch (error: any) {
      console.log('   ⚠️  Implementation verification failed:', error.message);
    }

    try {
      await hre.run("verify:verify", {
        address: proxy.address,
        constructorArguments: []
      });
      console.log('   ✅ Proxy verified');
    } catch (error: any) {
      console.log('   ⚠️  Proxy verification failed (common for proxies)');
    }
  }

  // Success summary
  console.log('\n🎉 Deployment completed successfully!');
  console.log('📝 Next steps:');
  console.log('   1. Verify deployment: npx hardhat run scripts/verify-deployment.ts');
  console.log('   2. Add minters: l2tbtc.addMinter(address)');
  console.log('   3. Test minting: l2tbtc.mint(recipient, amount)');

  return {
    proxy: proxy.address,
    implementation: implementationAddress,
    admin: adminAddress,
    owner: deployer,
    network: networkConfig.networkName,
    transactionHash: proxy.deployTransaction.hash
  };
}

/**
 * Network configurations
 */
export const NETWORK_CONFIGS = {
  seiTestnet: {
    tokenName: 'Sei tBTC v2',
    tokenSymbol: 'tBTC',
    networkName: 'Sei Testnet',
    explorer: 'https://seitrace.com',
    rpcUrl: 'https://evm-rpc-testnet.sei-apis.com'
  },
  seiMainnet: {
    tokenName: 'Sei tBTC v2',
    tokenSymbol: 'tBTC',
    networkName: 'Sei Mainnet',
    explorer: 'https://seitrace.com',
    rpcUrl: 'https://evm-rpc.sei-apis.com'
  },
  baseSepolia: {
    tokenName: 'Base tBTC v2',
    tokenSymbol: 'tBTC',
    networkName: 'Base Sepolia',
    explorer: 'https://sepolia.basescan.org',
    rpcUrl: 'https://sepolia.base.org'
  },
  ethereumSepolia: {
    tokenName: 'Ethereum tBTC v2',
    tokenSymbol: 'tBTC',
    networkName: 'Ethereum Sepolia',
    explorer: 'https://sepolia.etherscan.io',
    rpcUrl: 'https://ethereum-sepolia.publicnode.com'
  }
} as const;

/**
 * Legacy main function for direct script execution
 * @deprecated Use hardhat-deploy scripts instead
 */
async function main() {
  console.log('⚠️  This script is deprecated. Use hardhat-deploy instead:');
  console.log('   npx hardhat deploy --network sei_atlantic_2 --tags SeiTestnet');
  console.log('   npx hardhat deploy --network baseSepolia --tags BaseSepolia');
  console.log('   npx hardhat deploy --network ethereumSepolia --tags EthereumSepolia');
  
  const hre = (global as any).hre;
  if (!hre) {
    throw new Error('Hardhat Runtime Environment not available');
  }
  
  const networkName = hre.network.name;
  let config: NetworkConfig;
  
  if (networkName === 'sei_atlantic_2') {
    config = NETWORK_CONFIGS.seiTestnet;
  } else if (networkName === 'seiMainnet') {
    config = NETWORK_CONFIGS.seiMainnet;
  } else if (networkName === 'baseSepolia') {
    config = NETWORK_CONFIGS.baseSepolia;
  } else if (networkName === 'ethereumSepolia') {
    config = NETWORK_CONFIGS.ethereumSepolia;
  } else {
    throw new Error(`Unsupported network: ${networkName}`);
  }
  
  await deployL2TBTC(hre, config);
}

// Export for hardhat-deploy compatibility
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}