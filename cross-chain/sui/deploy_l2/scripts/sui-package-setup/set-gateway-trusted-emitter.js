#!/usr/bin/env node

/**
 * Set trusted emitter for the Gateway
 * 
 * This allows the Gateway to accept VAAs from the L1 Wormhole Token Bridge.
 * The Gateway trusts the Token Bridge (not BTCDepositorWormhole) because the 
 * Token Bridge is the actual emitter of VAAs when transferTokensWithPayload is called.
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

async function setGatewayTrustedEmitter() {
  console.log('🔧 SETTING GATEWAY TRUSTED EMITTER\n');
  
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
    
    // For this test, we'll set the L1 Token Bridge as trusted emitter
    const tokenBridgeAddress = config.l1.contracts.tokenBridge;
    console.log('\nL1 Token Bridge:', tokenBridgeAddress);
    
    // Convert to bytes32 format (pad to 32 bytes)
    const emitterBytes = tokenBridgeAddress.toLowerCase().replace('0x', '').padStart(64, '0');
    console.log('Emitter bytes32:', emitterBytes);
    
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
    
    // Get chain ID from config based on network
    const chainId = config.network === 'mainnet' 
      ? config.wormhole.chainIds.ethereum 
      : config.wormhole.chainIds.sepolia;
    
    console.log('Setting emitter for chain ID:', chainId, `(${config.network})`);
    
    // Call add_trusted_emitter on Gateway
    tx.moveCall({
      target: `${config.l2.package}::Gateway::add_trusted_emitter`,
      arguments: [
        tx.object(adminCapId),
        tx.object(config.l2.objects.gatewayState),
        tx.pure(chainId, 'u16'),
        tx.pure(Array.from(Buffer.from(emitterBytes, 'hex')), 'vector<u8>'),
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
      console.log('\n✅ Gateway trusted emitter set successfully!');
      console.log(`The Gateway will now accept VAAs from chain ${chainId} (${config.network})`);
      console.log(`Emitter address: ${tokenBridgeAddress}`);
      
      // Check for events
      if (result.events && result.events.length > 0) {
        console.log('\n📢 Events:');
        result.events.forEach(event => {
          if (event.type.includes('EmitterRegistered')) {
            console.log('- EmitterRegistered:', event.parsedJson);
          }
        });
      }
      
      console.log('\nNote: The Gateway trusts the Token Bridge because it is the actual VAA emitter,');
      console.log('even when BTCDepositorWormhole initiates the transfer.');
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

setGatewayTrustedEmitter().catch(console.error);