# Interface: EthersV5SignerLike

Structural (duck-typed) ethers v5 Signer. ethers v5 brands every Signer with
`_isSigner`. The SDK does not depend on ethers — this type exists so that
ethers v5 users can keep passing their signers without a cast.

**`Deprecated`**

The ethers v5 compatibility shim is deprecated at birth and will
            be removed in the next major version. Pass a viem client or a
            raw EIP-1193 provider instead.

## Table of contents

### Properties

- [\_isSigner](EthersV5SignerLike.md#_issigner)
- [provider](EthersV5SignerLike.md#provider)

### Methods

- [call](EthersV5SignerLike.md#call)
- [getAddress](EthersV5SignerLike.md#getaddress)
- [getChainId](EthersV5SignerLike.md#getchainid)
- [sendTransaction](EthersV5SignerLike.md#sendtransaction)

## Properties

### \_isSigner

• `Readonly` **\_isSigner**: `boolean`

#### Defined in

[src/lib/ethereum/evm-connection.ts:33](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/evm-connection.ts#L33)

___

### provider

• `Optional` **provider**: [`EthersV5ProviderLike`](EthersV5ProviderLike.md)

#### Defined in

[src/lib/ethereum/evm-connection.ts:48](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/evm-connection.ts#L48)

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

[src/lib/ethereum/evm-connection.ts:47](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/evm-connection.ts#L47)

___

### getAddress

▸ **getAddress**(): `Promise`\<`string`\>

#### Returns

`Promise`\<`string`\>

#### Defined in

[src/lib/ethereum/evm-connection.ts:34](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/evm-connection.ts#L34)

___

### getChainId

▸ **getChainId**(): `Promise`\<`number`\>

#### Returns

`Promise`\<`number`\>

#### Defined in

[src/lib/ethereum/evm-connection.ts:35](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/evm-connection.ts#L35)

___

### sendTransaction

▸ **sendTransaction**(`tx`): `Promise`\<\{ `hash`: `string`  }\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `tx` | `Object` |
| `tx.data?` | `unknown` |
| `tx.gasLimit?` | `unknown` |
| `tx.to?` | `unknown` |
| `tx.value?` | `unknown` |

#### Returns

`Promise`\<\{ `hash`: `string`  }\>

#### Defined in

[src/lib/ethereum/evm-connection.ts:41](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/evm-connection.ts#L41)
