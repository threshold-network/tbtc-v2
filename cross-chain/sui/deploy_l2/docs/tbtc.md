# TBTC Token Contract Documentation

## Overview

The TBTC Token contract is a sophisticated token implementation built on the Sui blockchain. It provides a robust mechanism for managing a token with advanced access control, minting, burning, and pause functionality.

## Key Structs

### `TBTC`
A one-time witness struct for the coin type, used during initialization.

### `AdminCap`
A capability that grants administrative privileges to manage the token contract.

### `MinterCap`
A certificate proving an address has minting permissions.

### `GuardianCap`
A certificate proving an address has guardian permissions.

### `TokenState`
A global state object tracking:
- List of authorized minters
- List of authorized guardians
- Current pause status of the contract

## Contract Initialization

The contract is initialized with:
- Creation of a new currency (TBTC)
- Setting up token metadata
- Creating an initial `TokenState`
- Transferring `AdminCap` to the contract deployer

## Administrative Methods

### `add_minter`
**Purpose:** Add a new address with minting permissions

**Parameters:**
- `_: &AdminCap`: Administrative capability
- `state: &mut TokenState`: Global token state
- `minter: address`: Address to be granted minting rights
- `ctx: &mut TxContext`: Transaction context

**Behavior:**
- Ensures the address is not already a minter
- Adds the address to the minters list
- Creates and transfers a `MinterCap` to the new minter
- Emits a `MinterAdded` event

### `remove_minter`
**Purpose:** Remove an existing minter's permissions

**Parameters:**
- `_: &AdminCap`: Administrative capability
- `state: &mut TokenState`: Global token state
- `minter: address`: Address to remove from minters
- `_ctx: &mut TxContext`: Transaction context

**Behavior:**
- Verifies the address is currently a minter
- Removes the address from the minters list
- Emits a `MinterRemoved` event

### `add_guardian`
**Purpose:** Add a new guardian address

**Parameters:**
- `_: &AdminCap`: Administrative capability
- `state: &mut TokenState`: Global token state
- `guardian: address`: Address to be granted guardian rights
- `ctx: &mut TxContext`: Transaction context

**Behavior:**
- Ensures the address is not already a guardian
- Adds the address to the guardians list
- Creates and transfers a `GuardianCap` to the new guardian
- Emits a `GuardianAdded` event

### `remove_guardian`
**Purpose:** Remove an existing guardian's permissions

**Parameters:**
- `_: &AdminCap`: Administrative capability
- `state: &mut TokenState`: Global token state
- `guardian: address`: Address to remove from guardians
- `_ctx: &mut TxContext`: Transaction context

**Behavior:**
- Verifies the address is currently a guardian
- Removes the address from the guardians list
- Emits a `GuardianRemoved` event

### `unpause`
**Purpose:** Unpause the token contract

**Parameters:**
- `_: &AdminCap`: Administrative capability
- `state: &mut TokenState`: Global token state
- `ctx: &mut TxContext`: Transaction context

**Behavior:**
- Ensures the contract is currently paused
- Sets the pause status to false
- Emits an `Unpaused` event

## Guardian Methods

### `pause`
**Purpose:** Pause the token contract

**Parameters:**
- `_: &GuardianCap`: Guardian capability
- `state: &mut TokenState`: Global token state
- `ctx: &mut TxContext`: Transaction context

**Behavior:**
- Verifies the caller is a guardian
- Ensures the contract is not already paused
- Sets the pause status to true
- Emits a `Paused` event

## Minter Methods

### `mint`
**Purpose:** Mint new tokens to a specified address

**Parameters:**
- `_: &MinterCap`: Minter capability
- `treasury_cap: &mut TreasuryCap<TBTC>`: Treasury capability
- `state: &TokenState`: Global token state
- `amount: u64`: Amount of tokens to mint
- `recipient: address`: Address to receive minted tokens
- `ctx: &mut TxContext`: Transaction context

**Behavior:**
- Verifies the caller is a minter
- Ensures the contract is not paused
- Mints tokens to the specified recipient
- Emits a `TokensMinted` event

## Public Methods

### `burn`
**Purpose:** Burn tokens

**Parameters:**
- `treasury_cap: &mut TreasuryCap<TBTC>`: Treasury capability
- `state: &TokenState`: Global token state
- `coin: Coin<TBTC>`: Coin to be burned

**Behavior:**
- Ensures the contract is not paused
- Burns the specified tokens
- Emits a `TokensBurned` event

## Helper Methods

Several helper methods provide utility functions:
- `is_minter`: Check if an address is a minter
- `is_guardian`: Check if an address is a guardian
- `get_minters`: Retrieve all minter addresses
- `get_guardians`: Retrieve all guardian addresses
- `is_paused`: Check if the contract is paused

## Events

The contract emits various events to track important actions:
- `MinterAdded`
- `MinterRemoved`
- `GuardianAdded`
- `GuardianRemoved`
- `Paused`
- `Unpaused`
- `TokensMinted`
- `TokensBurned`

## Security Considerations

- Requires administrative or specific capabilities for sensitive operations
- Supports pausing the entire token contract
- Granular access control through minters and guardians
- Prevents unauthorized minting and burning

## Deployment

### Step 1: Publish the contract
```bash
sui client publish ./ --gas-budget 1000000
```

### Step 2: Add trusted minters, guardians, etc..
Use the contract's methods to add trusted minters, guardians, etc.

## License

This contract is licensed under GPL-3.0-only.