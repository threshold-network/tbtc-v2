# tBTC v2 StarkNet Cross-Chain Integration

StarkNet cross-chain integration for tBTC v2, enabling Bitcoin deposits directly to StarkNet Layer 2.

## Prerequisites

- Node.js >= 14.0.0
- Yarn package manager

## Installation

```bash
yarn install
```

## Environment Configuration

Required environment variables:

```bash
L1_CHAIN_API_URL=https://1rpc.io/sepolia
L1_ACCOUNTS_PRIVATE_KEYS=your_private_key_here  # for sepolia (comma-separated)
CONTRACT_OWNER_ACCOUNT_PRIVATE_KEY=your_key     # for mainnet
ETHERSCAN_API_KEY=your_etherscan_api_key
```

## Available Commands

### Development

```bash
yarn clean      # Clean build artifacts and cache
yarn build      # Compile contracts
yarn test       # Run tests with external deployments
yarn test:integration  # Run integration tests
```

### Deployment

```bash
yarn deploy:test     # Deploy with test stubs
yarn deploy:sepolia  # Deploy to Sepolia testnet
yarn deploy:mainnet  # Deploy to mainnet
```

### Verification

```bash
yarn verify --network <network>  # Verify contracts on Etherscan
```

### Artifacts

```bash
yarn export-artifacts:sepolia   # Export Sepolia deployment artifacts
yarn export-artifacts:mainnet   # Export mainnet deployment artifacts
```

## Network Configuration

### Sepolia Testnet
- StarkGate Bridge: `0x95fa1deDF00d6B3c6EF7DfDB36dD954Eb9Dbe829`
- StarkNet tBTC Token: `0x04e3bc49f130f9d0379082c24efd397a0eddfccdc6023a2f02a74d8527140276`

### Mainnet
- StarkGate Bridge: `0xae0Ee0A63A2cE6BaeEFFE56e7714FB4EFE48D419`
- StarkNet tBTC Token: **Update required before deployment**

## Architecture

The `StarkNetBitcoinDepositor` contract uses OpenZeppelin's transparent proxy pattern and integrates with:

- tBTC Bridge: Core Bitcoin deposit processing
- tBTC Vault: Token minting and custody  
- StarkGate Bridge: L1→L2 messaging infrastructure
- StarkNet tBTC Token: L2 token representation

## Deployment Notes

1. Test on Sepolia before mainnet deployment
2. Update mainnet StarkNet tBTC token address in deployment script
3. Contracts are automatically verified on Etherscan when `ETHERSCAN_API_KEY` is configured

## License

GPL-3.0-only
