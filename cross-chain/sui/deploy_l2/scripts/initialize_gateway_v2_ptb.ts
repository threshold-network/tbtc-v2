#!/usr/bin/env node

/**
 * Initialize Gateway V2 using a Programmable Transaction Block
 * This combines add_minter_with_cap and initialize_gateway in one atomic transaction
 */

import { TransactionBlock } from '@mysten/sui.js/transactions';
import { SuiClient } from '@mysten/sui.js/client';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui.js/keypairs/secp256k1';
import { fromB64 } from '@mysten/sui.js/utils';

// V6 Testnet deployment configuration (with standard withdrawal support)
const CONFIG = {
  network: 'testnet',
  packageId: '0x3d78316ce8ee3fe48d7ff85cdc2d0df9d459f43d802d96f58f7b59984c2dd3ae',
  
  // Admin capabilities
  adminCaps: {
    tbtc: '0xe9a63c6f92f6deb510c02277415b7d77767c51a6f7f6bd5b396f62dc636e8afb',
    gateway: '0xe766382bb09702bbfe0bc5bcf0c2765e72033f0386da98c3eac1476277f4ef01',
    treasuryCap: '0x1e985914c3f7436c70f466ffe4efd12aeb525864dcc3bc9454d0c0bb363eb8fd',
    bitcoinDepositor: '0x1b66f0f520c1234445ce69b7fb9275fa5087de3ff8db1746b2f7903e29f294f3',
  },
  
  // Shared objects
  sharedObjects: {
    tokenState: '0x0d59e4970772269ee917280da592089c7de389ed67164ce4c07ed508917fdf08',
    gatewayState: '0x19ab17536712e3e2efa9a1c01acbf5c09ae53e969cb9046dc382f5f49b603d52',
    receiverState: '0x10f421d7960be14c07057fd821332ee8a9d717873c62e7fa370fa99913e8e924',
  },
  
  // Wormhole configuration
  wormhole: {
    coreState: '0x31358d198147da50db32eda2562951d53973a0c0ad5ed738e9b17d88b213d790',
    // The wrapped tBTC type from Sepolia attestation
    wrappedTbtcType: '0xb501e7f0b86ad34eb634835069be3dad295b6a4af139986bcd5447f1ad0a2b94::coin::COIN',
  },
  
  // Initialization parameters
  initialization: {
    mintingLimit: '18446744073709551615', // u64::MAX
  }
};

