# Class: StarkNetAddress

Represents a StarkNet address compliant with the ChainIdentifier interface.
StarkNet addresses are field elements (felt252) in the StarkNet prime field.

## Implements

- [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

## Table of contents

### Constructors

- [constructor](StarkNetAddress.md#constructor)

### Properties

- [identifierHex](StarkNetAddress.md#identifierhex)

### Methods

- [equals](StarkNetAddress.md#equals)
- [toBytes32](StarkNetAddress.md#tobytes32)
- [toString](StarkNetAddress.md#tostring)
- [from](StarkNetAddress.md#from)

## Constructors

### constructor

• **new StarkNetAddress**(`address`): [`StarkNetAddress`](StarkNetAddress.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `address` | `string` |

#### Returns

[`StarkNetAddress`](StarkNetAddress.md)

#### Defined in

<<<<<<< HEAD
[src/lib/starknet/address.ts:14](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/address.ts#L14)
=======
[lib/starknet/address.ts:18](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/address.ts#L18)
>>>>>>> 686d5e70 (fix(sdk): harden cross-chain depositor inputs)

## Properties

### identifierHex

• `Readonly` **identifierHex**: `string`

The address as a 64-character hex string (without 0x prefix).
This is always normalized to lowercase and padded to 32 bytes.

#### Implementation of

[ChainIdentifier](../interfaces/ChainIdentifier.md).[identifierHex](../interfaces/ChainIdentifier.md#identifierhex)

#### Defined in

<<<<<<< HEAD
[src/lib/starknet/address.ts:12](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/address.ts#L12)
=======
[lib/starknet/address.ts:16](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/address.ts#L16)
>>>>>>> 686d5e70 (fix(sdk): harden cross-chain depositor inputs)

## Methods

### equals

▸ **equals**(`otherValue`): `boolean`

Checks if this address equals another ChainIdentifier.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `otherValue` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) | The other value to compare with |

#### Returns

`boolean`

true if both are StarkNetAddress instances with the same identifierHex

#### Implementation of

[ChainIdentifier](../interfaces/ChainIdentifier.md).[equals](../interfaces/ChainIdentifier.md#equals)

#### Defined in

<<<<<<< HEAD
[src/lib/starknet/address.ts:50](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/address.ts#L50)
=======
[lib/starknet/address.ts:56](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/address.ts#L56)
>>>>>>> 686d5e70 (fix(sdk): harden cross-chain depositor inputs)

___

### toBytes32

▸ **toBytes32**(): `string`

Converts the address to a bytes32 hex string format.
This is useful for L1 contract interactions that expect bytes32.

#### Returns

`string`

The address as a 0x-prefixed 64-character hex string

#### Defined in

<<<<<<< HEAD
[src/lib/starknet/address.ts:62](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/address.ts#L62)
=======
[lib/starknet/address.ts:68](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/address.ts#L68)
>>>>>>> 686d5e70 (fix(sdk): harden cross-chain depositor inputs)

___

### toString

▸ **toString**(): `string`

Returns the address as a string in the standard StarkNet format.

#### Returns

`string`

The address as a 0x-prefixed hex string

#### Defined in

<<<<<<< HEAD
[src/lib/starknet/address.ts:70](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/address.ts#L70)
=======
[lib/starknet/address.ts:76](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/address.ts#L76)
>>>>>>> 686d5e70 (fix(sdk): harden cross-chain depositor inputs)

___

### from

▸ **from**(`address`): [`StarkNetAddress`](StarkNetAddress.md)

Creates a StarkNetAddress instance from a hex string.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `address` | `string` | The StarkNet address as a hex string (with or without 0x prefix) |

#### Returns

[`StarkNetAddress`](StarkNetAddress.md)

A new StarkNetAddress instance

**`Throws`**

Error if the address format is invalid or exceeds field element size

#### Defined in

<<<<<<< HEAD
[src/lib/starknet/address.ts:41](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/address.ts#L41)
=======
[lib/starknet/address.ts:47](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/address.ts#L47)
>>>>>>> 686d5e70 (fix(sdk): harden cross-chain depositor inputs)
