/**
 * Generic L2TBTC Deployment Verification Script
 * Tests deployed L2TBTC contracts on multiple networks
 * 
 * Supports:
 * - Sei Testnet (sei_atlantic_2)
 * - Base Sepolia (baseSepolia)
 * 
 * Usage:
 * - PROXY_ADDRESS=0x... npx hardhat run scripts/verify-deployment.ts --network <network>
 * - Or use network-specific deploy scripts for automated verification
 */

import { ethers } from 'hardhat';
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { secureKeyManager } from './secure-key-manager';

export interface VerificationResult {
  proxy: string;
  network: string;
  owner: string;
  isMinter: boolean;
  totalSupply: string;
  success: boolean;
}

/**
 * Generic verification function that can be used by deploy scripts
 */
export async function verifyDeployment(
  hre: HardhatRuntimeEnvironment,
  proxyAddress: string
): Promise<VerificationResult> {
  console.log('🔍 Verifying L2TBTC deployment...');
  console.log(`📋 Using proxy address: ${proxyAddress}`);

  // Get deployer from secure key manager
  console.log('🔐 Loading deployer from encrypted key...');
  const privateKey = await secureKeyManager.getDecryptedKey();
  const wallet = new ethers.Wallet(privateKey);
  const deployer = wallet.address;
  console.log(`✅ Using deployer: ${deployer}`);
  
  // Get network info from hardhat context
  const networkName = hre?.network?.name || 'unknown';
  
  // Network-specific configuration
  const networkConfigs: Record<string, { rpcUrl: string; explorer: string; name: string }> = {
    'sei_atlantic_2': {
      rpcUrl: 'https://evm-rpc-testnet.sei-apis.com',
      explorer: 'https://seitrace.com',
      name: 'Sei Testnet'
    },
    'baseSepolia': {
      rpcUrl: 'https://sepolia.base.org',
      explorer: 'https://sepolia.basescan.org',
      name: 'Base Sepolia'
    }
  };
  
  const networkConfig = networkConfigs[networkName];
  if (!networkConfig) {
    throw new Error(`Unsupported network: ${networkName}. Supported: ${Object.keys(networkConfigs).join(', ')}`);
  }
  
  // Connect to network
  const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpcUrl);
  const connectedWallet = wallet.connect(provider);
  
  console.log('\n📋 Contract Information:');
  console.log(`   Proxy Address: ${proxyAddress}`);
  console.log(`   Network: ${networkConfig.name}`);
  console.log(`   Explorer: ${networkConfig.explorer}/address/${proxyAddress}`);
  
  // Check ETH balance
  const ethBalance = await connectedWallet.getBalance();
  console.log(`💰 Deployer balance: ${ethers.utils.formatEther(ethBalance)} ETH`);
  
  try {
    // Get contract instance
    const L2TBTC = await ethers.getContractFactory('L2TBTC', connectedWallet);
    const l2tbtc = L2TBTC.attach(proxyAddress);
    
    console.log('\n🔍 Reading contract state...');
    
    // Basic contract calls
    const owner = await l2tbtc.owner();
    const name = await l2tbtc.name();
    const symbol = await l2tbtc.symbol();
    const decimals = await l2tbtc.decimals();
    const totalSupply = await l2tbtc.totalSupply();
    
    console.log(`   Contract Owner: ${owner}`);
    console.log(`   Token Name: ${name}`);
    console.log(`   Token Symbol: ${symbol}`);
    console.log(`   Decimals: ${decimals}`);
    console.log(`   Total Supply: ${ethers.utils.formatEther(totalSupply)} ${symbol}`);
    
    // Check minter status
    const isMinter = await l2tbtc.isMinter(deployer);
    console.log(`   Is Deployer Minter: ${isMinter}`);
    
    // Get all minters
    try {
      const minters = await l2tbtc.getMinters();
      console.log(`   All Minters: ${minters.length === 0 ? 'None' : minters.join(', ')}`);
    } catch (error) {
      console.log('   All Minters: Unable to fetch (function may not exist)');
    }
    
    // Verify ownership
    if (owner.toLowerCase() === deployer.toLowerCase()) {
      console.log('   ✅ Ownership correctly set to deployer');
      
      if (!isMinter) {
        console.log('\n🪙 Adding deployer as minter...');
        const addMinterTx = await l2tbtc.addMinter(deployer);
        console.log(`   Transaction hash: ${addMinterTx.hash}`);
        await addMinterTx.wait();
        console.log('   ✅ Deployer added as minter');
        
        // Test minting
        console.log('\n💰 Testing token minting...');
        const mintAmount = ethers.utils.parseEther('100'); // 100 tokens
        const mintTx = await l2tbtc.mint(deployer, mintAmount);
        console.log(`   Transaction hash: ${mintTx.hash}`);
        await mintTx.wait();
        console.log('   ✅ Successfully minted 100 tokens');
        
        // Check final balance
        const finalBalance = await l2tbtc.balanceOf(deployer);
        const finalTotalSupply = await l2tbtc.totalSupply();
        console.log(`   Final Balance: ${ethers.utils.formatEther(finalBalance)} ${symbol}`);
        console.log(`   Final Total Supply: ${ethers.utils.formatEther(finalTotalSupply)} ${symbol}`);
      } else {
        console.log('   ✅ Deployer is already a minter');
      }
    } else {
      console.log('   ⚠️  Warning: Owner is not the deployer');
      console.log(`   Expected: ${deployer}`);
      console.log(`   Actual: ${owner}`);
    }
    
    console.log('\n🎉 Contract verification completed successfully!');
    console.log(`🔗 View on explorer: ${networkConfig.explorer}/address/${proxyAddress}`);
    
    return {
      proxy: proxyAddress,
      network: networkConfig.name,
      owner,
      isMinter,
      totalSupply: ethers.utils.formatEther(totalSupply),
      success: true
    };
    
  } catch (error: any) {
    console.error('❌ Verification failed:', error.message);
    
    // Provide debugging information
    console.log('\n🔧 Debugging Information:');
    console.log(`   Error type: ${error.constructor.name}`);
    console.log(`   Error code: ${error.code || 'Unknown'}`);
    
    if (error.message.includes('call')) {
      console.log('   💡 This looks like a contract interaction issue');
      console.log('   💡 The contract might not be properly initialized');
      console.log('   💡 Try waiting a few blocks and running again');
    }
    
    throw error;
  }
}

/**
 * Legacy main function for direct script execution
 */
async function main() {
  // Contract address from environment variable or fallback to latest deployment
  const proxyAddress = process.env.PROXY_ADDRESS || '0x7fE80D5A582393715C5f6381F42E8Ce6Ff584ef4';
  
  if (!proxyAddress) {
    throw new Error('Please provide PROXY_ADDRESS environment variable');
  }
  
  const hre = (global as any).hre;
  if (!hre) {
    throw new Error('Hardhat Runtime Environment not available');
  }
  
  await verifyDeployment(hre, proxyAddress);
}

// Export for hardhat-deploy compatibility
if (require.main === module) {
  main().catch((error) => {
    console.error('Script failed:', error);
    process.exitCode = 1;
  });
}