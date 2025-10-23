# Class: StarkNetExtraDataEncoder

Implementation of the StarkNet ExtraDataEncoder.

This encoder handles the encoding and decoding of StarkNet addresses
for cross-chain deposits. StarkNet addresses are felt252 field elements
that are encoded as 32-byte values for compatibility with L1 contracts.

**`See`**

for reference.

## Implements

- [`ExtraDataEncoder`](../interfaces/ExtraDataEncoder.md)

## Table of contents

### Constructors

- [constructor](StarkNetExtraDataEncoder.md#constructor)

### Methods

- [decodeDepositOwner](StarkNetExtraDataEncoder.md#decodedepositowner)
- [encodeDepositOwner](StarkNetExtraDataEncoder.md#encodedepositowner)

## Constructors

### constructor

• **new StarkNetExtraDataEncoder**(): [`StarkNetExtraDataEncoder`](StarkNetExtraDataEncoder.md)

#### Returns

[`StarkNetExtraDataEncoder`](StarkNetExtraDataEncoder.md)

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

[lib/starknet/extra-data-encoder.ts:44](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/extra-data-encoder.ts#L44)

___

### encodeDepositOwner

▸ **encodeDepositOwner**(`depositOwner`): [`Hex`](Hex.md)

Encodes a StarkNet address into extra data for cross-chain deposits.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositOwner` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) | The deposit owner identifier. Must be a StarkNetAddress. |

#### Returns

[`Hex`](Hex.md)

The encoded extra data as a 32-byte hex value.

**`Throws`**

Error if the deposit owner is not a StarkNetAddress instance.

**`See`**

#### Implementation of

[ExtraDataEncoder](../interfaces/ExtraDataEncoder.md).[encodeDepositOwner](../interfaces/ExtraDataEncoder.md#encodedepositowner)

#### Defined in

[lib/starknet/extra-data-encoder.ts:24](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/extra-data-encoder.ts#L24)
