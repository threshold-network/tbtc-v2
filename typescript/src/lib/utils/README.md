# NTT Utilities

This module provides utility functions for NTT (Native Token Transfer) bridges. These functions were removed from on-chain contracts to reduce bytecode size but are available off-chain for encoding and decoding destination chain and recipient data.

## Functions

### `encodeDestinationReceiver(chainId, recipient)`

Encodes a destination chain ID and recipient address into a 32-byte value.

**Parameters:**

- `chainId` (number): Wormhole chain ID of the destination chain (0-65535)
- `recipient` (string): Recipient address on the destination chain (20 bytes, hex format)

**Returns:** `Hex` - The encoded receiver data as a 32-byte hex string

**Example:**

```typescript
import { encodeDestinationReceiver } from "@keep-network/tbtc-v2"

const encoded = encodeDestinationReceiver(
  40,
  "0x1234567890123456789012345678901234567890"
)
console.log(encoded.toPrefixedString())
// Output: "0x00000000000000000000000000000000000000000000000000000000000000281234567890123456789012345678901234567890"
```

### `decodeDestinationReceiver(encodedReceiver)`

Decodes destination chain ID and recipient address from encoded receiver data.

**Parameters:**

- `encodedReceiver` (Hex | string): The encoded receiver data (32 bytes)

**Returns:** `{ chainId: number, recipient: string }` - Object containing the decoded chain ID and recipient address

**Example:**

```typescript
import { decodeDestinationReceiver } from "@keep-network/tbtc-v2"

const { chainId, recipient } = decodeDestinationReceiver(encoded)
console.log(chainId) // 40
console.log(recipient) // "0x1234567890123456789012345678901234567890"
```

### `isValidEncodedReceiver(encodedReceiver)`

Validates that an encoded receiver has the correct format.

**Parameters:**

- `encodedReceiver` (Hex | string): The encoded receiver data to validate

**Returns:** `boolean` - True if the format is valid, false otherwise

### `getChainIdFromEncodedReceiver(encodedReceiver)`

Gets the chain ID from encoded receiver data without full decoding.

**Parameters:**

- `encodedReceiver` (Hex | string): The encoded receiver data

**Returns:** `number` - The chain ID

### `getRecipientFromEncodedReceiver(encodedReceiver)`

Gets the recipient address from encoded receiver data without full decoding.

**Parameters:**

- `encodedReceiver` (Hex | string): The encoded receiver data

**Returns:** `string` - The recipient address

## Usage in NTT Bridges

These utilities are particularly useful for SEI and other NTT bridges where you need to encode destination chain and recipient information for cross-chain transfers.

```typescript
import {
  encodeDestinationReceiver,
  decodeDestinationReceiver,
} from "@keep-network/tbtc-v2"

// Encode destination for SEI chain
const seiChainId = 40
const recipient = "0x1234567890123456789012345678901234567890"
const encoded = encodeDestinationReceiver(seiChainId, recipient)

// Use the encoded value in your NTT bridge operations
// ...

// Later, decode to get the original values
const { chainId, recipient: decodedRecipient } =
  decodeDestinationReceiver(encoded)
```

## Error Handling

All functions include proper error handling for invalid inputs:

- Invalid chain IDs (outside 0-65535 range)
- Invalid recipient addresses (wrong format or length)
- Invalid encoded data (wrong length or format)

Make sure to handle these errors appropriately in your application.
