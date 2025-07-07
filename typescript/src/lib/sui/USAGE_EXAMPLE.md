# SUI Integration Usage Example

This example demonstrates the correct usage of the SUI integration with the official Mysten Labs SDK.

## Installation

```bash
npm install @mysten/sui@1.34.0
```

## Basic Usage

```typescript
import { SuiClient } from "@mysten/sui/client"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { loadSuiCrossChainInterfaces } from "@keep-network/tbtc-v2.ts"
import { Chains } from "@keep-network/tbtc-v2.ts"

// Initialize with a keypair
async function initializeWithKeypair() {
  // Create or import a keypair
  const keypair = new Ed25519Keypair()

  // Load SUI interfaces
  const suiInterfaces = await loadSuiCrossChainInterfaces(
    keypair,
    Chains.Sui.Testnet
  )

  return suiInterfaces
}

// Initialize with a wallet adapter
async function initializeWithWallet(walletAdapter: any) {
  // Wallet adapter should have signAndExecuteTransaction method
  const suiInterfaces = await loadSuiCrossChainInterfaces(
    walletAdapter,
    Chains.Sui.Testnet
  )

  return suiInterfaces
}
```

## Complete Deposit Flow

```typescript
import { TBTC } from "@keep-network/tbtc-v2.ts"

async function performCrossChainDeposit() {
  // 1. Initialize TBTC SDK
  const tbtc = await TBTC.initializeSepolia()

  // 2. Create a SUI keypair or use wallet
  const suiKeypair = new Ed25519Keypair()

  // 3. Initialize cross-chain for SUI
  await tbtc.initializeCrossChain("Sui", suiKeypair)

  // 4. Generate deposit address (Step 0 of the flow)
  const deposit = await tbtc.deposits.initiateCrossChainDeposit(
    "tb1q...", // Bitcoin recovery address
    "Sui"
  )

  console.log("Send BTC to:", deposit.getBitcoinAddress())

  // 5. After BTC is sent and confirmed, initialize on SUI (Step 1)
  await deposit.initializeReveal()

  // The relayer handles steps 2-13 automatically
  console.log(
    "Deposit initialized! The relayer will complete the cross-chain transfer."
  )
}
```

## Key Differences from EVM Chains

1. **Address Format**: SUI uses 32-byte addresses (64 hex characters)

   ```typescript
   // SUI address: 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
   // EVM address: 0x1234567890abcdef1234567890abcdef12345678
   ```

2. **No Vault Support**: Deposits go directly to user addresses

   ```typescript
   // The vault parameter is ignored for SUI
   await depositor.initializeDeposit(tx, index, receipt) // No vault needed
   ```

3. **Transaction Execution**: Uses SuiClient pattern

   ```typescript
   // Internally, the SDK uses:
   const result = await client.signAndExecuteTransaction({
     signer: keypair,
     transaction: tx,
     options: {
       showEffects: true,
       showEvents: true,
       showObjectChanges: true,
     },
   })
   ```

4. **Decimal Precision**: SUI uses 8 decimals vs tBTC's 18
   ```typescript
   // Balance is automatically scaled from 8 to 18 decimals
   const balance = await tbtcToken.balanceOf(suiAddress)
   ```

## Production Considerations

1. **Rate Limits**: Public endpoints are limited to 100 requests/30 seconds

   ```
   Warning: Using public SUI RPC endpoint. Consider using a dedicated node for production.
   ```

2. **Network Configuration**:

   - Mainnet: `https://fullnode.mainnet.sui.io:443`
   - Testnet: `https://fullnode.testnet.sui.io:443`
   - Devnet: `https://fullnode.devnet.sui.io:443`

3. **Error Handling**:
   ```typescript
   try {
     await deposit.initializeReveal()
   } catch (error) {
     if (error instanceof SuiError) {
       console.error("SUI-specific error:", error.message)
     }
   }
   ```

## Event Monitoring

The SDK logs DepositInitialized events for debugging:

```
SUI DepositInitialized event: {
  type: '0x1db1fc...::BitcoinDepositor::DepositInitialized',
  parsedJson: {
    deposit_key: '0x...',
    funding_tx: '0x...',
    deposit_reveal: '0x...',
    deposit_owner: '0x...',
    sender: '0x...'
  }
}
```

If this event is not found, the relayer may not process the deposit.
