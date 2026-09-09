# NTT Utilities

This module provides helpers for fixed-destination NTT (Native Token Transfer) direct depositors.

Each L1 NTT depositor instance has a single configured destination chain. The deposit extra data is the full destination recipient in `bytes32` format; it does not pack a chain ID into the high bytes.

## Functions

### `normalizeNttRecipient(recipient)`

Normalizes a recipient into the 32-byte format expected by Wormhole NTT.

**Parameters:**

- `recipient` (`Hex | string`): 20-byte EVM address or 32-byte Wormhole recipient.

**Returns:** `Hex` - The recipient as a 32-byte hex string.

**Example:**

```typescript
import { normalizeNttRecipient } from "@keep-network/tbtc-v2"

const recipient = normalizeNttRecipient(
  "0x1234567890123456789012345678901234567890"
)

// "0x0000000000000000000000001234567890123456789012345678901234567890"
console.log(recipient.toPrefixedString())
```

### `isValidNttRecipient(recipient)`

Validates that a recipient can be normalized to a 32-byte NTT recipient.

**Parameters:**

- `recipient` (`Hex | string`): Recipient data to validate.

**Returns:** `boolean` - True for 20-byte or 32-byte hex recipients.

## Usage In NTT Bridges

Use `normalizeNttRecipient` when building deposit extra data for a fixed-destination NTT depositor:

```typescript
import { normalizeNttRecipient } from "@keep-network/tbtc-v2"

const evmRecipient = normalizeNttRecipient(
  "0x1234567890123456789012345678901234567890"
)

const fullBytes32Recipient = normalizeNttRecipient(
  "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
)
```

Do not encode a destination chain ID into the recipient. Chain selection is part of the deployed depositor configuration.

## Error Handling

The helpers reject:

- Non-hex input
- Recipient values that are not 20 bytes or 32 bytes
