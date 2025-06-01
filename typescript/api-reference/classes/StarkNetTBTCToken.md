# Class: StarkNetTBTCToken

Implementation of the L2TBTCToken interface for StarkNet.
Since StarkNet doesn't have L2 contracts, this is an interface-only
implementation that throws errors for unsupported operations.

This class is used to maintain compatibility with the cross-chain
contracts structure. To check tBTC balances on StarkNet, users
should query the StarkNet chain directly.

## Implements

- [`L2TBTCToken`](../interfaces/L2TBTCToken.md)

## Table of contents

### Constructors

- [constructor](StarkNetTBTCToken.md#constructor)

### Methods

- [balanceOf](StarkNetTBTCToken.md#balanceof)
- [getChainIdentifier](StarkNetTBTCToken.md#getchainidentifier)

## Constructors

### constructor

• **new StarkNetTBTCToken**(): [`StarkNetTBTCToken`](StarkNetTBTCToken.md)

#### Returns

[`StarkNetTBTCToken`](StarkNetTBTCToken.md)

## Methods

### balanceOf

▸ **balanceOf**(`identifier`): `Promise`\<`BigNumber`\>

Returns the balance of the given identifier.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `identifier` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) | Must be a StarkNetAddress instance. |

#### Returns

`Promise`\<`BigNumber`\>

**`Throws`**

Always throws since balance queries must be done on StarkNet directly.

#### Implementation of

[L2TBTCToken](../interfaces/L2TBTCToken.md).[balanceOf](../interfaces/L2TBTCToken.md#balanceof)

#### Defined in

[lib/starknet/starknet-tbtc-token.ts:33](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-tbtc-token.ts#L33)

___

### getChainIdentifier

▸ **getChainIdentifier**(): [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

Gets the chain-specific identifier of this contract.

#### Returns

[`ChainIdentifier`](../interfaces/ChainIdentifier.md)

**`Throws`**

Always throws since StarkNet doesn't have an L2 contract.

#### Implementation of

[L2TBTCToken](../interfaces/L2TBTCToken.md).[getChainIdentifier](../interfaces/L2TBTCToken.md#getchainidentifier)

#### Defined in

[lib/starknet/starknet-tbtc-token.ts:20](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-tbtc-token.ts#L20)
