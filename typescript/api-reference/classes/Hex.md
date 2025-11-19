# Class: Hex

Represents a hexadecimal value.

## Hierarchy

- **`Hex`**

  ↳ [`BitcoinTxHash`](BitcoinTxHash.md)

## Table of contents

### Constructors

- [constructor](Hex.md#constructor)

### Properties

- [\_hex](Hex.md#_hex)

### Methods

- [equals](Hex.md#equals)
- [reverse](Hex.md#reverse)
- [toBuffer](Hex.md#tobuffer)
- [toPrefixedString](Hex.md#toprefixedstring)
- [toString](Hex.md#tostring)
- [from](Hex.md#from)

## Constructors

### constructor

• **new Hex**(`value`): [`Hex`](Hex.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `value` | `string` \| `Buffer`\<`ArrayBufferLike`\> |

#### Returns

[`Hex`](Hex.md)

#### Defined in

[lib/utils/hex.ts:7](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/hex.ts#L7)

## Properties

### \_hex

• `Protected` `Readonly` **\_hex**: `Buffer`\<`ArrayBufferLike`\>

#### Defined in

[lib/utils/hex.ts:5](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/hex.ts#L5)

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

#### Defined in

[lib/utils/hex.ts:57](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/hex.ts#L57)

___

### reverse

▸ **reverse**(): [`Hex`](Hex.md)

#### Returns

[`Hex`](Hex.md)

Reversed hexadecimal value.

#### Defined in

[lib/utils/hex.ts:64](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/hex.ts#L64)

___

### toBuffer

▸ **toBuffer**(): `Buffer`\<`ArrayBufferLike`\>

#### Returns

`Buffer`\<`ArrayBufferLike`\>

Hexadecimal value as a Buffer.

#### Defined in

[lib/utils/hex.ts:32](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/hex.ts#L32)

___

### toPrefixedString

▸ **toPrefixedString**(): `string`

#### Returns

`string`

Hexadecimal string prefixed with '0x'.

#### Defined in

[lib/utils/hex.ts:46](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/hex.ts#L46)

___

### toString

▸ **toString**(): `string`

#### Returns

`string`

Unprefixed hexadecimal string.

#### Defined in

[lib/utils/hex.ts:39](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/hex.ts#L39)

___

### from

▸ **from**(`value`): [`Hex`](Hex.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `value` | `string` \| `Buffer`\<`ArrayBufferLike`\> |

#### Returns

[`Hex`](Hex.md)

#### Defined in

[lib/utils/hex.ts:25](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/hex.ts#L25)
