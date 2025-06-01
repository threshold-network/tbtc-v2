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
- [witness](DepositScript.md#witness)

### Methods

- [deriveAddress](DepositScript.md#deriveaddress)
- [getHash](DepositScript.md#gethash)
- [getPlainText](DepositScript.md#getplaintext)
- [fromReceipt](DepositScript.md#fromreceipt)

## Constructors

### constructor

• **new DepositScript**(`receipt`, `witness`): [`DepositScript`](DepositScript.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `receipt` | [`DepositReceipt`](../interfaces/DepositReceipt.md) |
| `witness` | `boolean` |

#### Returns

[`DepositScript`](DepositScript.md)

#### Defined in

[services/deposits/deposit.ts:189](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L189)

## Properties

### receipt

• `Readonly` **receipt**: [`DepositReceipt`](../interfaces/DepositReceipt.md)

Deposit receipt holding the most important information about the deposit
and allowing to build a unique deposit script (and address) on Bitcoin chain.

#### Defined in

[services/deposits/deposit.ts:182](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L182)

___

### witness

• `Readonly` **witness**: `boolean`

Flag indicating whether the generated Bitcoin deposit script (and address)
should be a witness P2WSH one. If false, legacy P2SH will be used instead.

#### Defined in

[services/deposits/deposit.ts:187](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L187)

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

[services/deposits/deposit.ts:258](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L258)

___

### getHash

▸ **getHash**(): `Promise`\<`Buffer`\>

#### Returns

`Promise`\<`Buffer`\>

Hashed deposit script as Buffer.

#### Defined in

[services/deposits/deposit.ts:206](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L206)

___

### getPlainText

▸ **getPlainText**(): `Promise`\<[`Hex`](Hex.md)\>

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

Plain-text deposit script as a hex string.

#### Defined in

[services/deposits/deposit.ts:218](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L218)

___

### fromReceipt

▸ **fromReceipt**(`receipt`, `witness?`): [`DepositScript`](DepositScript.md)

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `receipt` | [`DepositReceipt`](../interfaces/DepositReceipt.md) | `undefined` |
| `witness` | `boolean` | `true` |

#### Returns

[`DepositScript`](DepositScript.md)

#### Defined in

[services/deposits/deposit.ts:196](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L196)
