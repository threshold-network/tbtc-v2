# Class: ArbitrumExtraDataEncoder

Implementation of the Arbitrum ExtraDataEncoder.

**`See`**

for reference.

## Implements

- [`ExtraDataEncoder`](../interfaces/ExtraDataEncoder.md)

## Table of contents

### Constructors

- [constructor](ArbitrumExtraDataEncoder.md#constructor)

### Methods

- [decodeDepositOwner](ArbitrumExtraDataEncoder.md#decodedepositowner)
- [encodeDepositOwner](ArbitrumExtraDataEncoder.md#encodedepositowner)

## Constructors

### constructor

• **new ArbitrumExtraDataEncoder**(): [`ArbitrumExtraDataEncoder`](ArbitrumExtraDataEncoder.md)

#### Returns

[`ArbitrumExtraDataEncoder`](ArbitrumExtraDataEncoder.md)

## Methods

### decodeDepositOwner

▸ **decodeDepositOwner**(`extraData`): [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `extraData` | [`Hex`](Hex.md) |

#### Returns

[`ChainIdentifier`](../interfaces/ChainIdentifier.md)

**`See`**

#### Implementation of

[ExtraDataEncoder](../interfaces/ExtraDataEncoder.md).[decodeDepositOwner](../interfaces/ExtraDataEncoder.md#decodedepositowner)

#### Defined in

[lib/arbitrum/l2-bitcoin-depositor.ts:142](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/arbitrum/l2-bitcoin-depositor.ts#L142)

___

### encodeDepositOwner

▸ **encodeDepositOwner**(`depositOwner`): [`Hex`](Hex.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `depositOwner` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) |

#### Returns

[`Hex`](Hex.md)

**`See`**

#### Implementation of

[ExtraDataEncoder](../interfaces/ExtraDataEncoder.md).[encodeDepositOwner](../interfaces/ExtraDataEncoder.md#encodedepositowner)

#### Defined in

[lib/arbitrum/l2-bitcoin-depositor.ts:128](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/arbitrum/l2-bitcoin-depositor.ts#L128)
