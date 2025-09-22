/**
 * Burn tBTC Tokens Script
 * Burns 100 tBTC tokens to return total supply to 0
 */

import { ethers } from 'hardhat';
import { secureKeyManager } from './secure-key-manager';

async function main() {
  console.log('🔥 Burning tBTC tokens...');
  
  // Get deployer from secure key manager
  console.log('🔐 Loading deployer from encrypted key...');
  const privateKey = await secureKeyManager.getDecryptedKey();
  const wallet = new ethers.Wallet(privateKey);
  const deployer = wallet.address;
  console.log(`✅ Using deployer: ${deployer}`);
  
  // Connect to provider
  const provider = new ethers.providers.JsonRpcProvider('https://evm-rpc.sei-apis.com');
  const connectedWallet = wallet.connect(provider);
  
  // Check balance
  const balance = await connectedWallet.getBalance();
  console.log(`💰 Deployer balance: ${ethers.utils.formatEther(balance)} ETH`);
  
  if (balance.eq(0)) {
    throw new Error('Deployer has no ETH for gas fees');
  }
  
  // Contract address (proxy)
  const proxyAddress = '0xF9201c9192249066Aec049ae7951ae298BBEc767';
  
  // Get contract instance
  const L2TBTC = await ethers.getContractFactory('L2TBTC', connectedWallet);
  const l2tbtc = L2TBTC.attach(proxyAddress);
  
  console.log('\n📋 Contract Information:');
  console.log(`   Proxy Address: ${proxyAddress}`);
  console.log(`   Network: Sei Pacific-1`);
  console.log(`   Explorer: https://seitrace.com/pacific-1/address/${proxyAddress}`);
  
  try {
    // Check current state
    console.log('\n🔍 Checking current contract state...');
    const owner = await l2tbtc.owner();
    const name = await l2tbtc.name();
    const symbol = await l2tbtc.symbol();
    const totalSupply = await l2tbtc.totalSupply();
    const deployerBalance = await l2tbtc.balanceOf(deployer);
    const isMinter = await l2tbtc.isMinter(deployer);
    
    console.log(`   Contract Owner: ${owner}`);
    console.log(`   Token Name: ${name}`);
    console.log(`   Token Symbol: ${symbol}`);
    console.log(`   Total Supply: ${ethers.utils.formatEther(totalSupply)} ${symbol}`);
    console.log(`   Deployer Balance: ${ethers.utils.formatEther(deployerBalance)} ${symbol}`);
    console.log(`   Is Deployer Minter: ${isMinter}`);
    
    if (owner.toLowerCase() !== deployer.toLowerCase()) {
      throw new Error('Deployer is not the contract owner');
    }
    
    if (!isMinter) {
      throw new Error('Deployer is not a minter');
    }
    
    if (deployerBalance.eq(0)) {
      console.log('   ℹ️  Deployer has no tokens to burn');
      return;
    }
    
    // Burn tokens
    console.log('\n🔥 Burning tokens...');
    const burnAmount = deployerBalance; // Burn all available tokens
    
    console.log(`   Burning ${ethers.utils.formatEther(burnAmount)} ${symbol}...`);
    
    const burnTx = await l2tbtc.burn(burnAmount);
    console.log(`   Transaction hash: ${burnTx.hash}`);
    
    console.log('   ⏳ Waiting for transaction confirmation...');
    await burnTx.wait();
    console.log('   ✅ Burn transaction confirmed!');
    
    // Verify final state
    console.log('\n🔍 Verifying final contract state...');
    const finalTotalSupply = await l2tbtc.totalSupply();
    const finalDeployerBalance = await l2tbtc.balanceOf(deployer);
    
    console.log(`   Final Total Supply: ${ethers.utils.formatEther(finalTotalSupply)} ${symbol}`);
    console.log(`   Final Deployer Balance: ${ethers.utils.formatEther(finalDeployerBalance)} ${symbol}`);
    
    if (finalTotalSupply.eq(0)) {
      console.log('   ✅ Successfully burned all tokens! Total supply is now 0');
    } else {
      console.log('   ⚠️  Warning: Total supply is not 0 after burn');
    }
    
    console.log('\n🎉 Token burning completed successfully!');
    console.log(`🔗 View on explorer: https://seitrace.com/pacific-1/address/${proxyAddress}`);
    
  } catch (error: any) {
    console.error('❌ Token burning failed:', error.message);
    throw error;
  }
}

// Run the script
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
