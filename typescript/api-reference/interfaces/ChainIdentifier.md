# Interface: ChainIdentifier

Represents a generic chain identifier.

## Implemented by

- [`EthereumAddress`](../classes/EthereumAddress.md)
- [`SolanaAddress`](../classes/SolanaAddress.md)
- [`StarkNetAddress`](../classes/StarkNetAddress.md)

## Table of contents

### Properties

- [identifierHex](ChainIdentifier.md#identifierhex)

### Methods

- [equals](ChainIdentifier.md#equals)

## Properties

### identifierHex

• **identifierHex**: `string`

Identifier as an un-prefixed hex string.

#### Defined in

[lib/contracts/chain-identifier.ts:8](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/chain-identifier.ts#L8)

## Methods

### equals

▸ **equals**(`identifier`): `boolean`

Checks if two identifiers are equal.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `identifier` | [`ChainIdentifier`](ChainIdentifier.md) | Another identifier |

#### Returns

`boolean`

#### Defined in

[lib/contracts/chain-identifier.ts:14](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/chain-identifier.ts#L14)
