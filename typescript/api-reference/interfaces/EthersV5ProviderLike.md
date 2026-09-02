# Interface: EthersV5ProviderLike

Structural (duck-typed) ethers v5 Provider. ethers v5 brands every Provider
with `_isProvider`. The SDK does not depend on ethers — this type exists so
that ethers v5 users can keep passing their providers without a cast.

**`Deprecated`**

The ethers v5 compatibility shim is deprecated at birth and will
            be removed in the next major version. Pass a viem client or a
            raw EIP-1193 provider instead.

## Table of contents

### Properties

- [\_isProvider](EthersV5ProviderLike.md#_isprovider)

### Methods

- [call](EthersV5ProviderLike.md#call)
- [getBlock](EthersV5ProviderLike.md#getblock)
- [getBlockNumber](EthersV5ProviderLike.md#getblocknumber)
- [getLogs](EthersV5ProviderLike.md#getlogs)
- [getNetwork](EthersV5ProviderLike.md#getnetwork)
- [getTransactionReceipt](EthersV5ProviderLike.md#gettransactionreceipt)
- [send](EthersV5ProviderLike.md#send)

## Properties

### \_isProvider

• `Readonly` **\_isProvider**: `boolean`

#### Defined in

[src/lib/ethereum/evm-connection.ts:60](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/evm-connection.ts#L60)

## Methods

### call

▸ **call**(`tx`, `blockTag?`): `Promise`\<`string`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `tx` | `Object` |
| `tx.data?` | `string` |
| `tx.to?` | `string` |
| `blockTag?` | `unknown` |

#### Returns

`Promise`\<`string`\>

#### Defined in

[src/lib/ethereum/evm-connection.ts:62](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/evm-connection.ts#L62)

___

### getBlock

▸ **getBlock**(`blockTag`): `Promise`\<``null`` \| \{ `hash`: `string` ; `number`: `number` ; `timestamp`: `number`  }\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `blockTag` | `unknown` |

#### Returns

`Promise`\<``null`` \| \{ `hash`: `string` ; `number`: `number` ; `timestamp`: `number`  }\>

#### Defined in

[src/lib/ethereum/evm-connection.ts:65](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/evm-connection.ts#L65)

___

### getBlockNumber

▸ **getBlockNumber**(): `Promise`\<`number`\>

#### Returns

`Promise`\<`number`\>

#### Defined in

[src/lib/ethereum/evm-connection.ts:64](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/evm-connection.ts#L64)

___

### getLogs

▸ **getLogs**(`filter`): `Promise`\<`unknown`[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `filter` | `unknown` |

#### Returns

`Promise`\<`unknown`[]\>

#### Defined in

[src/lib/ethereum/evm-connection.ts:63](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/evm-connection.ts#L63)

___

### getNetwork

▸ **getNetwork**(): `Promise`\<\{ `chainId`: `number`  }\>

#### Returns

`Promise`\<\{ `chainId`: `number`  }\>

#### Defined in

[src/lib/ethereum/evm-connection.ts:61](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/evm-connection.ts#L61)

___

### getTransactionReceipt

▸ **getTransactionReceipt**(`hash`): `Promise`\<`unknown`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `hash` | `string` |

#### Returns

`Promise`\<`unknown`\>

#### Defined in

[src/lib/ethereum/evm-connection.ts:68](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/evm-connection.ts#L68)

___

### send

▸ **send**(`method`, `params`): `Promise`\<`unknown`\>

Present on JsonRpcProvider/Web3Provider — when available raw RPC requests
are delegated to it.

#### Parameters

| Name | Type |
| :------ | :------ |
| `method` | `string` |
| `params` | `unknown`[] |

#### Returns

`Promise`\<`unknown`\>

#### Defined in

[src/lib/ethereum/evm-connection.ts:73](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/evm-connection.ts#L73)
