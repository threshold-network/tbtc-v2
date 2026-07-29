# Class: DepositScript

Represents a Bitcoin script corresponding to a tBTC v2 deposit.
On a high-level, the script is used to derive the Bitcoin address that is
used to fund the deposit with BTC. On a low-level, the script is used to
produce a properly locked funding transaction output that can be unlocked
by the target wallet during the deposit sweep process.

## Table of contents

### Constructors

- [constructor](DepositScript.md#constructor)

### Properties

- [receipt](DepositScript.md#receipt)
- [scriptType](DepositScript.md#scripttype)
- [witness](DepositScript.md#witness)

### Methods

- [deriveAddress](DepositScript.md#deriveaddress)
- [deriveOutputScript](DepositScript.md#deriveoutputscript)
- [getHash](DepositScript.md#gethash)
- [getPlainText](DepositScript.md#getplaintext)
- [getTaprootLeafHash](DepositScript.md#gettaprootleafhash)
- [getTaprootMerkleRoot](DepositScript.md#gettaprootmerkleroot)
- [getTaprootOutputKey](DepositScript.md#gettaprootoutputkey)
- [getTaprootRefundScript](DepositScript.md#gettaprootrefundscript)
- [fromReceipt](DepositScript.md#fromreceipt)

## Constructors

### constructor

• **new DepositScript**(`receipt`, `scriptType`): [`DepositScript`](DepositScript.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `receipt` | [`DepositReceipt`](../interfaces/DepositReceipt.md) |
| `scriptType` | [`DepositScriptType`](../README.md#depositscripttype) |

#### Returns

[`DepositScript`](DepositScript.md)

#### Defined in

[src/services/deposits/deposit.ts:226](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L226)

## Properties

### receipt

• `Readonly` **receipt**: [`DepositReceipt`](../interfaces/DepositReceipt.md)

Deposit receipt holding the most important information about the deposit
and allowing to build a unique deposit script (and address) on Bitcoin chain.

#### Defined in

[src/services/deposits/deposit.ts:215](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L215)

___

### scriptType

• `Readonly` **scriptType**: [`DepositScriptType`](../README.md#depositscripttype)

Deposit script/address type.

#### Defined in

[src/services/deposits/deposit.ts:224](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L224)

___

### witness

• `Readonly` **witness**: `boolean`

Flag indicating whether the generated Bitcoin deposit script (and address)
should be a witness P2WSH one. If false, legacy P2SH will be used instead.

#### Defined in

[src/services/deposits/deposit.ts:220](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L220)

## Methods

### deriveAddress

▸ **deriveAddress**(`bitcoinNetwork`): `Promise`\<`string`\>

Derives a Bitcoin address for the given network for this deposit script.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `bitcoinNetwork` | [`BitcoinNetwork`](../enums/BitcoinNetwork-1.md) | Bitcoin network the address should be derived for. |

#### Returns

`Promise`\<`string`\>

Bitcoin address corresponding to this deposit script.

#### Defined in

[src/services/deposits/deposit.ts:375](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L375)

___

### deriveOutputScript

▸ **deriveOutputScript**(`bitcoinNetwork`): `Promise`\<`Buffer`\<`ArrayBufferLike`\>\>

Derives a Bitcoin output script for the given network for this deposit
script.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `bitcoinNetwork` | [`BitcoinNetwork`](../enums/BitcoinNetwork-1.md) | Bitcoin network the output script should be derived for. |

#### Returns

`Promise`\<`Buffer`\<`ArrayBufferLike`\>\>

Output script not prepended with length.

#### Defined in

[src/services/deposits/deposit.ts:418](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L418)

___

### getHash

▸ **getHash**(): `Promise`\<`Buffer`\<`ArrayBufferLike`\>\>

#### Returns

`Promise`\<`Buffer`\<`ArrayBufferLike`\>\>

Hashed deposit script as Buffer.

#### Defined in

[src/services/deposits/deposit.ts:255](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L255)

___

### getPlainText

▸ **getPlainText**(): `Promise`\<[`Hex`](Hex.md)\>

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

Plain-text deposit script as a hex string.

#### Defined in

[src/services/deposits/deposit.ts:271](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L271)

___

### getTaprootLeafHash

▸ **getTaprootLeafHash**(): `Promise`\<[`Hex`](Hex.md)\>

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

TapLeaf hash of the Taproot refund script.

#### Defined in

[src/services/deposits/deposit.ts:344](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L344)

___

### getTaprootMerkleRoot

▸ **getTaprootMerkleRoot**(): `Promise`\<[`Hex`](Hex.md)\>

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

Taproot merkle root for this deposit's script tree.

#### Defined in

[src/services/deposits/deposit.ts:351](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L351)

___

### getTaprootOutputKey

▸ **getTaprootOutputKey**(): `Promise`\<[`Hex`](Hex.md)\>

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

X-only Taproot output key committing to the refund script.

#### Defined in

[src/services/deposits/deposit.ts:358](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L358)

___

### getTaprootRefundScript

▸ **getTaprootRefundScript**(): `Promise`\<[`Hex`](Hex.md)\>

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

Tapscript refund leaf for a Taproot-native deposit.

#### Defined in

[src/services/deposits/deposit.ts:313](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L313)

___

### fromReceipt

▸ **fromReceipt**(`receipt`, `options?`): [`DepositScript`](DepositScript.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `receipt` | [`DepositReceipt`](../interfaces/DepositReceipt.md) |
| `options` | [`DepositScriptOptions`](../README.md#depositscriptoptions) |

#### Returns

[`DepositScript`](DepositScript.md)

#### Defined in

[src/services/deposits/deposit.ts:245](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L245)
