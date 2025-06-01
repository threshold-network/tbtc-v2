# Interface: L2TBTCToken

Interface for communication with the on-chain contract of the given
canonical L2 tBTC token.

## Implemented by

- [`ArbitrumL2TBTCToken`](../classes/ArbitrumL2TBTCToken.md)
- [`BaseL2TBTCToken`](../classes/BaseL2TBTCToken.md)
- [`StarkNetTBTCToken`](../classes/StarkNetTBTCToken.md)

## Table of contents

### Methods

- [balanceOf](L2TBTCToken.md#balanceof)
- [getChainIdentifier](L2TBTCToken.md#getchainidentifier)

## Methods

### balanceOf

▸ **balanceOf**(`identifier`): `Promise`\<`BigNumber`\>

Returns the balance of the given identifier.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `identifier` | [`ChainIdentifier`](ChainIdentifier.md) | Identifier of the account to get the balance for. |

#### Returns

`Promise`\<`BigNumber`\>

The balance of the given identifier in 1e18 precision.

#### Defined in

[lib/contracts/cross-chain.ts:61](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L61)

___

### getChainIdentifier

▸ **getChainIdentifier**(): [`ChainIdentifier`](ChainIdentifier.md)

Gets the chain-specific identifier of this contract.

#### Returns

[`ChainIdentifier`](ChainIdentifier.md)

#### Defined in

[lib/contracts/cross-chain.ts:54](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L54)
