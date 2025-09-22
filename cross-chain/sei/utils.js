// Utility functions for the Sei cross-chain package

const SEI_NETWORKS = {
  atlantic2: {
    rpcUrl: "https://evm-rpc-testnet.sei-apis.com",
    chainId: 1328,
    name: "Sei Atlantic 2",
  },
  mainnet: {
    rpcUrl: "https://evm-rpc.sei-apis.com",
    chainId: 1329,
    name: "Sei Mainnet",
  },
};

function getNetworkConfig(networkName) {
  const config = SEI_NETWORKS[networkName];
  if (!config) {
    throw new Error(`Unknown network: ${networkName}`);
  }
  return config;
}

function isValidAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

module.exports = {
  getNetworkConfig,
  isValidAddress,
  SEI_NETWORKS,
};
