# Fee Rebates Redeployment

## Summary
Fee rebates were not applied because the Bridge implementation was linked
against an older Redemption library that did not include the rebate call path.

## Problem
Redemption requests were still charging the standard fee even when a rebate
should have been applied. On-chain inspection showed the Bridge implementation
did not include the expected rebate logic.

## Root Cause
The Redemption contract is a separately deployed library that is linked at
compile time into the Bridge implementation bytecode. The Bridge upgrade was
performed with an older Redemption library address, so the resulting
implementation did not include the updated rebate logic.

## Fix
1. Deploy a fresh Redemption library (new address).
2. Recompile and deploy a new Bridge implementation explicitly linked to that
   library.
3. Upgrade the Bridge proxy to the new implementation.
4. Verify both the library and the new Bridge implementation on Etherscan.

Relevant scripts:
- `solidity/deploy/81_deploy_redemption_library.ts`
- `solidity/deploy/80_upgrade_bridge_v2.ts`

## Next Steps

### Deployer
- [ ] Set environment for mainnet deployment:
  - `export CHAIN_API_URL="$ETHEREUM_MAINNET_RPC_URL"`
  - `export CONTRACT_OWNER_ACCOUNT_PRIVATE_KEY="$ETHEREUM_MAINNET_SHARED_ENG_PRIVATE_KEY"`
- [x] Deploy the Redemption library on mainnet:
  - `yarn deploy --tags RedemptionLibrary --network mainnet`
- [x] Record the Redemption deployment details:
  - **Tx hash:** `0xe5e2e6f6be1a0fbb53b3fd3634850be510797efd303bf91d8a1c118f0b177ac6`
    (https://etherscan.io/tx/0xe5e2e6f6be1a0fbb53b3fd3634850be510797efd303bf91d8a1c118f0b177ac6)
  - **Library address:** `0xA7FEd184FE79c2EA037e65558473C04ce42F5D0D`
    (https://etherscan.io/address/0xA7FEd184FE79c2EA037e65558473C04ce42F5D0D)
- [x] Deploy the Bridge implementation linked to the new Redemption library:
  - `UPGRADE_BRIDGE=true yarn deploy --tags UpgradeBridge --network mainnet`
- [x] Record the Bridge deployment details:
  - **Implementation deploy tx hash:** `0xfb73536a1283663cf34cca1fdf998c1691d9865f253fff513d30271ad6d21489`
    (https://etherscan.io/tx/0xfb73536a1283663cf34cca1fdf998c1691d9865f253fff513d30271ad6d21489)
  - **New implementation address:** `0x8Ce2003ABEe1F37fb055E52c14A5eeea00aD1cE7`
    (https://etherscan.io/address/0x8Ce2003ABEe1F37fb055E52c14A5eeea00aD1cE7)

### Governance (Threshold Council)
- [ ] Execute the upgrade via ProxyAdmin using the calldata supplied by the
  deployer.
- [ ] Record the upgrade path:
  - **ProxyAdmin owner:** `0x92f2d8b72a7F6a551Be60b9aa4194248E9B4913D`
    (https://etherscan.io/address/0x92f2d8b72a7F6a551Be60b9aa4194248E9B4913D)
  - **Target contract (ProxyAdmin):** `0x16A76d3cd3C1e3CE843C6680d6B37E9116b5C706`
    (https://etherscan.io/address/0x16A76d3cd3C1e3CE843C6680d6B37E9116b5C706)
  - **Call:** `upgrade(address proxy, address implementation)`
  - **Proxy address (Bridge):** `0x5e4861A80B55F035D899F66772117f00fa0E8e7B`
    (https://etherscan.io/address/0x5e4861A80B55F035D899F66772117f00fa0E8e7B)
  - **Implementation address:** `0x8Ce2003ABEe1F37fb055E52c14A5eeea00aD1cE7`
    (https://etherscan.io/address/0x8Ce2003ABEe1F37fb055E52c14A5eeea00aD1cE7)
  - **Calldata:** `0x99a88ec40000000000000000000000005e4861a80b55f035d899f66772117f00fa0e8e7b0000000000000000000000008ce2003abee1f37fb055e52c14a5eeea00ad1ce7`
  - **Tx hash:** `PENDING (upgrade not executed yet)`
- [ ] Simulate transactions in Tenderly to confirm the upgrade was successful. Check the Redemption library address in the Bridge implementation bytecode has changed.
- [ ] Verify the new Bridge implementation is verified on Etherscan and linked to
  the new Redemption library address.
