# Class: StarkNetTBTCToken

Implementation of the DestinationChainTBTCToken interface for StarkNet.
This implementation now supports balance queries using deployed
tBTC contracts on StarkNet.

## Implements

- [`DestinationChainTBTCToken`](../interfaces/DestinationChainTBTCToken.md)

## Table of contents

### Constructors

- [constructor](StarkNetTBTCToken.md#constructor)

### Properties

- [config](StarkNetTBTCToken.md#config)
- [contract](StarkNetTBTCToken.md#contract)
- [provider](StarkNetTBTCToken.md#provider)

### Methods

- [balanceOf](StarkNetTBTCToken.md#balanceof)
- [getBalance](StarkNetTBTCToken.md#getbalance)
- [getChainIdentifier](StarkNetTBTCToken.md#getchainidentifier)
- [getConfig](StarkNetTBTCToken.md#getconfig)
- [totalSupply](StarkNetTBTCToken.md#totalsupply)

## Constructors

### constructor

• **new StarkNetTBTCToken**(`config`, `provider`): [`StarkNetTBTCToken`](StarkNetTBTCToken.md)

Creates a new StarkNetTBTCToken instance.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `config` | [`StarkNetTBTCTokenConfig`](../interfaces/StarkNetTBTCTokenConfig.md) | Configuration containing chainId and token contract address |
| `provider` | [`StarkNetProvider`](../README.md#starknetprovider) | StarkNet provider for blockchain interaction |

#### Returns

[`StarkNetTBTCToken`](StarkNetTBTCToken.md)

**`Throws`**

Error if provider is not provided or config is invalid

#### Defined in

[lib/starknet/starknet-tbtc-token.ts:32](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-tbtc-token.ts#L32)

## Properties

### config

• `Private` `Readonly` **config**: [`StarkNetTBTCTokenConfig`](../interfaces/StarkNetTBTCTokenConfig.md)

#### Defined in

[lib/starknet/starknet-tbtc-token.ts:22](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-tbtc-token.ts#L22)

___

### contract

• `Private` `Readonly` **contract**: `Contract`

#### Defined in

[lib/starknet/starknet-tbtc-token.ts:24](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-tbtc-token.ts#L24)

___

### provider

• `Private` `Readonly` **provider**: [`StarkNetProvider`](../README.md#starknetprovider)

#### Defined in

[lib/starknet/starknet-tbtc-token.ts:23](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-tbtc-token.ts#L23)

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

The balance as a BigNumber

#### Implementation of

[DestinationChainTBTCToken](../interfaces/DestinationChainTBTCToken.md).[balanceOf](../interfaces/DestinationChainTBTCToken.md#balanceof)

#### Defined in

[lib/starknet/starknet-tbtc-token.ts:63](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-tbtc-token.ts#L63)

___

### getBalance

▸ **getBalance**(`identifier`): `Promise`\<`BigNumber`\>

Gets the balance for a StarkNet address.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `identifier` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) | Must be a StarkNetAddress instance |

#### Returns

`Promise`\<`BigNumber`\>

The balance as a BigNumber

**`Throws`**

Error if address is not a StarkNetAddress

#### Defined in

[lib/starknet/starknet-tbtc-token.ts:76](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-tbtc-token.ts#L76)

___

### getChainIdentifier

▸ **getChainIdentifier**(): [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

Gets the chain-specific identifier of this contract.

#### Returns

[`ChainIdentifier`](../interfaces/ChainIdentifier.md)

**`Throws`**

Always throws since StarkNet doesn't have an L2 contract identifier.

#### Implementation of

[DestinationChainTBTCToken](../interfaces/DestinationChainTBTCToken.md).[getChainIdentifier](../interfaces/DestinationChainTBTCToken.md#getchainidentifier)

#### Defined in

[lib/starknet/starknet-tbtc-token.ts:51](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-tbtc-token.ts#L51)

___

### getConfig

▸ **getConfig**(): [`StarkNetTBTCTokenConfig`](../interfaces/StarkNetTBTCTokenConfig.md)

Returns the configuration for this token instance.

#### Returns

[`StarkNetTBTCTokenConfig`](../interfaces/StarkNetTBTCTokenConfig.md)

The configuration object

#### Defined in

[lib/starknet/starknet-tbtc-token.ts:102](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-tbtc-token.ts#L102)

___

### totalSupply

▸ **totalSupply**(`_identifier`): `Promise`\<`BigNumber`\>

Returns the total supply of the token.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `_identifier` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) | Not used for total supply query |

#### Returns

`Promise`\<`BigNumber`\>

The total supply as a BigNumber

**`Throws`**

Not implemented yet

#### Defined in

[lib/starknet/starknet-tbtc-token.ts:112](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-tbtc-token.ts#L112)
