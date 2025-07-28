# Deployment Guide

## Fixed Issues for Future Deployments

### 1. Compiler Version Fix
The hardhat config uses Solidity 0.8.17 compiler version, which matches the contract's pragma statement.

### 2. Verification with Indexing Delay

For better verification results, use the verification script with delay:

```bash
# After deployment, run verification with delay
CONTRACT_ADDRESS=0x26e3F3d62814433fD1439910Dee4B5d8255eA17F npx hardhat run scripts/verify-with-delay.ts --network sepolia
```

### 3. Manual Verification Steps

If automatic verification fails:

1. Wait 2-3 minutes after deployment
2. Go to Etherscan Sepolia: https://sepolia.etherscan.io/address/[CONTRACT_ADDRESS]
3. Click "Contract" tab
4. Click "Verify and Publish"
5. Select "Via Standard JSON Input"
6. Use the following settings:
   - Compiler Version: 0.8.17
   - Optimization: Enabled (1000 runs)
   - Constructor Arguments: (if any)

### 4. Deployment Command

```bash
# Deploy with reset to force new deployment
npx hardhat deploy --network sepolia --tags LockReleaseTokenPoolUpgradeable --reset
```

### 5. Environment Variables

Ensure your `.env` file contains:
```
L1_ACCOUNTS_PRIVATE_KEYS=your_private_key
L1_CHAIN_API_URL=https://sepolia.infura.io/v3/your_api_key
ETHERSCAN_API_KEY=your_etherscan_api_key
```

## Recent Deployments

### LockReleaseTokenPoolUpgradeable (L1 - Sepolia)
- **Contract**: LockReleaseTokenPoolUpgradeable
- **Proxy Address**: 0x2252087dAaCA6B0Ec03ac25039030810435752E7
- **Implementation Address**: 0xf7a5bFd57aB5FFf959655D70541378BC691C96CE ✅ **VERIFIED**
- **Network**: Sepolia
- **Transaction**: 0x0ccc09a28534bf91e8683ea40473e0e60be2f237eee760941da90e61f003fe19
- **Status**: Implementation verified, proxy linked successfully

### BurnFromMintTokenPoolUpgradeable (L2 - BOB Sepolia)
- **Contract**: BurnFromMintTokenPoolUpgradeable
- **Proxy Address**: 0x78E48eBCACabdee321e30D62a3144b8552Ce923F ✅ **FULLY VERIFIED**
- **Implementation Address**: 0xf02Fb224aB2BA95D7C356cD81e933b6d3E616aEb ✅ **VERIFIED**
- **Network**: BOB Sepolia
- **Transaction**: 0xa57604dfc1371dc2c6d423938ea1522e26547d974a3043562bd1741e5dab4661
- **Status**: ✅ **FULLY VERIFIED** (Implementation, Proxy, and Proxy Admin)

## Verification Results

### LockReleaseTokenPool (Sepolia)
✅ **Implementation Contract**: Successfully verified on Etherscan  
✅ **Proxy Linking**: Successfully linked to implementation  
⚠️ **Proxy Contract**: Minor API issues (functional, can be manually verified if needed)  
⚠️ **Proxy Admin**: Minor API issues (functional, can be manually verified if needed)

### BurnFromMintTokenPool (BOB Sepolia)
✅ **Implementation Contract**: Successfully verified on Bobscan  
✅ **Proxy Contract**: Successfully verified on Bobscan  
✅ **Proxy Admin**: Successfully verified on Bobscan  
✅ **Proxy Linking**: Successfully linked to implementation  
🎉 **FULLY VERIFIED** - All components verified successfully 