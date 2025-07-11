# Class: SolanaExtraDataEncoder

Implementation of the Solana ExtraDataEncoder.

This encoder handles the encoding and decoding of Solana addresses
for cross-chain deposits. Solana addresses are 32-byte values.

**`See`**

for reference.

## Implements

- [`ExtraDataEncoder`](../interfaces/ExtraDataEncoder.md)

## Table of contents

### Constructors

- [constructor](SolanaExtraDataEncoder.md#constructor)

### Methods

- [decodeDepositOwner](SolanaExtraDataEncoder.md#decodedepositowner)
- [encodeDepositOwner](SolanaExtraDataEncoder.md#encodedepositowner)

## Constructors

### constructor

• **new SolanaExtraDataEncoder**(): [`SolanaExtraDataEncoder`](SolanaExtraDataEncoder.md)

#### Returns

[`SolanaExtraDataEncoder`](SolanaExtraDataEncoder.md)

## Methods

### decodeDepositOwner

▸ **decodeDepositOwner**(`extraData`): [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

Decodes extra data back into a StarkNet address.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `extraData` | [`Hex`](Hex.md) | The extra data to decode. Must be exactly 32 bytes. |

#### Returns

[`ChainIdentifier`](../interfaces/ChainIdentifier.md)

The decoded StarkNetAddress instance.

**`Throws`**

Error if the extra data is missing, null, or not exactly 32 bytes.

**`See`**

#### Implementation of

[ExtraDataEncoder](../interfaces/ExtraDataEncoder.md).[decodeDepositOwner](../interfaces/ExtraDataEncoder.md#decodedepositowner)

#### Defined in

[lib/solana/extra-data-encoder.ts:41](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/solana/extra-data-encoder.ts#L41)

___

### encodeDepositOwner

▸ **encodeDepositOwner**(`depositOwner`): [`Hex`](Hex.md)

Encodes a StarkNet address into extra data for cross-chain deposits.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositOwner` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) | The deposit owner identifier. Must be a SolanaAddress. |

#### Returns

[`Hex`](Hex.md)

The encoded extra data as a 32-byte hex value.

**`Throws`**

Error if the deposit owner is not a SolanaAddress instance.

**`See`**

#### Implementation of

[ExtraDataEncoder](../interfaces/ExtraDataEncoder.md).[encodeDepositOwner](../interfaces/ExtraDataEncoder.md#encodedepositowner)

#### Defined in

[lib/solana/extra-data-encoder.ts:23](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/solana/extra-data-encoder.ts#L23)
