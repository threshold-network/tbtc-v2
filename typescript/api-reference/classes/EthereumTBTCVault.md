# Class: EthereumTBTCVault

Implementation of the Ethereum TBTCVault handle.

**`See`**

for reference.

## Hierarchy

- `EvmContractHandle`

  ↳ **`EthereumTBTCVault`**

## Implements

- [`TBTCVault`](../interfaces/TBTCVault.md)

## Table of contents

### Constructors

- [constructor](EthereumTBTCVault.md#constructor)

### Properties

- [\_abi](EthereumTBTCVault.md#_abi)
- [\_address](EthereumTBTCVault.md#_address)
- [\_deployedAtBlockNumber](EthereumTBTCVault.md#_deployedatblocknumber)
- [\_totalRetryAttempts](EthereumTBTCVault.md#_totalretryattempts)

### Methods

- [\_connection](EthereumTBTCVault.md#_connection)
- [\_getEvents](EthereumTBTCVault.md#_getevents)
- [\_read](EthereumTBTCVault.md#_read)
- [\_write](EthereumTBTCVault.md#_write)
- [cancelOptimisticMint](EthereumTBTCVault.md#canceloptimisticmint)
- [finalizeOptimisticMint](EthereumTBTCVault.md#finalizeoptimisticmint)
- [getAddress](EthereumTBTCVault.md#getaddress)
- [getChainIdentifier](EthereumTBTCVault.md#getchainidentifier)
- [getMinters](EthereumTBTCVault.md#getminters)
- [getOptimisticMintingCancelledEvents](EthereumTBTCVault.md#getoptimisticmintingcancelledevents)
- [getOptimisticMintingFinalizedEvents](EthereumTBTCVault.md#getoptimisticmintingfinalizedevents)
- [getOptimisticMintingRequestedEvents](EthereumTBTCVault.md#getoptimisticmintingrequestedevents)
- [isGuardian](EthereumTBTCVault.md#isguardian)
- [isMinter](EthereumTBTCVault.md#isminter)
- [optimisticMintingDelay](EthereumTBTCVault.md#optimisticmintingdelay)
- [optimisticMintingRequests](EthereumTBTCVault.md#optimisticmintingrequests)
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

EvmContractHandle.constructor

#### Defined in

[src/lib/ethereum/tbtc-vault.ts:47](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L47)

## Properties

### \_abi

• `Protected` `Readonly` **\_abi**: `Abi`

ABI of the contract instance.

#### Inherited from

EvmContractHandle.\_abi

#### Defined in

[src/lib/ethereum/adapter.ts:350](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L350)

___

### \_address

• `Protected` `Readonly` **\_address**: \`0x$\{string}\`

Address of the contract instance.

#### Inherited from

EvmContractHandle.\_address

#### Defined in

[src/lib/ethereum/adapter.ts:346](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L346)

___

### \_deployedAtBlockNumber

• `Protected` `Readonly` **\_deployedAtBlockNumber**: `number`

Number of a block within which the contract was deployed. Value is read
from the contract deployment artifact. It can be overwritten by setting
a [EthereumContractConfig.deployedAtBlockNumber](../interfaces/EthereumContractConfig.md#deployedatblocknumber) property.

#### Inherited from

EvmContractHandle.\_deployedAtBlockNumber

#### Defined in

[src/lib/ethereum/adapter.ts:356](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L356)

___

### \_totalRetryAttempts

• `Protected` `Readonly` **\_totalRetryAttempts**: `number`

Number of retries for ethereum requests.

#### Inherited from

EvmContractHandle.\_totalRetryAttempts

#### Defined in

[src/lib/ethereum/adapter.ts:360](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L360)

## Methods

### \_connection

▸ **_connection**(): `Promise`\<[`EvmConnection`](../interfaces/EvmConnection.md)\>

#### Returns

`Promise`\<[`EvmConnection`](../interfaces/EvmConnection.md)\>

The normalized connection this handle operates on.

#### Inherited from

EvmContractHandle.\_connection

#### Defined in

[src/lib/ethereum/adapter.ts:395](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L395)

___

### \_getEvents

▸ **_getEvents**(`eventName`, `options?`, `...filterArgs`): `Promise`\<`EvmEvent`[]\>

Get events emitted by the Ethereum contract.
It starts searching from provided block number. If the
[GetChainEvents.Options#fromBlock](../interfaces/GetChainEvents.Options.md#fromblock) option is missing it looks for
a contract's defined property [_deployedAtBlockNumber](BaseBitcoinDepositor.md#_deployedatblocknumber).
It pulls events in one `eth_getLogs` call. If the call fails it
fallbacks to querying events in batches of
[GetChainEvents.Options#batchedQueryBlockInterval](../interfaces/GetChainEvents.Options.md#batchedqueryblockinterval) blocks.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `eventName` | `string` | Name of the event. |
| `options?` | [`Options`](../interfaces/GetChainEvents.Options.md) | Options for events fetching. |
| `...filterArgs` | `unknown`[] | Positional arguments for events filtering, mapped onto the event's indexed inputs. Values must be 0x-prefixed hex strings, addresses, or `bigint`. |

#### Returns

`Promise`\<`EvmEvent`[]\>

Array of found events.

#### Inherited from

EvmContractHandle.\_getEvents

#### Defined in

[src/lib/ethereum/adapter.ts:516](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L516)

___

### \_read

▸ **_read**\<`T`\>(`functionName`, `args?`, `opts?`): `Promise`\<`T`\>

Calls a read-only contract function with retries.

#### Type parameters

| Name |
| :------ |
| `T` |

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `functionName` | `string` | Name of the contract function. |
| `args?` | readonly `unknown`[] | Positional arguments of the function. |
| `opts?` | `Object` | Optional block number to read at and retries override. |
| `opts.blockNumber?` | `number` | - |
| `opts.nonRetryableErrors?` | (`string` \| `RegExp`)[] | - |
| `opts.retries?` | `number` | - |

#### Returns

`Promise`\<`T`\>

Decoded function result. Numeric values arrive as `bigint` for
         types wider than 48 bits and `number` otherwise - normalize
         with `BigInt(x)` / `Number(x)` at the parsing site.

#### Inherited from

EvmContractHandle.\_read

#### Defined in

[src/lib/ethereum/adapter.ts:408](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L408)

___

### \_write

▸ **_write**(`functionName`, `args`, `opts?`): `Promise`\<[`Hex`](Hex.md)\>

Sends a contract write transaction with retries. The transaction is
simulated first (`eth_call`) so that reverts surface with a parseable
reason before anything is sent - mirroring the ethers v5 gas-estimation
pre-flight.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `functionName` | `string` | Name of the contract function. |
| `args` | readonly `unknown`[] | Positional arguments of the function. |
| `opts?` | `Object` | Optional value to send, non-retryable error matchers and logger. |
| `opts.logger?` | [`ExecutionLoggerFn`](../README.md#executionloggerfn) | - |
| `opts.nonRetryableErrors?` | (`string` \| `RegExp`)[] | - |
| `opts.value?` | `bigint` | - |

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

Transaction hash.

**`Throws`**

"Signer not provided" when the handle operates in read-only
        mode; EvmRevertError on contract revert.

#### Inherited from

EvmContractHandle.\_write

#### Defined in

[src/lib/ethereum/adapter.ts:458](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L458)

___

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

[src/lib/ethereum/tbtc-vault.ts:140](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L140)

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

[src/lib/ethereum/tbtc-vault.ts:159](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L159)

___

### getAddress

▸ **getAddress**(): [`EthereumAddress`](EthereumAddress.md)

Get address of the contract instance.

#### Returns

[`EthereumAddress`](EthereumAddress.md)

Address of this contract instance.

#### Inherited from

EvmContractHandle.getAddress

#### Defined in

[src/lib/ethereum/adapter.ts:388](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L388)

___

### getChainIdentifier

▸ **getChainIdentifier**(): [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

#### Returns

[`ChainIdentifier`](../interfaces/ChainIdentifier.md)

**`See`**

#### Implementation of

[TBTCVault](../interfaces/TBTCVault.md).[getChainIdentifier](../interfaces/TBTCVault.md#getchainidentifier)

#### Defined in

[src/lib/ethereum/tbtc-vault.ts:74](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L74)

___

### getMinters

▸ **getMinters**(): `Promise`\<[`EthereumAddress`](EthereumAddress.md)[]\>

#### Returns

`Promise`\<[`EthereumAddress`](EthereumAddress.md)[]\>

**`See`**

#### Implementation of

[TBTCVault](../interfaces/TBTCVault.md).[getMinters](../interfaces/TBTCVault.md#getminters)

#### Defined in

[src/lib/ethereum/tbtc-vault.ts:94](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L94)

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

[src/lib/ethereum/tbtc-vault.ts:239](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L239)

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

[src/lib/ethereum/tbtc-vault.ts:266](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L266)

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

[src/lib/ethereum/tbtc-vault.ts:204](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L204)

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

[src/lib/ethereum/tbtc-vault.ts:112](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L112)

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

[src/lib/ethereum/tbtc-vault.ts:104](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L104)

___

### optimisticMintingDelay

▸ **optimisticMintingDelay**(): `Promise`\<`number`\>

#### Returns

`Promise`\<`number`\>

**`See`**

#### Implementation of

[TBTCVault](../interfaces/TBTCVault.md).[optimisticMintingDelay](../interfaces/TBTCVault.md#optimisticmintingdelay)

#### Defined in

[src/lib/ethereum/tbtc-vault.ts:82](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L82)

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

[src/lib/ethereum/tbtc-vault.ts:179](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L179)

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

[src/lib/ethereum/tbtc-vault.ts:120](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-vault.ts#L120)
