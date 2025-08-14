/**
 * Deploy L2TBTC using encrypted private key management
 * Following Sei tutorial with secure key decryption on-demand
 */

import { ethers } from 'hardhat';
import { secureKeyManager } from './secure-key-manager';

async function main() {
  console.log('🚀 Deploying L2TBTC on Sei Testnet with encrypted key...');
  
  // Check if encrypted key exists
  if (!secureKeyManager.hasEncryptedKey()) {
    console.error('❌ No encrypted private key found!');
    console.log('💡 Run: npm run setup-key');
    process.exit(1);
  }

  try {
    // Decrypt private key on-demand
    console.log('🔐 Decrypting private key...');
    const privateKey = await secureKeyManager.getDecryptedKey();
    
    // Create wallet from decrypted key
    const wallet = new ethers.Wallet(privateKey);
    console.log('✅ Using wallet:', wallet.address);
    
    // Connect to Sei Testnet provider
    const provider = new ethers.providers.JsonRpcProvider('https://evm-rpc-testnet.sei-apis.com');
    const connectedWallet = wallet.connect(provider);
    
    // Check balance
    const balance = await connectedWallet.getBalance();
    console.log('💰 Wallet balance:', ethers.utils.formatEther(balance), 'SEI');
    
    if (balance.eq(0)) {
      console.error('❌ Wallet has no SEI tokens for gas fees');
      process.exit(1);
    }

    // Deploy L2TBTC implementation
    console.log('📦 Deploying L2TBTC implementation...');
    const L2TBTC = await ethers.getContractFactory('L2TBTC', connectedWallet);
    const implementation = await L2TBTC.deploy();
    await implementation.deployed();
    
    console.log('✅ Implementation deployed:', implementation.address);
    console.log('📋 Transaction:', implementation.deployTransaction.hash);

    // Encode initialize data
    const initData = L2TBTC.interface.encodeFunctionData('initialize', ['tBTC', 'tBTC']);
    
    // Deploy TransparentUpgradeableProxy
    console.log('🚀 Deploying TransparentUpgradeableProxy...');
    const ProxyFactory = await ethers.getContractFactory('TransparentUpgradeableProxy', connectedWallet);
    const proxy = await ProxyFactory.deploy(
      implementation.address,
      wallet.address, // Admin
      initData
    );
    await proxy.deployed();
    
    console.log('✅ Proxy (L2TBTC) deployed:', proxy.address);
    console.log('📋 Transaction:', proxy.deployTransaction.hash);
    console.log('🔐 Admin:', wallet.address);

    // Verification
    console.log('\n🔍 Verifying contracts...');
    
    try {
      console.log('Verifying implementation...');
      await hre.run('verify:verify', {
        address: implementation.address,
        constructorArguments: [],
        network: 'sei_atlantic_2'
      });
      console.log('✅ Implementation verified');
    } catch (error) {
      console.log('⚠️  Implementation verification failed or already verified');
    }

    try {
      console.log('Verifying proxy...');
      await hre.run('verify:verify', {
        address: proxy.address,
        network: 'sei_atlantic_2'
      });
      console.log('✅ Proxy verified');
    } catch (error) {
      console.log('⚠️  Proxy verification failed or already verified');
    }

    console.log('\n🎉 Deployment completed successfully!');
    console.log('📋 Summary:');
    console.log('   L2TBTC (Proxy):', proxy.address);
    console.log('   Implementation:', implementation.address);
    console.log('   Admin:', wallet.address);
    console.log('   Explorer: https://seitrace.com/atlantic-2/address/' + proxy.address);

  } catch (error: any) {
    console.error('❌ Deployment failed:', error.message);
    process.exit(1);
  }
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});