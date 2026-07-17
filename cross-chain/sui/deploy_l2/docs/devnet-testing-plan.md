# Devnet Testing Plan for MinterCap Fix

## Prerequisites

1. SUI CLI installed and configured for devnet
2. Devnet SUI tokens for gas fees
3. Node.js and npm installed for running scripts

## Testing Steps

### Phase 1: Deployment

1. **Deploy Updated Contracts**
   ```bash
   # Switch to devnet
   sui client switch --env devnet
   
   # Build contracts
   sui move build
   
   # Deploy to devnet
   sui client publish --gas-budget 100000000
   ```

2. **Record Deployment Information**
   - Package ID
   - AdminCap IDs (TBTC, Gateway)
   - TokenState ID
   - GatewayState ID
   - TreasuryCap ID
   - Wormhole state objects

### Phase 2: Object Discovery

1. **List Created Objects**
   ```bash
   # Get all objects owned by admin
   sui client objects
   
   # Get shared objects from deployment
   sui client object <PACKAGE_ID> --json
   ```

2. **Verify Object States**
   - TokenState: Check minters list is empty
   - GatewayState: Verify is_initialized = false
   - AdminCaps: Ensure admin owns all required capabilities

### Phase 3: Gateway Initialization

1. **Update Script Configuration**
   - Edit `scripts/initialize_gateway_with_ptb.ts`
   - Update all object IDs from deployment
   - Set devnet RPC endpoint
   - Configure admin private key

2. **Run Initialization**
   ```bash
   # Install dependencies
   npm install @mysten/sui.js
   
   # Run initialization script
   npx ts-node scripts/initialize_gateway_with_ptb.ts
   ```

3. **Expected Output**
   - Transaction successful
   - Events: MinterAdded, GatewayInitialized
   - New shared object: GatewayCapabilities

### Phase 4: Verification

1. **Check Gateway State**
   ```bash
   # Query Gateway state
   sui client object <GATEWAY_STATE_ID> --json | jq '.data.content.fields'
   ```
   
   Expected:
   - is_initialized: true
   - paused: false
   - minting_limit: appropriate value

2. **Check TokenState**
   ```bash
   # Query Token state
   sui client object <TOKEN_STATE_ID> --json | jq '.data.content.fields.minters'
   ```
   
   Expected:
   - Gateway address in minters list

3. **Check GatewayCapabilities**
   ```bash
   # Query capabilities object
   sui client object <GATEWAY_CAPABILITIES_ID> --json
   ```
   
   Expected:
   - Contains minter_cap
   - Contains treasury_cap
   - Contains emitter_cap

### Phase 5: Functional Testing

1. **Test Minting (via Gateway)**
   - Simulate receiving a Wormhole VAA
   - Call redeem_tokens function
   - Verify canonical tBTC minted to recipient

2. **Test Burning (via Gateway)**
   - Create canonical tBTC coins
   - Call send_tokens function
   - Verify tokens burned and wrapped tokens sent

### Phase 6: Edge Cases

1. **Double Initialization Prevention**
   - Try to initialize Gateway again
   - Should fail with E_ALREADY_INITIALIZED

2. **Unauthorized Access**
   - Try to add minter without AdminCap
   - Should fail with authorization error

3. **Minting Limits**
   - Test minting near the limit
   - Verify proper behavior when limit exceeded

## Success Criteria

- [ ] Contracts deploy successfully
- [ ] Gateway initialization completes in single transaction
- [ ] Gateway appears in minters list
- [ ] GatewayCapabilities object created and accessible
- [ ] Gateway can mint canonical tBTC
- [ ] Gateway can burn canonical tBTC
- [ ] All security checks functioning

## Rollback Plan

If issues are discovered:

1. Document the specific failure point
2. Analyze transaction logs and error messages
3. Fix issues in contracts or scripts
4. Redeploy fresh contracts (new package)
5. Repeat testing process

## Notes

- Devnet can be reset periodically, losing all deployed contracts
- Keep detailed logs of all transactions for debugging
- Test thoroughly before proceeding to testnet/mainnet