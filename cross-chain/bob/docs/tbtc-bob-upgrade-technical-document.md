# TBTC Token Upgrade on BOB: Legacy Bridge Transition Technical Document

## Executive Summary

This document details the upgrade mechanism for transitioning TBTC tokens on BOB from the legacy `OptimismMintableUpgradableERC20` contract to the enhanced `OptimismMintableUpgradableTBTC` contract. The upgrade introduces a sophisticated bridge transition system through the `legacyCapRemaining` functionality, enabling a smooth migration from a single-bridge architecture to a multi-bridge ecosystem while maintaining token integrity and user experience.

## Background

The original TBTC implementation on BOB utilized the standard `OptimismMintableUpgradableERC20` contract, which restricted minting and burning operations exclusively to a single bridge address. As the ecosystem evolved, the need arose for:

- Multiple bridge support (e.g., CCIP, LayerZero)
- Enhanced security through guardian-based pause mechanisms
- Governance-controlled minter management
- Smooth transition without disrupting existing bridge operations

## Core Upgrade Features

### 1. Multi-Minter Architecture

The upgraded contract transitions from a single-bridge model to a multi-minter system:

```solidity
mapping(address => bool) public isMinter;
address[] public minters;
```

This allows multiple bridges to mint TBTC, expanding cross-chain accessibility while maintaining security through owner-controlled minter management.

### 2. Guardian System

Introduction of a guardian mechanism for emergency response:

```solidity
mapping(address => bool) public isGuardian;
address[] public guardians;
```

Guardians can pause minting and burning operations in case of security incidents, providing a rapid response mechanism without requiring governance intervention.

### 3. Legacy Cap Remaining Mechanism

The centerpiece of the upgrade is the `legacyCapRemaining` state variable, which manages the transition from the old bridge to the new multi-bridge ecosystem.

## Legacy Cap Remaining: Deep Dive

### Initialization

During the upgrade (initializeV2), `legacyCapRemaining` is set to the current total supply:

```solidity
legacyCapRemaining = totalSupply();
```

This captures the exact amount of tokens that were minted through the legacy bridge at the time of upgrade.

### Operational Mechanics

#### Minting Behavior

When the legacy bridge (BRIDGE) mints new tokens:

```solidity
if (msg.sender == BRIDGE) {
    legacyCapRemaining += amount;
}
```

This increases the cap, acknowledging that more tokens have entered through the legacy path.

#### Burning Restrictions

The burning mechanism implements it's logic based on `legacyCapRemaining`:

1. **Standard Bridge Burns**: The legacy bridge can burn tokens up to the `legacyCapRemaining` amount:

   ```solidity
   function burn(address _from, uint256 _amount) external onlyBridge {
     require(legacyCapRemaining > 0, "Legacy cap exhausted");
     require(
       _amount <= legacyCapRemaining,
       "Amount exceeds legacy cap remaining"
     );
     legacyCapRemaining -= _amount;
   }
   ```

2. **General Burns via burnFrom**: When `legacyCapRemaining > 0`, only the bridge can execute burnFrom:
   ```solidity
   if (legacyCapRemaining > 0) {
       require(msg.sender == BRIDGE, "Only bridge can burn while legacy cap remains");
       require(amount <= legacyCapRemaining, "Amount exceeds legacy cap remaining");
       legacyCapRemaining -= amount;
   }
   ```

### Transition Dynamics

The `legacyCapRemaining` mechanism creates a natural transition path:

1. **Phase 1 - Dual Operation**: Both legacy and new bridges operate simultaneously

   - Legacy bridge continues normal operations within its cap
   - New bridges can mint additional supply
   - Legacy bridge maintains exclusive burn rights for its minted tokens

2. **Phase 2 - Cap Depletion**: As users bridge back through the legacy bridge

   - `legacyCapRemaining` decreases with each burn
   - New bridge supply remains unaffected
   - System gradually shifts liquidity to new bridges

3. **Phase 3 - Full Transition**: When `legacyCapRemaining` reaches zero
   - Legacy bridge can no longer burn tokens
   - All burning operations become available to token holders
   - New bridges become the primary liquidity providers

## Alternative Approach Consideration: New Bridge Cap

### The Rejected Alternative

An alternative design was considered where instead of tracking the legacy bridge capacity, the system would implement a cap on new bridge mints. Under this model:

- A maximum cap would be set for new bridges (e.g., CCIP)
- Legacy bridge would continue unrestricted
- Cap would deplete as users bridge through new systems

### Why This Approach Was Rejected

This alternative suffers from critical user experience issues:

1. **Sporadic Availability**: With limited new bridge capacity, the service would frequently become unavailable, forcing users back to the 7-day legacy bridge

2. **Unpredictable Bridge Selection**: Users would face a constantly shifting landscape:
   - New bridge available → Bridge depletes → Forced to legacy bridge (7 days)
   - Someone bridges back → New bridge briefly available → Depletes again
3. **System Instability**: The sporadic transitions between bridges would create:

   - Lack of predictability for users and integrators
   - Difficult UX for applications building on top
   - Potential for front-running and MEV exploitation
   - No clear migration path or timeline

4. **Conformity Issues**: Applications and users require stable, predictable infrastructure. The constant switching between fast (new) and slow (legacy) bridges would make it impossible to provide consistent service guarantees.

The chosen `legacyCapRemaining` approach provides superior characteristics:

- Predictable, one-way transition
- No service interruptions for users
- Clear migration incentives
- Stable system behavior throughout the transition

## Security Considerations

1. **Reentrancy Protection**: All state changes occur before external calls
2. **Access Control**: Multi-layered permission system (owner, minters, guardians)
3. **Pause Mechanism**: Emergency response capability without governance delay
4. **Cap Enforcement**: Mathematical guarantees on token supply integrity

## Migration Timeline

The migration follows a natural, market-driven timeline:

1. **Immediate**: New bridges can begin operations
2. **Gradual**: Legacy bridge usage naturally decreases
3. **Organic**: No forced migration or deadlines
4. **Complete**: Legacy bridge naturally phases out when cap reaches zero

### BOB Bridge Frontend-Driven Depletion

While it is not possible to deactivate the legacy BOB bridge at the contract level, it will be deactivated on the frontend user interface. This action will guide users exclusively towards the new bridges for minting operations. As a result, we anticipate that `legacyCapRemaining` will invariably decrease over time as users burn their legacy tokens, leading to a complete depletion of the cap and a full migration to the new, more versatile bridge architecture. This ensures a user-driven but guided transition.

## Conclusion

The `legacyCapRemaining` mechanism represents a thoughtful approach to bridge migration, prioritizing user experience and system stability. By tracking and limiting the legacy bridge's burn capacity rather than restricting new bridge mints, the system ensures:

- Continuous service availability
- Predictable transition dynamics
- No artificial constraints on growth
- Natural market-driven migration

This design demonstrates the importance of considering not just technical feasibility but also user experience and system predictability when designing critical infrastructure upgrades.
