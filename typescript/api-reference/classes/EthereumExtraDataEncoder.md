# Class: EthereumExtraDataEncoder

Implementation of the Ethereum ExtraDataEncoder.

**`See`**

for reference.

## Implements

- [`ExtraDataEncoder`](../interfaces/ExtraDataEncoder.md)

## Table of contents

### Constructors

- [constructor](EthereumExtraDataEncoder.md#constructor)

### Methods

- [decodeDepositOwner](EthereumExtraDataEncoder.md#decodedepositowner)
- [encodeDepositOwner](EthereumExtraDataEncoder.md#encodedepositowner)

## Constructors

### constructor

• **new EthereumExtraDataEncoder**(): [`EthereumExtraDataEncoder`](EthereumExtraDataEncoder.md)

#### Returns

[`EthereumExtraDataEncoder`](EthereumExtraDataEncoder.md)

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

[lib/ethereum/l1-bitcoin-depositor.ts:222](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/l1-bitcoin-depositor.ts#L222)

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

[lib/ethereum/l1-bitcoin-depositor.ts:208](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/l1-bitcoin-depositor.ts#L208)
