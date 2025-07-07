# MinterCap Fix Deployment Guide

## Overview

This guide documents the fix for the MinterCap ownership issue that prevents Gateway initialization on SUI. The issue occurs when the MinterCap is transferred to a shared object (Gateway) that cannot sign transactions to use it.

## The Problem

When adding the Gateway as a minter, the original `add_minter` function transfers the MinterCap to the Gateway's address. Since the Gateway is a shared object, it cannot sign transactions to provide the MinterCap during initialization, making the system non-functional.

```move
// Original problematic code
transfer::public_transfer(minter_cap, minter); // minter is Gateway's object ID
```

## The Solution

We've added a new function that returns the MinterCap to the caller instead of transferring it to the minter address. This allows the admin to receive the MinterCap and provide it during Gateway initialization.

### Key Changes

1. **New Function in TBTC Module**: `add_minter_with_cap`
   - Returns MinterCap instead of transferring it
   - Must be `public fun` (not `public entry`) to return non-droppable objects
   - Maintains all security checks and event emissions

2. **Programmable Transaction Block (PTB)**: Combines both operations atomically
   - Adds Gateway as minter and receives MinterCap
   - Immediately initializes Gateway with the MinterCap
   - Single transaction ensures consistency

## Implementation Steps

### 1. Update TBTC Module

Add the following function to `sources/token/tbtc.move` after the existing `add_minter` function:

```move
/// Add a new minter and return the MinterCap to the caller
/// This variant is designed for cases where the minter is a shared object
/// and cannot receive the MinterCap directly (e.g., Gateway)
public fun add_minter_with_cap(
    _: &AdminCap,
    state: &mut TokenState,
    minter: address,
    ctx: &mut TxContext,
): MinterCap {
    assert!(!is_minter(state, minter), E_ALREADY_MINTER);
    
    vector::push_back(&mut state.minters, minter);
    
    let minter_cap = MinterCap {
        id: object::new(ctx),
        minter,
    };
    
    event::emit(MinterAdded { minter });
    
    minter_cap // Return instead of transfer
}
```

### 2. Deploy Updated Contract

```bash
# Build the updated contract
sui move build

# Deploy to testnet
sui client publish --gas-budget 100000000
```

### 3. Run Initialization Script

Update the configuration in `scripts/initialize_gateway_with_ptb.ts` with your deployment values:

```typescript
const config = {
    packageId: 'YOUR_PACKAGE_ID',
    adminCaps: {
        tbtc: 'YOUR_TBTC_ADMIN_CAP',
        gateway: 'YOUR_GATEWAY_ADMIN_CAP',
        treasuryCap: 'YOUR_TREASURY_CAP',
    },
    sharedObjects: {
        tokenState: 'YOUR_TOKEN_STATE',
        gatewayState: 'YOUR_GATEWAY_STATE',
    },
    wormhole: {
        coreState: 'YOUR_WORMHOLE_STATE',
        wrappedTbtcType: 'YOUR_WRAPPED_TBTC_TYPE',
    },
    sui: {
        rpc: 'https://fullnode.testnet.sui.io:443',
        privateKey: 'YOUR_ADMIN_PRIVATE_KEY',
    }
};
```

Run the initialization:

```bash
npm install @mysten/sui.js
npx ts-node scripts/initialize_gateway_with_ptb.ts
```

## Verification

After successful initialization, verify:

1. **Gateway State**:
   - `is_initialized`: true
   - Gateway is in minters list: true

2. **GatewayCapabilities Object**:
   - Contains MinterCap
   - Contains TreasuryCap
   - Contains EmitterCap
   - Is shared object

3. **Test Minting**:
   - Gateway can mint tBTC when receiving Wormhole VAAs
   - Gateway can burn tBTC when users withdraw

## Security Considerations

1. **Admin Trust**: The admin temporarily holds the MinterCap between creation and initialization. This is acceptable as the admin already has AdminCap.

2. **Atomic Operation**: Using PTB ensures both operations happen in a single transaction, preventing state inconsistency.

3. **No Breaking Changes**: Existing `add_minter` function remains unchanged for backward compatibility.

## Alternative Approach

If PTB is not available or preferred, use the two-transaction approach:

```typescript
// Transaction 1: Add minter and send MinterCap to admin
add_minter_to_recipient(adminCap, tokenState, gatewayAddress, adminAddress)

// Transaction 2: Initialize with MinterCap
initialize_gateway(adminCap, gatewayState, wormholeState, minterCapId, treasuryCap)
```

## Troubleshooting

### Common Issues

1. **"Entry function cannot return non-droppable types"**
   - Ensure you're using `public fun` not `public entry fun`

2. **"Object does not exist"**
   - Verify all object IDs in configuration
   - Ensure previous deployment steps completed

3. **"Not authorized"**
   - Confirm admin account has necessary capabilities
   - Check private key matches admin address

## Conclusion

This fix maintains the security properties of the capability-based system while accommodating SUI's shared object model. The Gateway can now be properly initialized and function as intended for cross-chain tBTC bridging.