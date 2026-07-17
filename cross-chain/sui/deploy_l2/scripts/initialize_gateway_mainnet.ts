#!/usr/bin/env node

/**
 * Initialize Gateway on Mainnet using a Programmable Transaction Block
 * This combines add_minter_with_cap and initialize_gateway in one atomic transaction
 */

import { TransactionBlock } from '@mysten/sui.js/transactions';
import { SuiClient } from '@mysten/sui.js/client';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui.js/keypairs/secp256k1';
import { fromB64 } from '@mysten/sui.js/utils';

// Mainnet deployment configuration
const CONFIG = {
  network: 'mainnet',
  packageId: '0x77045f1b9f811a7a8fb9ebd085b5b0c55c5cb0d1520ff55f7037f89b5da9f5f1',
  
  // Admin capabilities
  adminCaps: {
    tbtc: '0x1028ceebc370a2ee481a6ff8b38035f41189644021cdf46a57e14c2d4121c11f',
    gateway: '0x10db95bdfdf83c9562a2855864d5ccafb7b5e4204dae17866ec79a25d1c64904',
    treasuryCap: '0x5dff98d71a967b3a06112bf8dd5e5377c52fe7aa209a52a18e1bf09387f7454c',
    bitcoinDepositor: '0x4c1cd43cfe7bbe3e196ea9ad98f14f19d3e99fa5ca0c003737084e8a6ba4252a',
  },
  
  // Shared objects
  sharedObjects: {
    tokenState: '0x2ff31492339e06859132b8db199f640ca37a5dc8ab1713782c4372c678f2f85c',
    gatewayState: '0x76eb72899418719b2db5fbc12f5fb42e93bb75f67116420f5dbf971dd31fe7f7',
    receiverState: '0x164f463fdc60bbbff19c30ad9597ea7123c643d3671e9719cd982e3912176d94',
  },
  
  // Wormhole configuration
  wormhole: {
    coreState: '0xaeab97f96cf9877fee2883315d459552b2b921edc16d7ceac6eab944dd88919c',
    // The wrapped tBTC type from mainnet attestation
    wrappedTbtcType: '0xbc3a676894871284b3ccfb2eec66f428612000e2a6e6d23f592ce8833c27c973::coin::COIN',
  },
  
  // Initialization parameters
  initialization: {
    mintingLimit: '18446744073709551615', // u64::MAX (unlimited)
  }
};

async function initializeGatewayMainnet() {
  console.log('🚀 Initializing Gateway on Mainnet\n');
  
  // Configuration is now set with mainnet deployment values
  
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
  console.log('Minting Limit:', CONFIG.initialization.mintingLimit, '(unlimited)');
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
  console.log('\n⚠️  Ready to execute transaction on MAINNET.');
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
      console.log('- Mint and burn tBTC v2');
      console.log('- Process withdrawals with payload (send_tokens)');
      console.log('- Process standard withdrawals without payload (send_tokens_standard)');
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
    await initializeGatewayMainnet();
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Execute if run directly
if (require.main === module) {
  main();
}