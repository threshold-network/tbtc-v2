# StarkNet L1 Bitcoin Depositor Artifacts

## Overview

The StarkNet L1 Bitcoin Depositor artifact files in this directory are **placeholders** that need to be updated once the actual contracts are deployed on Ethereum mainnet and Sepolia testnet.

## Current Status

The following placeholder files exist:
- `mainnet/StarkNetL1BitcoinDepositor.json`
- `sepolia/StarkNetL1BitcoinDepositor.json`

These files contain:
- **Zero address**: `0x0000000000000000000000000000000000000000`
- **Empty ABI**: `[]`
- **Zero block number**: `0`
- **Comment field**: Indicating these are placeholders

## Updating Process

Once the StarkNet L1 Bitcoin Depositor contracts are deployed:

1. **Update the address** field with the actual deployed contract address
2. **Update the ABI** field with the complete contract ABI from the deployment
3. **Update the receipt.blockNumber** with the actual deployment block number
4. **Remove or update the _comment** field to reflect the actual deployment

## Expected ABI Structure

The production ABI should include at least these functions:
- `initializeDeposit`: For initializing Bitcoin deposits destined for StarkNet
- `deposits`: For querying deposit states

## Integration

These artifacts are used by the `EthereumL1BitcoinDepositor` class when StarkNet is specified as the L2 destination chain. The SDK will automatically load the appropriate artifact based on the Ethereum network (mainnet or sepolia).