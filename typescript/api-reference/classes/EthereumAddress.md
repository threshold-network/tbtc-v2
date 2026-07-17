# Class: EthereumAddress

Represents an Ethereum address.

## Implements

- [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

## Table of contents

### Constructors

- [constructor](EthereumAddress.md#constructor)

### Properties

- [identifierHex](EthereumAddress.md#identifierhex)

### Methods

- [equals](EthereumAddress.md#equals)
- [from](EthereumAddress.md#from)

## Constructors

### constructor

• **new EthereumAddress**(`address`): [`EthereumAddress`](EthereumAddress.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `address` | `string` |

#### Returns

[`EthereumAddress`](EthereumAddress.md)

#### Defined in

[lib/ethereum/address.ts:12](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/address.ts#L12)

## Properties

### identifierHex

• `Readonly` **identifierHex**: `string`

Identifier as an un-prefixed hex string.

#### Implementation of

[ChainIdentifier](../interfaces/ChainIdentifier.md).[identifierHex](../interfaces/ChainIdentifier.md#identifierhex)

#### Defined in

[lib/ethereum/address.ts:10](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/address.ts#L10)

## Methods

### equals

▸ **equals**(`otherValue`): `boolean`

Checks if two identifiers are equal.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `otherValue` | [`EthereumAddress`](EthereumAddress.md) | Another identifier |

#### Returns

`boolean`

#### Implementation of

[ChainIdentifier](../interfaces/ChainIdentifier.md).[equals](../interfaces/ChainIdentifier.md#equals)

#### Defined in

[lib/ethereum/address.ts:28](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/address.ts#L28)

___

### from

▸ **from**(`address`): [`EthereumAddress`](EthereumAddress.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `address` | `string` |

#### Returns

[`EthereumAddress`](EthereumAddress.md)

#### Defined in

[lib/ethereum/address.ts:24](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/address.ts#L24)
