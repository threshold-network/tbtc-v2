#!/usr/bin/env node

/**
 * Set trusted receiver for the Gateway
 * 
 * This allows the Gateway to send messages to L1 contracts
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

async function setGatewayTrustedReceiver() {
  console.log('🔧 SETTING GATEWAY TRUSTED RECEIVER\n');
  
  try {
    const client = new SuiClient({ url: config.l2.rpc });
    const keypair = loadKeypair(config.l2.privateKey);
    const address = keypair.getPublicKey().toSuiAddress();
    
    console.log('Admin address:', address);
    
    // For this test, we'll set the L1 Token Bridge as trusted receiver
    const tokenBridgeAddress = config.l1.contracts.tokenBridge;
    console.log('L1 Token Bridge:', tokenBridgeAddress);
    
    // Convert to bytes32 format (pad to 32 bytes)
    const receiverBytes = tokenBridgeAddress.toLowerCase().replace('0x', '').padStart(64, '0');
    console.log('Receiver bytes32:', receiverBytes);
    
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
    
    console.log('Setting receiver for chain ID:', chainId, `(${config.network})`);
    
    // Call add_trusted_receiver on Gateway
    tx.moveCall({
      target: `${config.l2.package}::Gateway::add_trusted_receiver`,
      arguments: [
        tx.object(adminCapId),
        tx.object(config.l2.objects.gatewayState),
        tx.pure(chainId, 'u16'),
        tx.pure(Array.from(Buffer.from(receiverBytes, 'hex')), 'vector<u8>'),
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
      console.log('\n✅ Gateway trusted receiver set successfully!');
      console.log(`The Gateway can now send messages to chain ${chainId} (${config.network})`);
      console.log(`Receiver address: ${tokenBridgeAddress}`);
      
      // Check for events
      if (result.events && result.events.length > 0) {
        console.log('\n📢 Events:');
        result.events.forEach(event => {
          if (event.type.includes('ReceiverRegistered')) {
            console.log('- ReceiverRegistered:', event.parsedJson);
          }
        });
      }
      
      console.log('\nNote: The Gateway can now send messages back to the L1 Token Bridge');
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

setGatewayTrustedReceiver().catch(console.error);