async function initializeGatewayV2() {
  console.log('🚀 Initializing Gateway V6 with Standard Withdrawal Support\n');
  
  // Setup client
  const client = new SuiClient({ 
    url: `https://fullnode.${CONFIG.network}.sui.io:443` 
  });
  
  // Get keypair from environment variable
  const privateKeyB64 = process.env.SUI_PRIVATE_KEY;
  if (!privateKeyB64) {
    console.error('❌ Error: SUI_PRIVATE_KEY environment variable not set');
    console.error('Please export your private key in base64 format:');
    console.error('export SUI_PRIVATE_KEY=$(sui keytool export --key-scheme ed25519)');
    process.exit(1);
  }
  
  let keypair: Ed25519Keypair | Secp256k1Keypair;
  try {
    // Decode the base64 key
    const privateKeyBytes = fromB64(privateKeyB64);
    
    // Check if it's 33 bytes (with prefix) or 32 bytes
    if (privateKeyBytes.length === 33) {
      const schemeFlag = privateKeyBytes[0];
      const actualKey = privateKeyBytes.slice(1);
      
      // Check the scheme flag
      if (schemeFlag === 0x00) {
        // Ed25519
        keypair = Ed25519Keypair.fromSecretKey(actualKey);
      } else if (schemeFlag === 0x01) {
        // Secp256k1
        keypair = Secp256k1Keypair.fromSecretKey(actualKey);
      } else {
        throw new Error(`Unknown key scheme flag: ${schemeFlag}`);
      }
    } else if (privateKeyBytes.length === 32) {
      // Assume Ed25519 if no prefix
      keypair = Ed25519Keypair.fromSecretKey(privateKeyBytes);
    } else {
      throw new Error(`Invalid private key length: ${privateKeyBytes.length}. Expected 32 or 33 bytes.`);
    }
  } catch (error) {
    console.error('❌ Error parsing private key:', error);
    console.error('Make sure your private key is exported from SUI CLI in base64 format');
    process.exit(1);
  }
  
  const adminAddress = keypair.getPublicKey().toSuiAddress();
  console.log('Admin Address:', adminAddress);
  console.log('Network:', CONFIG.network);
  console.log('Package ID:', CONFIG.packageId);
  console.log('New Feature: Standard withdrawal support (send_tokens_standard)');
  console.log('');
  
  // Check Gateway state
  console.log('📊 Checking Gateway state...');
  const gatewayState = await client.getObject({
    id: CONFIG.sharedObjects.gatewayState,
    options: { showContent: true }
  });
  
  const gatewayContent = gatewayState.data?.content as any;
  const isInitialized = gatewayContent?.fields?.is_initialized;
  
  if (isInitialized) {
    console.log('✅ Gateway is already initialized!');
    return;
  }
  
  console.log('Gateway is not initialized, proceeding...\n');
  
  // Check if Gateway is already a minter
  console.log('📊 Checking minters list...');
  const tokenState = await client.getObject({
    id: CONFIG.sharedObjects.tokenState,
    options: { showContent: true }
  });
  
  const tokenContent = tokenState.data?.content as any;
  const minters = tokenContent?.fields?.minters || [];
  
  if (minters.includes(CONFIG.sharedObjects.gatewayState)) {
    console.log('⚠️  Gateway is already in the minters list!');
    console.log('Cannot proceed with initialization - MinterCap might be stuck.');
    return;
  }
  
  console.log('Gateway is not a minter yet, proceeding with PTB...\n');
  
  // Build Programmable Transaction Block
  const tx = new TransactionBlock();
  
  console.log('🔧 Building Programmable Transaction Block...');
  console.log('This will atomically:');
  console.log('1. Add Gateway as minter and receive MinterCap');
  console.log('2. Initialize Gateway with the MinterCap\n');
  
  // Step 1: Add Gateway as minter and receive MinterCap
  const [minterCap] = tx.moveCall({
    target: `${CONFIG.packageId}::TBTC::add_minter_with_cap`,
    arguments: [
      tx.object(CONFIG.adminCaps.tbtc),
      tx.object(CONFIG.sharedObjects.tokenState),
      tx.pure(CONFIG.sharedObjects.gatewayState),
    ],
  });
  
  // Step 2: Initialize Gateway with MinterCap
  tx.moveCall({
    target: `${CONFIG.packageId}::Gateway::initialize_gateway`,
    arguments: [
      tx.object(CONFIG.adminCaps.gateway),
      tx.object(CONFIG.sharedObjects.gatewayState),
      tx.object(CONFIG.wormhole.coreState),
      minterCap, // MinterCap from Step 1
      tx.object(CONFIG.adminCaps.treasuryCap),
    ],
    typeArguments: [CONFIG.wormhole.wrappedTbtcType],
  });
  
  // Set gas budget and sender
  tx.setGasBudget(200_000_000); // 0.2 SUI
  tx.setSender(adminAddress);
  
  console.log('⚠️  Transaction Preview:');
  console.log('- Step 1: add_minter_with_cap');
  console.log('  - Admin Cap:', CONFIG.adminCaps.tbtc);
  console.log('  - Token State:', CONFIG.sharedObjects.tokenState);
  console.log('  - Gateway Address:', CONFIG.sharedObjects.gatewayState);
  console.log('- Step 2: initialize_gateway');
  console.log('  - Gateway Admin Cap:', CONFIG.adminCaps.gateway);
  console.log('  - Gateway State:', CONFIG.sharedObjects.gatewayState);
  console.log('  - Wormhole State:', CONFIG.wormhole.coreState);
  console.log('  - MinterCap: (from Step 1)');
  console.log('  - Treasury Cap:', CONFIG.adminCaps.treasuryCap);
  console.log('  - Wrapped Type:', CONFIG.wormhole.wrappedTbtcType);
  
  // Dry run first
  console.log('\n🧪 Performing dry run...');
  try {
    const dryRun = await client.dryRunTransactionBlock({
      transactionBlock: await tx.build({ client }),
    });
    
    if (dryRun.effects.status.status === 'success') {
      console.log('✅ Dry run successful!');
      console.log('Gas used:', dryRun.effects.gasUsed);
      
      // Show objects to be created
      if (dryRun.effects.created && dryRun.effects.created.length > 0) {
        console.log('\nObjects to be created:');
        dryRun.effects.created.forEach((obj: any) => {
          console.log(`- ${obj.reference.objectId}`);
        });
      }
    } else {
      console.error('❌ Dry run failed:', dryRun.effects.status.error);
      return;
    }
  } catch (error) {
    console.error('❌ Dry run error:', error);
    return;
  }
  
  // Confirm execution
  console.log('\n⚠️  Ready to execute transaction.');
  console.log('This will add Gateway as minter AND initialize it atomically.');
  console.log('Press Ctrl+C to cancel, or wait 5 seconds to continue...');
  
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  // Execute transaction
  console.log('\n📤 Executing transaction...');
  try {
    const result = await client.signAndExecuteTransactionBlock({
      transactionBlock: tx,
      signer: keypair,
      options: {
        showEffects: true,
        showEvents: true,
        showObjectChanges: true,
      }
    });
    
    console.log('\n✅ Transaction successful!');
    console.log('Digest:', result.digest);
    
    // Show created objects
    if (result.effects?.created && result.effects.created.length > 0) {
      console.log('\n📦 Created objects:');
      result.effects.created.forEach((obj: any) => {
        console.log(`- ${obj.reference.objectId}`);
        
        // Check for GatewayCapabilities
        if (result.objectChanges) {
          const change = result.objectChanges.find(
            (c: any) => c.objectId === obj.reference.objectId
          );
          if (change && 'objectType' in change && (change as any).objectType?.includes('GatewayCapabilities')) {
            console.log('  ✨ GatewayCapabilities created!');
            console.log('  💾 IMPORTANT: Save this ID for withdrawals:', obj.reference.objectId);
          }
        }
      });
    }
    
    // Show events
    if (result.events && result.events.length > 0) {
      console.log('\n📢 Events emitted:');
      result.events.forEach((event: any) => {
        console.log(`- ${event.type}`);
        if (event.parsedJson) {
          console.log('  Data:', JSON.stringify(event.parsedJson, null, 2));
        }
      });
    }
    
    // Verify Gateway is now initialized
    console.log('\n🔍 Verifying Gateway initialization...');
    const updatedGateway = await client.getObject({
      id: CONFIG.sharedObjects.gatewayState,
      options: { showContent: true }
    });
    
    const updatedContent = updatedGateway.data?.content as any;
    if (updatedContent?.fields?.is_initialized) {
      console.log('✅ Gateway is now initialized!');
      console.log('- Minting Limit:', updatedContent.fields.minting_limit);
      console.log('- Paused:', updatedContent.fields.paused);
      console.log('\n🎉 Gateway initialization complete!');
      console.log('The Gateway can now:');
      console.log('- Mint and burn tBTC');
      console.log('- Process withdrawals with payload (send_tokens)');
      console.log('- Process standard withdrawals without payload (send_tokens_standard) ✨');
    } else {
      console.error('❌ Gateway initialization verification failed');
    }
    
  } catch (error) {
    console.error('\n❌ Transaction failed:', error);
    if ((error as any).message?.includes('E_ALREADY_MINTER')) {
      console.error('Gateway is already a minter! Cannot proceed.');
    } else if ((error as any).message?.includes('E_ALREADY_INITIALIZED')) {
      console.error('Gateway is already initialized!');
    }
  }
}

// Main execution
async function main() {
  try {
    await initializeGatewayV2();
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Execute if run directly
if (require.main === module) {
  main();
}