# Class: SeiExtraDataEncoder

Implementation of the ExtraDataEncoder for Sei chain.
Encodes Sei addresses as 32-byte values for use in Bitcoin deposit scripts.
Since Sei uses EVM-compatible addresses (20 bytes), they are left-padded
with zeros to create a 32-byte value.

## Implements

- [`ExtraDataEncoder`](../interfaces/ExtraDataEncoder.md)

## Table of contents

### Constructors

- [constructor](SeiExtraDataEncoder.md#constructor)

### Methods

- [decodeDepositOwner](SeiExtraDataEncoder.md#decodedepositowner)
- [encodeDepositOwner](SeiExtraDataEncoder.md#encodedepositowner)

## Constructors

### constructor

• **new SeiExtraDataEncoder**(): [`SeiExtraDataEncoder`](SeiExtraDataEncoder.md)

#### Returns

[`SeiExtraDataEncoder`](SeiExtraDataEncoder.md)

## Methods

### decodeDepositOwner

▸ **decodeDepositOwner**(`extraData`): [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

Decodes a 32-byte hex string back to a Sei address.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `extraData` | [`Hex`](Hex.md) | The 32-byte encoded data as Hex |

#### Returns

[`ChainIdentifier`](../interfaces/ChainIdentifier.md)

A SeiAddress instance

**`Throws`**

Error if the data cannot be decoded as a Sei address

#### Implementation of

[ExtraDataEncoder](../interfaces/ExtraDataEncoder.md).[decodeDepositOwner](../interfaces/ExtraDataEncoder.md#decodedepositowner)

#### Defined in

[lib/sei/extra-data-encoder.ts:38](typescript/src/lib/sei/extra-data-encoder.ts#L38)

___

### encodeDepositOwner

▸ **encodeDepositOwner**(`depositOwner`): [`Hex`](Hex.md)

Encodes a Sei address into a 32-byte hex string.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositOwner` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) | The Sei address to encode |

#### Returns

[`Hex`](Hex.md)

A Hex object representing the 32-byte encoded address

**`Throws`**

Error if depositOwner is not a SeiAddress

#### Implementation of

[ExtraDataEncoder](../interfaces/ExtraDataEncoder.md).[encodeDepositOwner](../interfaces/ExtraDataEncoder.md#encodedepositowner)

#### Defined in

[lib/sei/extra-data-encoder.ts:18](typescript/src/lib/sei/extra-data-encoder.ts#L18)
