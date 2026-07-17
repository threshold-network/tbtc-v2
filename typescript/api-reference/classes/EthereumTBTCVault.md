# Class: EthereumTBTCVault

Implementation of the Ethereum TBTCVault handle.

**`See`**

for reference.

## Hierarchy

- `EthersContractHandle`\<`TBTCVaultTypechain`\>

  ↳ **`EthereumTBTCVault`**

## Implements

- [`TBTCVault`](../interfaces/TBTCVault.md)

## Table of contents

### Constructors

- [constructor](EthereumTBTCVault.md#constructor)

### Properties

- [\_deployedAtBlockNumber](EthereumTBTCVault.md#_deployedatblocknumber)
- [\_instance](EthereumTBTCVault.md#_instance)
- [\_totalRetryAttempts](EthereumTBTCVault.md#_totalretryattempts)

### Methods

- [cancelOptimisticMint](EthereumTBTCVault.md#canceloptimisticmint)
- [finalizeOptimisticMint](EthereumTBTCVault.md#finalizeoptimisticmint)
- [getAddress](EthereumTBTCVault.md#getaddress)
- [getChainIdentifier](EthereumTBTCVault.md#getchainidentifier)
- [getEvents](EthereumTBTCVault.md#getevents)
- [getMinters](EthereumTBTCVault.md#getminters)
- [getOptimisticMintingCancelledEvents](EthereumTBTCVault.md#getoptimisticmintingcancelledevents)
- [getOptimisticMintingFinalizedEvents](EthereumTBTCVault.md#getoptimisticmintingfinalizedevents)
- [getOptimisticMintingRequestedEvents](EthereumTBTCVault.md#getoptimisticmintingrequestedevents)
- [isGuardian](EthereumTBTCVault.md#isguardian)
- [isMinter](EthereumTBTCVault.md#isminter)
- [optimisticMintingDelay](EthereumTBTCVault.md#optimisticmintingdelay)
- [optimisticMintingRequests](EthereumTBTCVault.md#optimisticmintingrequests)
- [parseOptimisticMintingRequest](EthereumTBTCVault.md#parseoptimisticmintingrequest)
- [requestOptimisticMint](EthereumTBTCVault.md#requestoptimisticmint)

## Constructors

### constructor

• **new EthereumTBTCVault**(`config`, `chainId?`): [`EthereumTBTCVault`](EthereumTBTCVault.md)

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `config` | [`EthereumContractConfig`](../interfaces/EthereumContractConfig.md) | `undefined` |
| `chainId` | [`Ethereum`](../enums/Chains.Ethereum.md) | `Chains.Ethereum.Local` |

#### Returns

[`EthereumTBTCVault`](EthereumTBTCVault.md)

#### Overrides

EthersContractHandle\&lt;TBTCVaultTypechain\&gt;.constructor

#### Defined in

[src/lib/ethereum/tbtc-vault.ts:42](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L42)

## Properties

### \_deployedAtBlockNumber

• `Protected` `Readonly` **\_deployedAtBlockNumber**: `number`

Number of a block within which the contract was deployed. Value is read from
the contract deployment artifact. It can be overwritten by setting a
[EthersContractConfig.deployedAtBlockNumber](../interfaces/EthereumContractConfig.md#deployedatblocknumber) property.

#### Inherited from

EthersContractHandle.\_deployedAtBlockNumber

#### Defined in

[src/lib/ethereum/adapter.ts:78](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L78)

___

### \_instance

• `Protected` `Readonly` **\_instance**: `TBTCVault`

Ethers instance of the deployed contract.

#### Inherited from

EthersContractHandle.\_instance

#### Defined in

[src/lib/ethereum/adapter.ts:72](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L72)

___

### \_totalRetryAttempts

• `Protected` `Readonly` **\_totalRetryAttempts**: `number`

Number of retries for ethereum requests.

#### Inherited from

EthersContractHandle.\_totalRetryAttempts

#### Defined in

[src/lib/ethereum/adapter.ts:82](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L82)

## Methods

### cancelOptimisticMint

▸ **cancelOptimisticMint**(`depositTxHash`, `depositOutputIndex`): `Promise`\<[`Hex`](Hex.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `depositTxHash` | [`BitcoinTxHash`](BitcoinTxHash.md) |
| `depositOutputIndex` | `number` |

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

**`See`**

#### Implementation of

[TBTCVault](../interfaces/TBTCVault.md).[cancelOptimisticMint](../interfaces/TBTCVault.md#canceloptimisticmint)

#### Defined in

[src/lib/ethereum/tbtc-vault.ts:151](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L151)

___

### finalizeOptimisticMint

▸ **finalizeOptimisticMint**(`depositTxHash`, `depositOutputIndex`): `Promise`\<[`Hex`](Hex.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `depositTxHash` | [`BitcoinTxHash`](BitcoinTxHash.md) |
| `depositOutputIndex` | `number` |

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

**`See`**

#### Implementation of

[TBTCVault](../interfaces/TBTCVault.md).[finalizeOptimisticMint](../interfaces/TBTCVault.md#finalizeoptimisticmint)

#### Defined in

[src/lib/ethereum/tbtc-vault.ts:174](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L174)

___

### getAddress

▸ **getAddress**(): [`EthereumAddress`](EthereumAddress.md)

Get address of the contract instance.

#### Returns

[`EthereumAddress`](EthereumAddress.md)

Address of this contract instance.

#### Inherited from

EthersContractHandle.getAddress

#### Defined in

[src/lib/ethereum/adapter.ts:110](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L110)

___

### getChainIdentifier

▸ **getChainIdentifier**(): [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

#### Returns

[`ChainIdentifier`](../interfaces/ChainIdentifier.md)

**`See`**

#### Implementation of

[TBTCVault](../interfaces/TBTCVault.md).[getChainIdentifier](../interfaces/TBTCVault.md#getchainidentifier)

#### Defined in

[src/lib/ethereum/tbtc-vault.ts:69](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L69)

___

### getEvents

▸ **getEvents**(`eventName`, `options?`, `...filterArgs`): `Promise`\<`Event`[]\>

Get events emitted by the Ethereum contract.
It starts searching from provided block number. If the GetEvents.Options#fromBlock
option is missing it looks for a contract's defined property
[_deployedAtBlockNumber](BaseBitcoinDepositor.md#_deployedatblocknumber). If the property is missing starts searching
from block `0`.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `eventName` | `string` | Name of the event. |
| `options?` | [`Options`](../interfaces/GetChainEvents.Options.md) | Options for events fetching. |
| `...filterArgs` | `unknown`[] | Arguments for events filtering. |

#### Returns

`Promise`\<`Event`[]\>

Array of found events.

#### Inherited from

EthersContractHandle.getEvents

#### Defined in

[src/lib/ethereum/adapter.ts:125](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L125)

___

### getMinters

▸ **getMinters**(): `Promise`\<[`EthereumAddress`](EthereumAddress.md)[]\>

#### Returns

`Promise`\<[`EthereumAddress`](EthereumAddress.md)[]\>

**`See`**

#### Implementation of

[TBTCVault](../interfaces/TBTCVault.md).[getMinters](../interfaces/TBTCVault.md#getminters)

#### Defined in

[src/lib/ethereum/tbtc-vault.ts:91](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L91)

___

### getOptimisticMintingCancelledEvents

▸ **getOptimisticMintingCancelledEvents**(`options?`, `...filterArgs`): `Promise`\<[`OptimisticMintingCancelledEvent`](../README.md#optimisticmintingcancelledevent)[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `options?` | [`Options`](../interfaces/GetChainEvents.Options.md) |
| `...filterArgs` | `any`[] |

#### Returns

`Promise`\<[`OptimisticMintingCancelledEvent`](../README.md#optimisticmintingcancelledevent)[]\>

**`See`**

#### Implementation of

TBTCVault.getOptimisticMintingCancelledEvents

#### Defined in

[src/lib/ethereum/tbtc-vault.ts:269](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L269)

___

### getOptimisticMintingFinalizedEvents

▸ **getOptimisticMintingFinalizedEvents**(`options?`, `...filterArgs`): `Promise`\<[`OptimisticMintingFinalizedEvent`](../README.md#optimisticmintingfinalizedevent)[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `options?` | [`Options`](../interfaces/GetChainEvents.Options.md) |
| `...filterArgs` | `any`[] |

#### Returns

`Promise`\<[`OptimisticMintingFinalizedEvent`](../README.md#optimisticmintingfinalizedevent)[]\>

**`See`**

#### Implementation of

TBTCVault.getOptimisticMintingFinalizedEvents

#### Defined in

[src/lib/ethereum/tbtc-vault.ts:296](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L296)

___

### getOptimisticMintingRequestedEvents

▸ **getOptimisticMintingRequestedEvents**(`options?`, `...filterArgs`): `Promise`\<[`OptimisticMintingRequestedEvent`](../README.md#optimisticmintingrequestedevent)[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `options?` | [`Options`](../interfaces/GetChainEvents.Options.md) |
| `...filterArgs` | `any`[] |

#### Returns

`Promise`\<[`OptimisticMintingRequestedEvent`](../README.md#optimisticmintingrequestedevent)[]\>

**`See`**

#### Implementation of

TBTCVault.getOptimisticMintingRequestedEvents

#### Defined in

[src/lib/ethereum/tbtc-vault.ts:236](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L236)

___

### isGuardian

▸ **isGuardian**(`address`): `Promise`\<`boolean`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `address` | [`EthereumAddress`](EthereumAddress.md) |

#### Returns

`Promise`\<`boolean`\>

**`See`**

#### Implementation of

[TBTCVault](../interfaces/TBTCVault.md).[isGuardian](../interfaces/TBTCVault.md#isguardian)

#### Defined in

[src/lib/ethereum/tbtc-vault.ts:115](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L115)

___

### isMinter

▸ **isMinter**(`address`): `Promise`\<`boolean`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `address` | [`EthereumAddress`](EthereumAddress.md) |

#### Returns

`Promise`\<`boolean`\>

**`See`**

#### Implementation of

[TBTCVault](../interfaces/TBTCVault.md).[isMinter](../interfaces/TBTCVault.md#isminter)

#### Defined in

[src/lib/ethereum/tbtc-vault.ts:105](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L105)

___

### optimisticMintingDelay

▸ **optimisticMintingDelay**(): `Promise`\<`number`\>

#### Returns

`Promise`\<`number`\>

**`See`**

#### Implementation of

[TBTCVault](../interfaces/TBTCVault.md).[optimisticMintingDelay](../interfaces/TBTCVault.md#optimisticmintingdelay)

#### Defined in

[src/lib/ethereum/tbtc-vault.ts:77](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L77)

___

### optimisticMintingRequests

▸ **optimisticMintingRequests**(`depositTxHash`, `depositOutputIndex`): `Promise`\<[`OptimisticMintingRequest`](../README.md#optimisticmintingrequest)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `depositTxHash` | [`BitcoinTxHash`](BitcoinTxHash.md) |
| `depositOutputIndex` | `number` |

#### Returns

`Promise`\<[`OptimisticMintingRequest`](../README.md#optimisticmintingrequest)\>

**`See`**

#### Implementation of

[TBTCVault](../interfaces/TBTCVault.md).[optimisticMintingRequests](../interfaces/TBTCVault.md#optimisticmintingrequests)

#### Defined in

[src/lib/ethereum/tbtc-vault.ts:200](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L200)

___

### parseOptimisticMintingRequest

▸ **parseOptimisticMintingRequest**(`request`): [`OptimisticMintingRequest`](../README.md#optimisticmintingrequest)

Parses a optimistic minting request using data fetched from the on-chain contract.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `request` | `ContractOptimisticMintingRequest` | Data of the optimistic minting request. |

#### Returns

[`OptimisticMintingRequest`](../README.md#optimisticmintingrequest)

Parsed optimistic minting request.

#### Defined in

[src/lib/ethereum/tbtc-vault.ts:223](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L223)

___

### requestOptimisticMint

▸ **requestOptimisticMint**(`depositTxHash`, `depositOutputIndex`): `Promise`\<[`Hex`](Hex.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `depositTxHash` | [`BitcoinTxHash`](BitcoinTxHash.md) |
| `depositOutputIndex` | `number` |

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

**`See`**

#### Implementation of

[TBTCVault](../interfaces/TBTCVault.md).[requestOptimisticMint](../interfaces/TBTCVault.md#requestoptimisticmint)

#### Defined in

[src/lib/ethereum/tbtc-vault.ts:125](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L125)
