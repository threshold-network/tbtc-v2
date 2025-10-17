# Rebate Deployment Instructions for All Actors

## Overview

The rebate functionality requires coordination between three actors:

1. **Deployer** - Deploys contracts and prepares transactions
2. **ProxyAdmin Owner** - Upgrades Bridge proxy
3. **Governance** - Sets RebateStaking in Bridge

---

## Actor 1: Deployer

### Prerequisites:

- Access to deployment wallet with ETH
- Environment variables set:
  ```bash
  export CHAIN_API_URL="your_rpc_url"
  export ACCOUNTS_PRIVATE_KEYS="your_private_key"
  ```

### Steps:

1. **Deploy all contracts:**

   ```bash
   cd solidity
   yarn deploy --tags DeployRebateAndPrepareTxs --network mainnet
   ```

2. **Save the output** - It contains:

   - Deployed contract addresses
   - Transaction data for other actors
   - JSON file location with all deployment info

3. **Share with other actors:**
   - Send ProxyAdmin section to ProxyAdmin owner
   - Send Governance section to Governance team
   - Keep JSON file for reference

---

## Actor 2: ProxyAdmin Owner (Multisig/Hardware Wallet)

### What you'll receive from Deployer:

```
ACTION REQUIRED BY PROXY ADMIN OWNER:
================================================
To:   0x[ProxyAdmin_Address]
Data: 0x[Encoded_Transaction_Data]

Decoded:
  Method: upgrade(address,address)
  Params:
    proxy:          0x[Bridge_Proxy_Address]
    implementation: 0x[New_Implementation_Address]
```

### Steps:

1. **Execute the upgrade transaction:**

   - **To:** ProxyAdmin address provided
   - **Data:** Use encoded data provided
   - **Value:** 0 ETH

   **For Gnosis Safe:**

   - New Transaction → Contract Interaction
   - Contract: ProxyAdmin address
   - Method: `upgrade`
   - proxy: Bridge address
   - implementation: New implementation address

2. **Confirm transaction** and wait for execution

3. **Notify Governance** that Bridge is upgraded

---

## Actor 3: Governance (Threshold Council)

### What you'll receive from Deployer:

```
ACTION REQUIRED BY GOVERNANCE:
================================================
To:   0x[BridgeGovernance_Address]
Data: 0x[Encoded_Governance_Transaction]

Note: 48-hour timelock on mainnet, 60 seconds on Sepolia
WARNING: Only submit AFTER Bridge proxy is upgraded!
```

### Steps:

1. **Wait for confirmation** that ProxyAdmin has upgraded Bridge

2. **Submit governance proposal:**

   - **To:** BridgeGovernance address
   - **Data:** Use encoded data provided
   - **Value:** 0 ETH

3. **Wait for timelock:**

   - Mainnet: 48 hours
   - Sepolia: 60 seconds

4. **After timelock expires**, anyone can finalize:
   ```bash
   yarn deploy --tags FinalizeGovernanceUpdate --network mainnet
   ```

---

## Verification

### Check deployment status at any time:

```bash
yarn deploy --tags VerifyRebateDeployment --network mainnet
```
