# SUI Cross-Chain Integration

This module provides SUI blockchain support for the tBTC v2 SDK, enabling cross-chain deposits from Bitcoin to SUI through the Wormhole protocol.

## Overview

The SUI integration follows the L2-first deposit flow pattern where users initiate deposits on SUI that get relayed to Ethereum for Bitcoin validation and tBTC minting.

## Architecture

### Key Components

1. **SuiBitcoinDepositor** - Handles deposit initialization on SUI
2. **SuiTBTCToken** - Manages tBTC token balances on SUI
3. **SuiAddress** - Validates and handles 32-byte SUI addresses
4. **SuiExtraDataEncoder** - Encodes/decodes SUI addresses for cross-chain communication

### Deposit Flow (13 Steps)

The SDK is responsible for **Steps 0-1** only. The relayer handles steps 2-13.

#### Step 0: Deposit Address Generation (SDK)

```typescript
const deposit = await tbtc.deposits.initiateCrossChainDeposit(
  bitcoinRecoveryAddress,
  "Sui"
)
// Generates P2WSH address with embedded L1BitcoinDepositor address
```

#### Step 1: Initialize Deposit on SUI (SDK)

```typescript
await deposit.initializeReveal()
// Calls initialize_deposit on SUI L2BitcoinDepositor
// Emits DepositInitialized event for relayer
```

#### Steps 2-13: Relayer Processing (NOT SDK)

2. Relayer listens to `DepositInitialized` event from SUI
3. Relayer calls `initializeDeposit` on L1BitcoinDepositor (Ethereum)
4. L1BitcoinDepositor reveals deposit to tBTC Bridge
5. Bridge mints tBTC and sends to L1BitcoinDepositor
6. Relayer polls for tBTC arrival and calls `finalizeDeposit()`
7. L1BitcoinDepositor sends tBTC via Wormhole `transferTokensWithPayload()`
8. Wormhole guardians sign the VAA message
9. Relayer sends signed VAA to L2BitcoinDepositor via `receiveWormholeMessages()`
10. L2BitcoinDepositor calls `receiveTbtc()` on gateway
11. Gateway calls `completeTransferWithPayload()` to redeem Wormhole tBTC
12. Gateway mints L2 tBTC, locking Wormhole tBTC
13. User receives tBTC in their SUI wallet

## Event Structure

### DepositInitialized Event (SUI)

The Move contract emits this event when `initialize_deposit` is called:

```move
struct DepositInitialized has copy, drop {
    deposit_key: vector<u8>,      // Unique deposit identifier
    funding_tx: vector<u8>,       // Bitcoin transaction data
    deposit_reveal: vector<u8>,   // Deposit parameters
    deposit_owner: address,       // SUI recipient address
    sender: address              // Transaction sender
}
```

### Event Data Format

1. **deposit_key**: keccak256(reversedTxHash | outputIndex)
2. **funding_tx**: Concatenated Bitcoin transaction components
   - version (4 bytes)
   - inputs (variable length)
   - outputs (variable length)
   - locktime (4 bytes)
3. **deposit_reveal**: Concatenated deposit parameters
   - fundingOutputIndex (4 bytes BE)
   - blindingFactor (8 bytes)
   - walletPublicKeyHash (20 bytes)
   - refundPublicKeyHash (20 bytes)
   - refundLocktime (4 bytes LE)
4. **deposit_owner**: 32-byte SUI address
5. **sender**: Transaction sender address

## Move Contract Interface

### Package Structure

```
Package ID: 0x1db1fcdaada7c286d77f3347e593e06d8f33b8255e0861033a0a9f321f4eade7
Module: BitcoinDepositor
```

### Entry Function

```move
public entry fun initialize_deposit(
    funding_tx: vector<u8>,
    deposit_reveal: vector<u8>,
    deposit_owner: vector<u8>,
    ctx: &mut TxContext,
)
```

### Shared Objects (Testnet)

