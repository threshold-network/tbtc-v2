# tBTC Sei - Minimal Guide

This directory holds the Sei integration utilities and scripts. Below are minimal, copy-paste steps to run relevant deployments with sane defaults.

## Prerequisites

- Encrypted deployer key at `solidity/.encrypted-key` (matches `chains.Sepolia.owner` in `cross-chain/sei/deployment-testnet.json`).
- Node.js version supported by Hardhat.

## Deploy L1BTCDepositorNtt on Sepolia

Uses the battle-tested proxy pattern and EIP‑1559 fee overrides to avoid replacement/underpriced errors.

```bash
export CHAIN_API_URL="https://ethereum-sepolia.publicnode.com" \
  MAX_PRIORITY_FEE_PER_GAS=3000000000 \
  MAX_FEE_PER_GAS=70000000000 \
  && npx hardhat deploy --network sepolia --tags L1BTCDepositorNtt | cat
```

Notes:

- You will be prompted for the master password to decrypt `solidity/.encrypted-key`.
- The script validates the decrypted address equals the expected owner in `cross-chain/sei/deployment-testnet.json`.
- Fees are in wei. Adjust as needed if the network is congested.

## Key Paths

- Owner and addresses: `cross-chain/sei/deployment-testnet.json`
- Secure key manager: `cross-chain/sei/scripts/secure-key-manager.ts`
- Sepolia deploy script: `solidity/deploy/95_deploy_l1_btc_depositor_ntt.ts`

## Troubleshooting

- If you see “replacement transaction underpriced”, increase `MAX_FEE_PER_GAS` and `MAX_PRIORITY_FEE_PER_GAS`.
- Ensure the encrypted key corresponds to the `owner` address in `deployment-testnet.json`.
- For Node warnings, switch to a Hardhat-supported Node.js version.
