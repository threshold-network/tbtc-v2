#!/usr/bin/env node

/**
 * Check trusted emitters for both BitcoinDepositor and Gateway
 * 
 * This script displays the current trusted emitter configuration for both contracts
 */

const { SuiClient } = require('@mysten/sui.js/client');
const { config } = require('../load-config');

async function checkTrustedEmitters() {
  console.log('🔍 CHECKING TRUSTED EMITTERS\n');
  
  try {
    const client = new SuiClient({ url: config.l2.rpc });
    
    // Check BitcoinDepositor trusted emitter
    console.log('1️⃣  BitcoinDepositor Configuration:');
    console.log('=' .repeat(50));
    
    const receiverState = await client.getObject({
      id: config.l2.objects.receiverState,
      options: { showContent: true, showType: true }
    });
    
    if (!receiverState.data) {
      console.log('❌ ReceiverState not found');
    } else {
      const trustedEmitterField = receiverState.data.content?.fields?.trusted_emitter;
      if (trustedEmitterField) {
        // The trusted_emitter is likely a struct with fields
        let trustedEmitter;
        if (typeof trustedEmitterField === 'string') {
          trustedEmitter = trustedEmitterField;
        } else if (trustedEmitterField.fields?.value?.fields?.data) {
          // It's an ExternalAddress struct with nested Bytes32
          const dataArray = trustedEmitterField.fields.value.fields.data;
          // Convert array of numbers to hex string
          trustedEmitter = dataArray.map(b => b.toString(16).padStart(2, '0')).join('');
        } else {
          console.log('Trusted Emitter structure:', JSON.stringify(trustedEmitterField, null, 2));
          trustedEmitter = null;
        }
        
        if (trustedEmitter) {
          const emitterAddress = '0x' + trustedEmitter.padStart(64, '0');
          console.log('Trusted Emitter (bytes32):', emitterAddress);
          
          // Extract the actual address (remove leading zeros)
          const actualAddress = '0x' + trustedEmitter.replace(/^0+/, '');
          console.log('Actual Address:', actualAddress);
          
          // Check if it's the BTCDepositorWormhole or Token Bridge
          if (actualAddress.toLowerCase() === config.l1.contracts.btcDepositorWormhole?.toLowerCase()) {
            console.log('✅ Configured for BTCDepositorWormhole');
          } else if (actualAddress.toLowerCase() === config.l1.contracts.tokenBridge.toLowerCase()) {
            console.log('⚠️  Configured for Token Bridge (testing mode)');
          } else {
            console.log('❓ Unknown emitter address');
          }
        }
      } else {
        console.log('❌ No trusted emitter set');
      }
    }
    
    // Check Gateway trusted emitters
    console.log('\n\n2️⃣  Gateway Configuration:');
    console.log('=' .repeat(50));
    
    const gatewayState = await client.getObject({
      id: config.l2.objects.gatewayState,
      options: { showContent: true, showType: true }
    });
    
    if (!gatewayState.data) {
      console.log('❌ GatewayState not found');
    } else {
      const isInitialized = gatewayState.data.content?.fields?.is_initialized;
      console.log('Initialized:', isInitialized ? '✅ Yes' : '❌ No');
      
      if (isInitialized) {
        // Get the table ID for trusted emitters
        const tableId = gatewayState.data.content?.fields?.trusted_emitters?.fields?.id?.id;
        
        if (tableId) {
          console.log('\nTrusted Emitters by Chain:');
          
          // Get all dynamic fields (chain IDs)
          const dynamicFields = await client.getDynamicFields({
            parentId: tableId,
            limit: 50
          });
          
          if (dynamicFields.data.length === 0) {
            console.log('❌ No trusted emitters configured');
          } else {
            for (const field of dynamicFields.data) {
              const chainId = field.name.value;
              
              // Get the emitter data
              const emitterData = await client.getObject({
                id: field.objectId,
                options: { showContent: true }
              });
              
              if (emitterData.data?.content?.fields?.value) {
                let emitterBytes;
                const valueField = emitterData.data.content.fields.value;
                
                if (typeof valueField === 'string') {
                  emitterBytes = valueField;
                } else if (valueField.fields?.value?.fields?.data) {
                  // It's an ExternalAddress struct with nested Bytes32
                  const dataArray = valueField.fields.value.fields.data;
                  emitterBytes = dataArray.map(b => b.toString(16).padStart(2, '0')).join('');
                } else if (valueField.fields?.data) {
                  // It's a Bytes32 struct with data array
                  const dataArray = valueField.fields.data;
                  emitterBytes = dataArray.map(b => b.toString(16).padStart(2, '0')).join('');
                } else {
                  console.log('  Unknown emitter structure:', JSON.stringify(valueField, null, 2));
                  continue;
                }
                
                const emitterAddress = '0x' + emitterBytes.padStart(64, '0');
                const actualAddress = '0x' + emitterBytes.replace(/^0+/, '');
                
                console.log(`\nChain ${chainId}:`);
                console.log('  Emitter (bytes32):', emitterAddress);
                console.log('  Actual Address:', actualAddress);
                
                // Identify known chains and verify configuration
                const ethChainId = config.wormhole.chainIds.ethereum?.toString();
                const sepoliaChainId = config.wormhole.chainIds.sepolia?.toString();
                
                if (chainId === ethChainId || chainId == ethChainId) {
                  console.log('  Chain: Ethereum Mainnet');
                  if (actualAddress.toLowerCase() === config.l1.contracts.tokenBridge.toLowerCase()) {
                    console.log('  ✅ Correctly set to Token Bridge');
                  }
                } else if (chainId === sepoliaChainId || chainId == sepoliaChainId) {
                  console.log('  Chain: Sepolia Testnet');
                  if (actualAddress.toLowerCase() === config.l1.contracts.tokenBridge.toLowerCase()) {
                    console.log('  ✅ Correctly set to Token Bridge');
                  }
                }
              }
            }
          }
        } else {
          console.log('❌ Could not access trusted emitters table');
        }
      }
    }
    
    // Summary
    console.log('\n\n📊 Summary:');
    console.log('=' .repeat(50));
    console.log(`Expected Configuration for ${config.network}:`);
    console.log(`- BitcoinDepositor: ${config.l1.contracts.btcDepositorWormhole} (BTCDepositorWormhole)`);
    console.log(`- Gateway (Chain ${config.network === 'mainnet' ? config.wormhole.chainIds.ethereum : config.wormhole.chainIds.sepolia}): ${config.l1.contracts.tokenBridge} (Token Bridge)`);
    console.log('\nThis dual validation ensures:');
    console.log('1. Only authorized deposit contracts can initiate transfers');
    console.log('2. Only valid Token Bridge VAAs are accepted by the Gateway');
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    if (error.stack) {
      console.error('Stack:', error.stack);
    }
  }
}

checkTrustedEmitters().catch(console.error);