# Class: SolanaAddress

Represents a Solana address.

## Implements

- [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

## Table of contents

### Constructors

- [constructor](SolanaAddress.md#constructor)

### Properties

- [identifierHex](SolanaAddress.md#identifierhex)

### Methods

- [equals](SolanaAddress.md#equals)
- [from](SolanaAddress.md#from)

## Constructors

### constructor

• **new SolanaAddress**(`address`): [`SolanaAddress`](SolanaAddress.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `address` | `string` |

#### Returns

[`SolanaAddress`](SolanaAddress.md)

#### Defined in

[lib/solana/address.ts:10](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/solana/address.ts#L10)

## Properties

### identifierHex

• `Readonly` **identifierHex**: `string`

Identifier as an un-prefixed hex string.

#### Implementation of

[ChainIdentifier](../interfaces/ChainIdentifier.md).[identifierHex](../interfaces/ChainIdentifier.md#identifierhex)

#### Defined in

[lib/solana/address.ts:8](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/solana/address.ts#L8)

## Methods

### equals

▸ **equals**(`otherValue`): `boolean`

Checks if two identifiers are equal.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `otherValue` | [`SolanaAddress`](SolanaAddress.md) | Another identifier |

#### Returns

`boolean`

#### Implementation of

[ChainIdentifier](../interfaces/ChainIdentifier.md).[equals](../interfaces/ChainIdentifier.md#equals)

#### Defined in

[lib/solana/address.ts:26](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/solana/address.ts#L26)

___

### from

▸ **from**(`address`): [`SolanaAddress`](SolanaAddress.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `address` | `string` |

#### Returns

[`SolanaAddress`](SolanaAddress.md)

#### Defined in

[lib/solana/address.ts:22](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/solana/address.ts#L22)
