# L2 TBTC Gateway Contract Documentation

## Overview

The L2 TBTC Gateway contract is a sophisticated cross-chain token bridge implementation built on the Sui blockchain. It provides a secure mechanism for token transfers and redemption across different blockchain networks using Wormhole's messaging infrastructure.

## Key Structs

### GatewayState
Stores the core state of the gateway, including:
- Processed VAA (Verified Action Approval) hashes
- Trusted emitters and receivers
- Minting limits and current minted amount
- Initialization and pause status

### GatewayCapabilities
Manages critical capabilities:
- TBTC Minter Capability
- Wormhole Emitter Capability
- TBTC Treasury Capability

### AdminCap
A capability that grants administrative privileges to manage the gateway.

### WrappedTokenTreasury
Stores wrapped tokens for cross-chain transfers aquired from the bridge.

## Administrative Methods

### `initialize_gateway`
Initializes the gateway with all required capabilities.

**Parameters:**
- `_: &AdminCap`: Admin capability
- `state: &mut GatewayState`: Gateway state object
- `wormhole_state: &WormholeState`: Wormhole state
- `minter_cap: TBTC::MinterCap`: TBTC minter capability
- `treasury_cap: TreasuryCap<TBTC::TBTC>`: TBTC treasury capability

**Behavior:**
- Verifies the gateway is not already initialized
- Creates an emitter capability
- Shares the capabilities object
- Initializes the token treasury
- Emits a `GatewayInitialized` event

### `add_trusted_emitter`
Adds a trusted emitter from another blockchain.

**Parameters:**
- `_: &AdminCap`: Admin capability
- `state: &mut GatewayState`: Gateway state
- `emitter_id: u16`: Chain ID of the emitter
- `emitter: vector<u8>`: External address of the emitter

**Behavior:**
- Adds the emitter to the trusted emitters table
- Emits an `EmitterRegistered` event

### `add_trusted_receiver`
Adds a trusted receiver on another blockchain.

**Parameters:**
- `_: &AdminCap`: Admin capability
- `state: &mut GatewayState`: Gateway state
- `receiver_id: u16`: Chain ID of the receiver
- `receiver: vector<u8>`: External address of the receiver

**Behavior:**
- Adds the receiver to the trusted receivers table
- Emits a `ReceiverRegistered` event

### `pause` and `unpause`
Administrative methods to pause or unpause the gateway.

**Parameters:**
- `_: &AdminCap`: Admin capability
- `state: &mut GatewayState`: Gateway state

**Behavior:**
- Sets the gateway's pause status
- Emits `Paused` or `Unpaused` events

### `update_minting_limit`
Updates the maximum amount of tokens that can be minted.

**Parameters:**
- `_: &AdminCap`: Admin capability
- `state: &mut GatewayState`: Gateway state
- `new_limit: u64`: New minting limit

**Behavior:**
- Updates the minting limit
- Emits a `MintingLimitUpdated` event

### `change_admin`
Transfers administrative capabilities to a new admin.

**Parameters:**
- `admin_cap: AdminCap`: Current admin capability
- `new_admin: address`: Address of the new admin

**Behavior:**
- Transfers admin capability to the new admin
- Emits an `AdminChanged` event

## Token Transfer Methods

### `redeem_tokens`
Redeems tokens from a Wormhole VAA (Verified Action Approval).

**Parameters:**
- Multiple state and capability objects
- `vaa_bytes: vector<u8>`: Encoded VAA
- `clock: &Clock`: Current time
- Other blockchain state objects

**Behavior:**
- Verifies the VAA is valid and from a trusted source
- Checks minting limits
- Mints or transfers wrapped tokens to the recipient
- Emits a `TokensRedeemed` event

### `send_tokens`
Sends TBTC tokens to another blockchain via the token bridge.

**Parameters:**
- Multiple state and capability objects
- `recipient_chain: u16`: Destination chain ID
- `recipient_address: vector<u8>`: Recipient's address
- `coins: Coin<TBTC::TBTC>`: Tokens to send
- `nonce: u32`: Unique transaction identifier
- `message_fee: Coin<sui::sui::SUI>`: Fee for message transmission

**Behavior:**
- Burns local tokens
- Prepares a cross-chain transfer
- Publishes a message via Wormhole
- Emits a `TokensSent` event

### `send_wrapped_tokens`
Sends wrapped tokens to another blockchain.

**Parameters:**
Similar to `send_tokens`, but works with wrapped token types.

**Behavior:**
- Prepares a cross-chain transfer of wrapped tokens
- Publishes a message via Wormhole
- Emits a `TokensSent` event

## Helper Methods

Several helper methods provide utility functions:
- `emitter_exists`: Checks if an emitter is trusted
- `get_emitter`: Retrieves a trusted emitter's address
- `receiver_exists`: Checks if a receiver is trusted
- `get_receiver`: Retrieves a trusted receiver's address
- `is_initialized`: Checks gateway initialization status
- `is_paused`: Checks gateway pause status
- `get_minting_limit`: Retrieves current minting limit
- `get_minted_amount`: Retrieves current minted token amount

## Events

The contract emits various events to track important actions:
- `EmitterRegistered`
- `ReceiverRegistered`
- `Paused`
- `Unpaused`
- `MintingLimitUpdated`
- `TokensRedeemed`
- `TokensSent`
- `AdminChanged`

## Security Considerations

- Requires admin capabilities for sensitive operations
- Prevents replay attacks through VAA hash tracking
- Implements minting limits
- Supports pausing the entire gateway
- Relies on trusted emitters and receivers

## Deployment

### Step 1: Publish the contract

Open the terminal and navigate to the project directory. Run the following command to publish the contract:

```bash
sui client publish ./ --gas-budget 1000000
```

### Step 2: Call the contracts methods for initialization

In order to get the contract going the deployer has to call the init method.

``` move 
 /// Admin function to initialize the gateway with all required capabilities
    /// Requires AdminCap
    /// state - Gateway state
    /// wormhole_state - Wormhole state
    /// minter_cap - TBTC minter capability
    /// treasury_cap - TBTC treasury capability
    /// ctx - Transaction context
    /// Emits GatewayInitialized event
    public entry fun initialize_gateway<CoinType>(
        _: &AdminCap,
        state: &mut GatewayState,
        wormhole_state: &WormholeState,
        minter_cap: TBTC::MinterCap,
        treasury_cap: TreasuryCap<TBTC::TBTC>,
        ctx: &mut TxContext,
    ) { ....}
``` 

### Step 3: Add trusted emitters, receivers, change minting limit etc..

After the gateway is initialized, the deployer has to add the trusted emitters, receivers, change minting limit etc.

## License

This contract is licensed under GPL-3.0-only.