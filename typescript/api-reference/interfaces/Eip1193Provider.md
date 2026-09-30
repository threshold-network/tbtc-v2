# Interface: Eip1193Provider

Minimal EIP-1193 provider (window.ethereum, WalletConnect, ethers v6
BrowserProvider's underlying provider, any viem transport source).

## Table of contents

### Methods

- [request](Eip1193Provider.md#request)

## Methods

### request

▸ **request**(`args`): `Promise`\<`unknown`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `args` | `Object` |
| `args.method` | `string` |
| `args.params?` | `object` \| `unknown`[] |

#### Returns

`Promise`\<`unknown`\>

#### Defined in

[src/lib/ethereum/evm-connection.ts:18](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/evm-connection.ts#L18)
