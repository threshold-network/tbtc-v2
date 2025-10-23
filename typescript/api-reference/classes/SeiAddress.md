# Class: SeiAddress

Represents a Sei address. Since Sei is EVM-compatible, addresses follow
the Ethereum address format (20 bytes, 0x-prefixed).

## Implements

- [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

## Table of contents

### Constructors

- [constructor](SeiAddress.md#constructor)

### Properties

- [identifierHex](SeiAddress.md#identifierhex)

### Methods

- [equals](SeiAddress.md#equals)
- [toString](SeiAddress.md#tostring)
- [from](SeiAddress.md#from)

## Constructors

### constructor

• **new SeiAddress**(`address`): [`SeiAddress`](SeiAddress.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `address` | `string` |

#### Returns

[`SeiAddress`](SeiAddress.md)

#### Defined in

[lib/sei/address.ts:15](https://github.com/threshold-network/tbtc-v2/blob/ntt-typescript/typescript/src/lib/sei/address.ts#L15)

## Properties

### identifierHex

• `Readonly` **identifierHex**: `string`

The address as a hex string (without 0x prefix).
This is normalized to lowercase and represents the 20-byte EVM address.

#### Implementation of

[ChainIdentifier](../interfaces/ChainIdentifier.md).[identifierHex](../interfaces/ChainIdentifier.md#identifierhex)

#### Defined in

[lib/sei/address.ts:13](https://github.com/threshold-network/tbtc-v2/blob/ntt-typescript/typescript/src/lib/sei/address.ts#L13)

## Methods

### equals

▸ **equals**(`otherValue`): `boolean`

Compares this address with another chain identifier.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `otherValue` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) | The other identifier to compare with |

#### Returns

`boolean`

True if addresses are equal, false otherwise

#### Implementation of

[ChainIdentifier](../interfaces/ChainIdentifier.md).[equals](../interfaces/ChainIdentifier.md#equals)

#### Defined in

[lib/sei/address.ts:54](https://github.com/threshold-network/tbtc-v2/blob/ntt-typescript/typescript/src/lib/sei/address.ts#L54)

___

### toString

▸ **toString**(): `string`

Returns the string representation of the address.

#### Returns

`string`

The Sei address as a 0x-prefixed string

#### Defined in

[lib/sei/address.ts:45](https://github.com/threshold-network/tbtc-v2/blob/ntt-typescript/typescript/src/lib/sei/address.ts#L45)

___

### from

▸ **from**(`address`): [`SeiAddress`](SeiAddress.md)

Creates a SeiAddress from a string or Hex.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `address` | `string` \| [`Hex`](Hex.md) | The address as string or Hex |

#### Returns

[`SeiAddress`](SeiAddress.md)

A new SeiAddress instance

#### Defined in

[lib/sei/address.ts:35](https://github.com/threshold-network/tbtc-v2/blob/ntt-typescript/typescript/src/lib/sei/address.ts#L35)
