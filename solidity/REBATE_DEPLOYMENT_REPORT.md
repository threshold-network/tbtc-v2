# TBTC Rebate System Deployment Report

**Deployment Date**: October 20, 2025
**Network**: Ethereum Mainnet
**Deployer**: 0x716089154304f22a2F9c8d2f8C45815183BF3532
**Summary File**: `deployments/mainnet/rebate-deployment-1760985106095.json`

## Deployment Status: ✅ COMPLETED

### Deployed Contracts

#### 1. RebateStaking Contract

- **Proxy Address**: `0x0184739C32edc3471D3e4860c8E39a5f3Ff85A45`
- **Implementation**: `0xE490c802f8455EA1f0dF96a7B5043536a41E2535`
- **Status**: ✅ Deployed and configured
- **Configuration**:
  - Rolling window: 30 days (2,592,000 seconds)
  - Unstaking period: 30 days (2,592,000 seconds)
  - Rebate rate: 0.001 BTC per 100,000 T tokens staked

#### 2. Bridge Implementation (with Rebate Support)

- **Implementation Address**: `0x98e19c416100Ad0C66B52d05075F4C899184f2aD`
- **Status**: ✅ Deployed with rebate functions
- **New Functions**:
  - `setRebateStaking(address rebateStaking)`
  - `getRebateStaking() returns (RebateStaking)`

### Existing Infrastructure

| Contract         | Address                                      | Status           |
| ---------------- | -------------------------------------------- | ---------------- |
| Bridge Proxy     | `0x5e4861a80B55f035D899f66772117F00FA0E8e7B` | ⚠️ Needs upgrade |
| BridgeGovernance | `0xf286EA706A2512d2B9232FE7F8b2724880230b45` | ✅ Ready         |
| ProxyAdmin       | `0x16A76d3cd3C1e3CE843C6680d6B37E9116b5C706` | ✅ Ready         |
| Bank             | `0x65Fbae61ad2C8836fFbFB502A0dA41b0789D9Fc6` | ✅ Active        |
| LightRelay       | `0x836cdFE63fe2d63f8Bdb69b96f6097F36635896E` | ✅ Active        |
| WalletRegistry   | `0x46d52E41C2F300BC82217Ce22b920c34995204eb` | ✅ Active        |

## Required Governance Actions

### Action 1: Bridge Proxy Upgrade (ProxyAdmin Owner)

**Execute First - No Timelock**

```
To: 0x16A76d3cd3C1e3CE843C6680d6B37E9116b5C706
Value: 0 ETH
Data: 0x99a88ec40000000000000000000000005e4861a80b55f035d899f66772117f00fa0e8e7b00000000000000000000000098e19c416100ad0c66b52d05075f4c899184f2ad
```

**Decoded Parameters**:

- Method: `upgrade(address proxy, address implementation)`
- proxy: `0x5e4861a80B55f035D899f66772117F00FA0E8e7B` (Bridge)
- implementation: `0x98e19c416100Ad0C66B52d05075F4C899184f2aD` (New Bridge Implementation)

**Description**: Upgrades the Bridge proxy to point to the new implementation that includes rebate functionality.

---

### Action 2: Connect RebateStaking (Bridge Governance)

**Execute After Action 1 - 48-hour Timelock**

```
To: 0xf286EA706A2512d2B9232FE7F8b2724880230b45
Value: 0 ETH
Data: 0x2b683b3a000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001400000000000000000000000000000000000000000000000000000000000000001ca73c4620000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000005e4861a80b55f035d899f66772117f00fa0e8e7b00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000024ca73c4620000000000000000000000000184739c32edc3471d3e4860c8e39a5f3ff85a4500000000000000000000000000000000000000000000000000000000
```

**Decoded Parameters**:

- Method: `beginGovernanceUpdate(bytes4[] functionSelectors, address[] targets, uint256[] values, bytes[] calldatas)`
- Will call: `Bridge.setRebateStaking(0x0184739C32edc3471D3e4860c8E39a5f3Ff85A45)`

**Description**: Sets the RebateStaking contract address in the Bridge, enabling rebate functionality.

**Important**: This action has a 48-hour timelock period on mainnet. After calling `beginGovernanceUpdate`, wait 48 hours then call `finalizeGovernanceUpdate` to complete the action.

## Verification Commands

After both governance actions are executed:

```bash
# Check Bridge implementation (should be new address)
cast call 0x5e4861a80B55f035D899f66772117F00FA0E8e7B "implementation()" --rpc-url $ETHEREUM_RPC_URL

# Check RebateStaking connection (should return RebateStaking address)
cast call 0x5e4861a80B55f035D899f66772117F00FA0E8e7B "getRebateStaking()" --rpc-url $ETHEREUM_RPC_URL
```

Expected results:

- Implementation: `0x98e19c416100Ad0C66B52d05075F4C899184f2aD`
- RebateStaking: `0x0184739C32edc3471D3e4860c8E39a5f3Ff85A45`

## Timeline

1. **Now**: Deploy completed ✅
2. **ProxyAdmin Owner**: Execute Bridge proxy upgrade (immediate)
3. **Bridge Governance**: Call `beginGovernanceUpdate` (starts 48-hour timer)
4. **48 hours later**: Call `finalizeGovernanceUpdate` to complete
5. **System Active**: Rebate functionality fully operational

## Files Created

- `deployments/mainnet/RebateStaking.json` - RebateStaking deployment artifact
- `deployments/mainnet/rebate-deployment-1760985106095.json` - Complete deployment summary
- `REBATE_DEPLOYMENT_REPORT.md` - This report

## Security Notes

- All contract addresses have been verified against the deployment summary
- Transaction data has been generated deterministically from the deployment script
- ProxyAdmin upgrade is a simple proxy pattern upgrade
- Governance action follows standard 48-hour timelock process
- No emergency powers or backdoors in the rebate system

---

**Deployment completed successfully. Ready for governance execution.**
