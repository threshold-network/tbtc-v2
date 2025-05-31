# Class: BitcoinTxHash

Represents a Bitcoin transaction hash (or transaction ID) as an un-prefixed hex
string. This hash is supposed to have the same byte order as used by the
Bitcoin block explorers which is the opposite of the byte order used
by the Bitcoin protocol internally. That means the hash must be reversed in
the use cases that expect the Bitcoin internal byte order.

## Hierarchy

- [`Hex`](Hex.md)

  ↳ **`BitcoinTxHash`**

## Table of contents

### Constructors

- [constructor](BitcoinTxHash.md#constructor)

### Properties

- [\_hex](BitcoinTxHash.md#_hex)

### Methods

- [equals](BitcoinTxHash.md#equals)
- [reverse](BitcoinTxHash.md#reverse)
- [toBuffer](BitcoinTxHash.md#tobuffer)
- [toPrefixedString](BitcoinTxHash.md#toprefixedstring)
- [toString](BitcoinTxHash.md#tostring)
- [from](BitcoinTxHash.md#from)

## Constructors

### constructor

• **new BitcoinTxHash**(`value`): [`BitcoinTxHash`](BitcoinTxHash.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `value` | `string` \| `Buffer`\<`ArrayBufferLike`\> |

#### Returns

[`BitcoinTxHash`](BitcoinTxHash.md)

#### Inherited from

[Hex](Hex.md).[constructor](Hex.md#constructor)

#### Defined in

[lib/utils/hex.ts:7](https://github.com/keep-network/tbtc-v2/blob/main/typescript/src/lib/utils/hex.ts#L7)

## Properties

### \_hex

• `Protected` `Readonly` **\_hex**: `Buffer`\<`ArrayBufferLike`\>

#### Inherited from

[Hex](Hex.md).[_hex](Hex.md#_hex)

#### Defined in

[lib/utils/hex.ts:5](https://github.com/keep-network/tbtc-v2/blob/main/typescript/src/lib/utils/hex.ts#L5)

## Methods

### equals

▸ **equals**(`otherValue`): `boolean`

Checks if other value equals the current value.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `otherValue` | [`Hex`](Hex.md) | Other value that will be compared to this value. |

#### Returns

`boolean`

True if both values are equal, false otherwise.

#### Inherited from

[Hex](Hex.md).[equals](Hex.md#equals)

#### Defined in

[lib/utils/hex.ts:57](https://github.com/keep-network/tbtc-v2/blob/main/typescript/src/lib/utils/hex.ts#L57)

___

### reverse

▸ **reverse**(): [`Hex`](Hex.md)

#### Returns

[`Hex`](Hex.md)

Reversed hexadecimal value.

#### Inherited from

[Hex](Hex.md).[reverse](Hex.md#reverse)

#### Defined in

[lib/utils/hex.ts:64](https://github.com/keep-network/tbtc-v2/blob/main/typescript/src/lib/utils/hex.ts#L64)

___

### toBuffer

▸ **toBuffer**(): `Buffer`\<`ArrayBufferLike`\>

#### Returns

`Buffer`\<`ArrayBufferLike`\>

Hexadecimal value as a Buffer.

#### Inherited from

[Hex](Hex.md).[toBuffer](Hex.md#tobuffer)

#### Defined in

[lib/utils/hex.ts:32](https://github.com/keep-network/tbtc-v2/blob/main/typescript/src/lib/utils/hex.ts#L32)

___

### toPrefixedString

▸ **toPrefixedString**(): `string`

#### Returns

`string`

Hexadecimal string prefixed with '0x'.

#### Inherited from

[Hex](Hex.md).[toPrefixedString](Hex.md#toprefixedstring)

#### Defined in

[lib/utils/hex.ts:46](https://github.com/keep-network/tbtc-v2/blob/main/typescript/src/lib/utils/hex.ts#L46)

___

### toString

▸ **toString**(): `string`

#### Returns

`string`

Unprefixed hexadecimal string.

#### Inherited from

[Hex](Hex.md).[toString](Hex.md#tostring)

#### Defined in

[lib/utils/hex.ts:39](https://github.com/keep-network/tbtc-v2/blob/main/typescript/src/lib/utils/hex.ts#L39)

___

### from

▸ **from**(`value`): [`Hex`](Hex.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `value` | `string` \| `Buffer`\<`ArrayBufferLike`\> |

#### Returns

[`Hex`](Hex.md)

#### Inherited from

[Hex](Hex.md).[from](Hex.md#from)

#### Defined in

[lib/utils/hex.ts:25](https://github.com/keep-network/tbtc-v2/blob/main/typescript/src/lib/utils/hex.ts#L25)
