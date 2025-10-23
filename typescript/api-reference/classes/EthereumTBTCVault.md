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

[lib/ethereum/tbtc-vault.ts:41](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L41)

## Properties

### \_deployedAtBlockNumber

• `Protected` `Readonly` **\_deployedAtBlockNumber**: `number`

Number of a block within which the contract was deployed. Value is read from
the contract deployment artifact. It can be overwritten by setting a
[EthersContractConfig.deployedAtBlockNumber](../interfaces/EthereumContractConfig.md#deployedatblocknumber) property.

#### Inherited from

EthersContractHandle.\_deployedAtBlockNumber

#### Defined in

[lib/ethereum/adapter.ts:80](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L80)

___

### \_instance

• `Protected` `Readonly` **\_instance**: `TBTCVault`

Ethers instance of the deployed contract.

#### Inherited from

EthersContractHandle.\_instance

#### Defined in

[lib/ethereum/adapter.ts:74](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L74)

___

### \_totalRetryAttempts

• `Protected` `Readonly` **\_totalRetryAttempts**: `number`

Number of retries for ethereum requests.

#### Inherited from

EthersContractHandle.\_totalRetryAttempts

#### Defined in

[lib/ethereum/adapter.ts:84](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L84)

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

[lib/ethereum/tbtc-vault.ts:150](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L150)

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

[lib/ethereum/tbtc-vault.ts:173](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L173)

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

[lib/ethereum/adapter.ts:112](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L112)

___

### getChainIdentifier

▸ **getChainIdentifier**(): [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

#### Returns

[`ChainIdentifier`](../interfaces/ChainIdentifier.md)

**`See`**

#### Implementation of

[TBTCVault](../interfaces/TBTCVault.md).[getChainIdentifier](../interfaces/TBTCVault.md#getchainidentifier)

#### Defined in

[lib/ethereum/tbtc-vault.ts:68](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L68)

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

[lib/ethereum/adapter.ts:127](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L127)

___

### getMinters

▸ **getMinters**(): `Promise`\<[`EthereumAddress`](EthereumAddress.md)[]\>

#### Returns

`Promise`\<[`EthereumAddress`](EthereumAddress.md)[]\>

**`See`**

#### Implementation of

[TBTCVault](../interfaces/TBTCVault.md).[getMinters](../interfaces/TBTCVault.md#getminters)

#### Defined in

[lib/ethereum/tbtc-vault.ts:90](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L90)

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

[lib/ethereum/tbtc-vault.ts:268](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L268)

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

[lib/ethereum/tbtc-vault.ts:295](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L295)

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

[lib/ethereum/tbtc-vault.ts:235](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L235)

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

[lib/ethereum/tbtc-vault.ts:114](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L114)

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

[lib/ethereum/tbtc-vault.ts:104](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L104)

___

### optimisticMintingDelay

▸ **optimisticMintingDelay**(): `Promise`\<`number`\>

#### Returns

`Promise`\<`number`\>

**`See`**

#### Implementation of

[TBTCVault](../interfaces/TBTCVault.md).[optimisticMintingDelay](../interfaces/TBTCVault.md#optimisticmintingdelay)

#### Defined in

[lib/ethereum/tbtc-vault.ts:76](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L76)

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

[lib/ethereum/tbtc-vault.ts:199](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L199)

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

[lib/ethereum/tbtc-vault.ts:222](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L222)

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

[lib/ethereum/tbtc-vault.ts:124](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L124)
