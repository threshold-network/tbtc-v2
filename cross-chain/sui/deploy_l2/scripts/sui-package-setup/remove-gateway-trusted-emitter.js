#!/usr/bin/env node

/**
 * Remove trusted emitter from the Gateway
 * 
 * This removes a previously set trusted emitter for a specific chain.
 * Useful when you need to update an emitter (remove then add new one)
 * or disable a chain entirely.
 */

const { SuiClient } = require('@mysten/sui.js/client');
const { TransactionBlock } = require('@mysten/sui.js/transactions');
const { Ed25519Keypair } = require('@mysten/sui.js/keypairs/ed25519');
const { Secp256k1Keypair } = require('@mysten/sui.js/keypairs/secp256k1');
const { config, validateConfig } = require('../load-config');

// Load the keypair
function loadKeypair(privateKey) {
  const decoded = Buffer.from(privateKey, 'base64');
  
  if (decoded.length === 32) {
    return Ed25519Keypair.fromSecretKey(decoded);
  } else if (decoded.length === 33) {
    const flag = decoded[0];
    const keyData = decoded.slice(1);
    if (flag === 0x00) {
      return Ed25519Keypair.fromSecretKey(keyData);
    } else if (flag === 0x01) {
      return Secp256k1Keypair.fromSecretKey(keyData);
    }
  }
  
  throw new Error('Unknown key format');
}

async function removeGatewayTrustedEmitter() {
  console.log('🗑️  REMOVING GATEWAY TRUSTED EMITTER\n');
  
  try {
    const client = new SuiClient({ url: config.l2.rpc });
    const keypair = loadKeypair(config.l2.privateKey);
    const address = keypair.getPublicKey().toSuiAddress();
    
    console.log('Admin address:', address);
    
    // Verify GatewayState exists and is initialized
    console.log('\n🔍 Verifying GatewayState...');
    const gatewayState = await client.getObject({
      id: config.l2.objects.gatewayState,
      options: { showContent: true, showType: true }
    });
    
    if (!gatewayState.data) {
      throw new Error('GatewayState not found');
    }
    
    if (!gatewayState.data.content?.fields?.is_initialized) {
      throw new Error('Gateway is not initialized');
    }
    
    console.log('✅ GatewayState verified and initialized');
    
    // Check current trusted emitters properly using dynamic fields
    const tableId = gatewayState.data.content.fields.trusted_emitters.fields.id.id;
    const tableSize = gatewayState.data.content.fields.trusted_emitters.fields.size;
    
    console.log('\n📋 Trusted emitters table:');
    console.log('   Table ID:', tableId);
    console.log('   Table size:', tableSize);
    
    if (tableSize === '0') {
      console.log('   No trusted emitters found');
      return;
    }
    
    // Query dynamic fields to get table contents
    console.log('\n🔍 Checking table contents...');
    const dynamicFields = await client.getDynamicFields({
      parentId: tableId
    });
    
    let hasSepoliaEmitter = false;
    
    console.log(`Found ${dynamicFields.data.length} chain(s) in the table`);
    
    for (const field of dynamicFields.data) {
      console.log(`\n   Checking chain ID: ${field.name.value} (type: ${typeof field.name.value})`);
      console.log(`   Looking for: ${config.wormhole.chainIds.sepolia} (type: ${typeof config.wormhole.chainIds.sepolia})`);
      
      // Try both string and number comparison
      if (field.name.value == config.wormhole.chainIds.sepolia || 
          field.name.value === config.wormhole.chainIds.sepolia.toString() ||
          parseInt(field.name.value) === config.wormhole.chainIds.sepolia) {
        hasSepoliaEmitter = true;
        
        // Get the actual emitter address
        const fieldObject = await client.getDynamicFieldObject({
          parentId: tableId,
          name: {
            type: field.name.type,
            value: field.name.value
          }
        });
        
        if (fieldObject.data?.content?.fields?.value) {
          // Extract emitter bytes from nested structure
          const emitterData = fieldObject.data.content.fields.value.fields?.value?.fields?.data || 
                             fieldObject.data.content.fields.value.fields?.data || 
                             [];
          
          if (Array.isArray(emitterData)) {
            const emitterHex = emitterData.map(b => b.toString(16).padStart(2, '0')).join('');
            console.log(`   Chain ${config.wormhole.chainIds.sepolia}: 0x${emitterHex}`);
            
            // Check if it's the Token Bridge
            const tokenBridgeHex = config.l1.contracts.tokenBridge.toLowerCase().replace('0x', '').padStart(64, '0');
            if (emitterHex === tokenBridgeHex) {
              console.log('   ✅ Current emitter is the L1 Token Bridge');
            }
          }
        }
      }
    }
    
    // Find AdminCap for Gateway
    const adminCaps = await client.getOwnedObjects({
      owner: address,
      filter: {
        StructType: `${config.l2.package}::Gateway::AdminCap`
      }
    });
    
    if (!adminCaps.data || adminCaps.data.length === 0) {
      console.log('❌ No Gateway AdminCap found!');
      console.log('Make sure you own the AdminCap for Gateway');
      return;
    }
    
    const adminCapId = adminCaps.data[0].data.objectId;
    console.log('\nFound Gateway AdminCap:', adminCapId);
    
    // Build transaction
    const tx = new TransactionBlock();
    
    // Use Sepolia chain ID for testnet
    const sepoliaChainId = config.wormhole.chainIds.sepolia;
    console.log('\n🎯 Removing emitter for chain ID:', sepoliaChainId);
    
    // Check if emitter exists for this chain
    if (!hasSepoliaEmitter) {
      console.log(`\n⚠️  No emitter registered for chain ${sepoliaChainId}`);
      console.log('Nothing to remove');
      return;
    }
    
    // Call remove_trusted_emitter on Gateway
    tx.moveCall({
      target: `${config.l2.package}::Gateway::remove_trusted_emitter`,
      arguments: [
        tx.object(adminCapId),
        tx.object(config.l2.objects.gatewayState),
        tx.pure(sepoliaChainId, 'u16'),
      ],
    });
    
    console.log('\n📤 Sending transaction...');
    const result = await client.signAndExecuteTransactionBlock({
      signer: keypair,
      transactionBlock: tx,
      options: {
        showEffects: true,
        showEvents: true,
      },
    });
    
    console.log('TX Digest:', result.digest);
    console.log('Status:', result.effects?.status?.status);
    
    if (result.effects?.status?.status === 'success') {
      console.log('\n✅ Gateway trusted emitter removed successfully!');
      console.log(`The Gateway will no longer accept VAAs from chain ${sepoliaChainId} (Sepolia)`);
      
      // Check for events
      if (result.events && result.events.length > 0) {
        console.log('\n📢 Events:');
        result.events.forEach(event => {
          if (event.type.includes('EmitterRemoved')) {
            console.log('- EmitterRemoved:', event.parsedJson);
          }
        });
      }
      
      console.log('\nNote: You can now add a new emitter for this chain if needed');
    } else {
      console.log('\n❌ Transaction failed!');
      if (result.effects?.status?.error) {
        console.log('Error:', result.effects.status.error);
      }
    }
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    if (error.stack) {
      console.error('Stack:', error.stack);
    }
  }
}

removeGatewayTrustedEmitter().catch(console.error);