- ReceiverState: `0x10f421d7960be14c07057fd821332ee8a9d717873c62e7fa370fa99913e8e924`
- GatewayState: `0x19ab17536712e3e2efa9a1c01acbf5c09ae53e969cb9046dc382f5f49b603d52`
- TokenState: `0x0d59e4970772269ee917280da592089c7de389ed67164ce4c07ed508917fdf08`

## Usage Examples

### Initialize SUI Integration

```typescript
import { loadSuiCrossChainInterfaces } from "@keep-network/tbtc-v2.ts/lib/sui"
import { SuiClient } from "@mysten/sui/client"

// Using wallet adapter
const suiInterfaces = await loadSuiCrossChainInterfaces(
  walletAdapter,
  Chains.Sui.Testnet
)

// Using keypair
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
const keypair = new Ed25519Keypair()
const suiInterfaces = await loadSuiCrossChainInterfaces(
  keypair,
  Chains.Sui.Testnet
)
```

### Create Cross-Chain Deposit

```typescript
// Initialize TBTC SDK with SUI
const tbtc = await TBTC.initializeCrossChain("Sui", ethereumProvider, suiWallet)

// Create deposit
const deposit = await tbtc.deposits.initiateCrossChainDeposit(
  bitcoinRecoveryAddress,
  "Sui"
)

// Get deposit address and fund with Bitcoin
console.log("Send BTC to:", await deposit.getBitcoinAddress())

// After Bitcoin confirmation, initialize on SUI
await deposit.initializeReveal()
```

## Key Differences from EVM Chains

1. **No Vault Support** - Deposits go directly to user addresses
2. **32-byte Addresses** - SUI uses 32-byte addresses vs 20-byte EVM
3. **Move Contracts** - Uses Move language instead of Solidity
4. **Object Model** - SUI's object-based model vs account-based
5. **Wormhole Chain ID** - SUI uses chain ID 21

## Deployment Information

### L1 Contracts (Ethereum Sepolia)

- L1BitcoinDepositor: `0xb306e0683f890BAFa669c158c7Ffa4b754b70C95`
- Implementation: `0x75757a633237D7bb0c51b51952F171BE20C60056`
- ProxyAdmin: `0x8E6C6f8e1551ba79D9ECe97fd584BbE7572cE79f`

### L2 Contracts (SUI Testnet)

- Package: `0x3d78316ce8ee3fe48d7ff85cdc2d0df9d459f43d802d96f58f7b59984c2dd3ae`
- tBTC Type: `0x3d78316ce8ee3fe48d7ff85cdc2d0df9d459f43d802d96f58f7b59984c2dd3ae::TBTC::TBTC`

### Wormhole Configuration

- SUI Chain ID: 21
- Token Bridge: Handles tBTC transfers with 8 decimal precision
- Gateway: Manages token redemption on SUI

## Technical Notes

### Decimal Precision

- tBTC on Ethereum: 18 decimals
- tBTC on SUI: 8 decimals
- Wormhole normalizes to 8 decimals for cross-chain transfers

### Transaction Building

```typescript
const tx = new Transaction()
tx.moveCall({
  target: `${packageId}::BitcoinDepositor::initialize_deposit`,
  arguments: [
    tx.pure.vector("u8", fundingTxBytes),
    tx.pure.vector("u8", depositRevealBytes),
    tx.pure.vector("u8", depositOwnerBytes),
  ],
})
```

### Error Handling

The SDK uses `SuiError` for all SUI-specific errors:

```typescript
try {
  await deposit.initializeReveal()
} catch (error) {
  if (error instanceof SuiError) {
    console.error("SUI error:", error.message, error.cause)
  }
}
```

## Requirements

- TypeScript 5.0 or higher
- @mysten/sui package (v1.34.0 or compatible)
- SUI wallet or keypair for signing transactions
- Ethereum provider for L1 operations

## Future Enhancements

1. **Mainnet Support** - Pending mainnet deployment
2. **Vault Integration** - If SUI adds vault support
3. **Direct Redemptions** - Burn tBTC on SUI to redeem Bitcoin
4. **Event Monitoring** - SDK event subscription support
