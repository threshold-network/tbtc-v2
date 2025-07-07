#!/usr/bin/env node

/**
 * Set trusted emitter for the BitcoinDepositor
 * 
 * This sets the L1 BTCDepositorWormhole as the trusted emitter for the L2 BitcoinDepositor.
 * This is different from the Gateway, which trusts the Token Bridge directly.
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

async function setTrustedEmitter() {
  console.log('🔧 SETTING TRUSTED EMITTER\n');
  
  try {
    const client = new SuiClient({ url: config.l2.rpc });
    const keypair = loadKeypair(config.l2.privateKey);
    const address = keypair.getPublicKey().toSuiAddress();
    
    console.log('Admin address:', address);
    
    // Verify ReceiverState exists
    console.log('\n🔍 Verifying ReceiverState...');
    const receiverState = await client.getObject({
      id: config.l2.objects.receiverState,
      options: { showType: true }
    });
    
    if (!receiverState.data) {
      throw new Error('ReceiverState not found');
    }
    
    console.log('✅ ReceiverState verified');
    
    // Set the L1 Token Bridge as trusted emitter
    const tokenBridgeAddress = config.l1.contracts.tokenBridge;
    console.log('\nL1 Token Bridge:', tokenBridgeAddress);
    
    // Convert to bytes32 format (pad to 32 bytes)
    const emitterBytes = tokenBridgeAddress.toLowerCase().replace('0x', '').padStart(64, '0');
    console.log('Emitter bytes32:', '0x' + emitterBytes);
    
    // Find AdminCap for BitcoinDepositor
    const adminCaps = await client.getOwnedObjects({
      owner: address,
      filter: {
        StructType: `${config.l2.package}::BitcoinDepositor::AdminCap`
      }
    });
    
    if (!adminCaps.data || adminCaps.data.length === 0) {
      console.log('❌ No BitcoinDepositor AdminCap found!');
      console.log('Make sure you own the AdminCap for BitcoinDepositor');
      return;
    }
    
    const adminCapId = adminCaps.data[0].data.objectId;
    console.log('\nFound AdminCap:', adminCapId);
    
    // Build transaction
    const tx = new TransactionBlock();
    
    // Get chain ID from config based on network
    const chainId = config.network === 'mainnet' 
      ? config.wormhole.chainIds.ethereum 
      : config.wormhole.chainIds.sepolia;
    
    console.log('\nUsing chain ID:', chainId, `(${config.network})`);
    
    // Call set_trusted_emitter
    tx.moveCall({
      target: `${config.l2.package}::BitcoinDepositor::set_trusted_emitter`,
      arguments: [
        tx.object(adminCapId),
        tx.object(config.l2.objects.receiverState),
        tx.pure(Array.from(Buffer.from(emitterBytes, 'hex')), 'vector<u8>'),
      ],
    });
    
    console.log('\n📤 Sending transaction...');
    const result = await client.signAndExecuteTransactionBlock({
      signer: keypair,
      transactionBlock: tx,
      options: {
        showEffects: true,
      },
    });
    
    console.log('TX Digest:', result.digest);
    console.log('Status:', result.effects?.status?.status);
    
    if (result.effects?.status?.status === 'success') {
      console.log('\n✅ Trusted emitter set successfully!');
      console.log('The L2 BitcoinDepositor will now accept VAAs from the L1 Token Bridge');
      console.log('\nWarning: This deviates from the EVM design where BitcoinDepositor');
      console.log('only trusts BTCDepositorWormhole. Direct transfers should normally');
      console.log('go through Gateway directly, not through BitcoinDepositor.');
    } else {
      console.log('\n❌ Transaction failed!');
      if (result.effects?.status?.error) {
        console.log('Error:', result.effects.status.error);
      }
    }
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
  }
}

setTrustedEmitter().catch(console.error);