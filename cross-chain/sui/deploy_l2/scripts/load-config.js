#!/usr/bin/env node

/**
 * Configuration Loader
 * 
 * Loads configuration from:
 * - .env file for private/sensitive data (keys, RPC URLs)
 * - JSON file for public contract addresses and constants
 * 
 * Supports both testnet and mainnet configurations
 */

const fs = require('fs');
const path = require('path');
// Load from TD-3 root .env file
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// Determine network from environment
const NETWORK = process.env.NETWORK || 'testnet';
const isMainnet = NETWORK === 'mainnet';

console.log(`🌐 Loading configuration for: ${NETWORK}`);

// Load appropriate public configuration based on network
const publicConfigFile = isMainnet ? 'public-config-mainnet.json' : 'public-config.json';
const publicConfigPath = path.join(__dirname, publicConfigFile);

if (!fs.existsSync(publicConfigPath)) {
  console.error(`❌ Configuration file not found: ${publicConfigPath}`);
  process.exit(1);
}

const publicConfig = JSON.parse(
  fs.readFileSync(publicConfigPath, 'utf8')
);

// Build complete configuration with network-specific values
const config = {
  network: NETWORK,
  l1: {
    rpc: process.env[`ETHEREUM_RPC_URL_${NETWORK.toUpperCase()}`],
    privateKey: process.env[`ETHEREUM_PRIVATE_KEY_${NETWORK.toUpperCase()}`],
    contracts: publicConfig.l1.contracts,
    chainName: isMainnet ? 'Ethereum Mainnet' : 'Sepolia Testnet'
  },
  l2: {
    rpc: process.env[`SUI_RPC_URL_${NETWORK.toUpperCase()}`] || publicConfig.l2.rpc,
    privateKey: process.env[`SUI_PRIVATE_KEY_${NETWORK.toUpperCase()}`],
    package: publicConfig.l2.package,
    objects: publicConfig.l2.objects,
    wormhole: publicConfig.l2.wormhole,
    chainName: isMainnet ? 'SUI Mainnet' : 'SUI Testnet'
  },
  bridge: {
    amount: process.env[`BRIDGE_AMOUNT_${NETWORK.toUpperCase()}`] || publicConfig.bridge.defaultAmount,
    recipient: process.env[`BRIDGE_RECIPIENT_${NETWORK.toUpperCase()}`]
  },
  withdrawal: {
    ...(publicConfig.withdrawal || { defaultAmount: '0.0005' }),
    privateKey: process.env[`SUI_WITHDRAWAL_PRIVATE_KEY_${NETWORK.toUpperCase()}`] || process.env[`SUI_PRIVATE_KEY_${NETWORK.toUpperCase()}`]
  },
  wormhole: {
    chainIds: publicConfig.wormhole.chainIds,
    api: process.env[`WORMHOLESCAN_API_${NETWORK.toUpperCase()}`] || publicConfig.wormhole.api
  }
};

// Validate required environment variables
function validateConfig() {
  const networkUpper = NETWORK.toUpperCase();
  const required = [
    `ETHEREUM_RPC_URL_${networkUpper}`,
    `ETHEREUM_PRIVATE_KEY_${networkUpper}`,
    `SUI_PRIVATE_KEY_${networkUpper}`,
    `BRIDGE_RECIPIENT_${networkUpper}`
  ];
  
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:');
    missing.forEach(key => console.error(`   - ${key}`));
    console.error('\nPlease check your .env file');
    process.exit(1);
  }
  
  // Validate bridge amount
  const amount = parseFloat(config.bridge.amount);
  if (isNaN(amount) || amount <= 0) {
    console.error('❌ Invalid bridge amount:', config.bridge.amount);
    process.exit(1);
  }
  
  // Validate SUI address format
  if (!config.bridge.recipient.startsWith('0x') || config.bridge.recipient.length !== 66) {
    console.error('❌ Invalid SUI recipient address format:', config.bridge.recipient);
    console.error('   SUI addresses should be 66 characters (0x + 64 hex chars)');
    process.exit(1);
  }
}

// Export for use in other scripts
module.exports = {
  config,
  validateConfig,
  isMainnet,
  NETWORK
};

// If run directly, display configuration
if (require.main === module) {
  console.log(`\n📋 Configuration Loaded for ${NETWORK.toUpperCase()}:\n`);
  
  // Display non-sensitive config
  console.log(`L1 (${config.l1.chainName}):`);
  console.log('- RPC:', config.l1.rpc ? '✅ Configured' : '❌ Missing');
  console.log('- Private Key:', config.l1.privateKey ? '✅ Configured' : '❌ Missing');
  console.log('- tBTC:', config.l1.contracts.tbtc);
  console.log('- Token Bridge:', config.l1.contracts.tokenBridge);
  console.log('- Wormhole:', config.l1.contracts.wormhole);
  console.log('- BTCDepositorWormhole:', config.l1.contracts.btcDepositorWormhole);
  
  console.log(`\nL2 (${config.l2.chainName}):`);
  console.log('- RPC:', config.l2.rpc);
  console.log('- Private Key:', config.l2.privateKey ? '✅ Configured' : '❌ Missing');
  console.log('- Package:', config.l2.package);
  console.log('- Gateway:', config.l2.objects.gatewayState);
  console.log('- EmitterCapId:', config.l2.objects.emitterCapId);
  
  console.log('\nBridge:');
  console.log('- Amount:', config.bridge.amount, 'tBTC');
  console.log('- Recipient:', config.bridge.recipient);
  
  console.log('\nWormhole:');
  console.log(`- ${isMainnet ? 'Ethereum' : 'Sepolia'} Chain ID:`, isMainnet ? config.wormhole.chainIds.ethereum : config.wormhole.chainIds.sepolia);
  console.log('- SUI Chain ID:', config.wormhole.chainIds.sui);
  console.log('- API:', config.wormhole.api);
  
  // Validate
  try {
    validateConfig();
    console.log('\n✅ Configuration is valid!');
  } catch (error) {
    // Error already displayed by validateConfig
  }
}