# L2 TBTC Bitcoin Depositor Contract Documentation

## Overview

The BitcoinDepositor contract is a cross-chain messaging and token reception module designed to handle Bitcoin deposit interactions on the Sui blockchain. It works in conjunction with the Gateway contract to facilitate secure token transfers and message processing from Ethereum (Layer 1) to Sui.

## Key Constants

- `EMITTER_CHAIN_L1`: Identifies the Ethereum blockchain (Chain ID 2)
- `INVALID_CHAIN_ID`: Error code for invalid chain identification
- `INVALID_SENDER`: Error code for unauthorized message sender
- `MESSAGE_ALREADY_PROCESSED`: Error code for replay attack prevention

## Key Structs

### ReceiverState
Manages the contract's core state:
- `processed_vaas`: A table tracking processed Verified Action Approvals (VAAs)
- `trusted_emitter`: The authorized Wormhole external address for message emission

### AdminCap
An administrative capability object that grants privileged access to contract management functions.

## Events

### MessageProcessed
Emitted when a Wormhole message is successfully processed:
- `vaa_hash`: Hash of the processed VAA

### DepositInitialized
Emitted when a new Bitcoin deposit is initiated:
- `funding_tx`: Bitcoin funding transaction data
- `deposit_reveal`: Deposit reveal information
- `deposit_owner`: Address of the L2 deposit owner
- `sender`: Sender's external address

## Administrative Methods

### `init`
Initializes the contract with a default state:
- Creates a `ReceiverState` with an empty trusted emitter address
- Transfers an `AdminCap` to the contract deployer

### `set_trusted_emitter`
Sets the trusted emitter address for cross-chain communication.

**Parameters:**
- `_: &AdminCap`: Administrative capability
- `state: &mut ReceiverState`: Contract state
- `emitter: vector<u8>`: Wormhole external address of the L1 BitcoinDepositor

**Behavior:**
- Updates the trusted emitter address in the contract state

## Deposit Methods

### `initialize_deposit`
Initiates a new Bitcoin deposit process.

**Parameters:**
- `funding_tx`: Bitcoin funding transaction data
- `deposit_reveal`: Deposit reveal information
- `deposit_owner`: Address of the L2 deposit owner

**Behavior:**
- Emits a `DepositInitialized` event with deposit details

## Cross-Chain Message Processing

### `receiveWormholeMessages`
Processes incoming cross-chain messages from the Ethereum BitcoinDepositor.

**Parameters:**
- Multiple state objects including `ReceiverState`, `Gateway::GatewayState`, etc.
- `vaa_bytes`: Raw Verified Action Approval (VAA) bytes
- `clock: &Clock`: Current time reference
- Other blockchain state and capability objects

**Key Processing Steps:**
1. Verify the VAA's authenticity
2. Check that the message hasn't been processed before
3. Validate the emitter's chain and address
4. Mark the VAA as processed
5. Emit a `MessageProcessed` event
6. Call the Gateway contract to redeem tokens

## Security Considerations

- Prevents replay attacks by tracking processed VAAs
- Restricts message processing to a specific chain and trusted emitter
- Requires administrative capability for critical configurations
- Leverages Wormhole's cross-chain messaging infrastructure

## Initialization and Testing

- Provides a separate `init_test` method for testing purposes
- Supports modular initialization with administrative capabilities

## Deployment

### Step 1: Publish the contract

Open the terminal and navigate to the project directory. Run the following command to publish the contract:

```bash
sui client publish ./ --gas-budget 1000000
```

### Step 2: Add trusted emitter, etc..

After the Bitcoin Depositor contract is initialized, the deployer has to add the trusted emitters, etc.

## License

This contract is licensed under GPL-3.0-only.

## Interaction Flow

1. Bitcoin deposit is initiated on Ethereum
2. Wormhole relayers transmit the deposit information
3. `receiveWormholeMessages` validates and processes the message
4. Gateway contract handles token redemption
5. Tokens are minted or transferred to the deposit owner on Sui

## Dependencies

- Relies on Wormhole for cross-chain messaging
- Integrates with the L2 TBTC Gateway contract
- Uses Sui's object and capability model