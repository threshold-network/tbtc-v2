# Class: BaseTBTCToken

Implementation of the Base DestinationChainTBTCToken handle.

**`See`**

for reference.

## Hierarchy

- `EvmContractHandle`

  ↳ **`BaseTBTCToken`**

## Implements

- [`DestinationChainTBTCToken`](../interfaces/DestinationChainTBTCToken.md)

## Table of contents

### Constructors

- [constructor](BaseTBTCToken.md#constructor)

### Properties

- [\_abi](BaseTBTCToken.md#_abi)
- [\_address](BaseTBTCToken.md#_address)
- [\_deployedAtBlockNumber](BaseTBTCToken.md#_deployedatblocknumber)
- [\_totalRetryAttempts](BaseTBTCToken.md#_totalretryattempts)

### Methods

- [\_connection](BaseTBTCToken.md#_connection)
- [\_getEvents](BaseTBTCToken.md#_getevents)
- [\_read](BaseTBTCToken.md#_read)
- [\_write](BaseTBTCToken.md#_write)
- [balanceOf](BaseTBTCToken.md#balanceof)
- [getAddress](BaseTBTCToken.md#getaddress)
- [getChainIdentifier](BaseTBTCToken.md#getchainidentifier)

## Constructors

### constructor

• **new BaseTBTCToken**(`config`, `chainId`): [`BaseTBTCToken`](BaseTBTCToken.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `config` | [`EthereumContractConfig`](../interfaces/EthereumContractConfig.md) |
| `chainId` | [`Base`](../enums/Chains.Base.md) |

#### Returns

[`BaseTBTCToken`](BaseTBTCToken.md)

#### Overrides

EvmContractHandle.constructor

#### Defined in

[src/lib/base/l2-tbtc-token.ts:24](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/base/l2-tbtc-token.ts#L24)

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

[src/lib/ethereum/adapter.ts:514](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L514)

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

[src/lib/ethereum/adapter.ts:456](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L456)

___

### balanceOf

▸ **balanceOf**(`identifier`): `Promise`\<`bigint`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `identifier` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) |

#### Returns

`Promise`\<`bigint`\>

**`See`**

#### Implementation of

[DestinationChainTBTCToken](../interfaces/DestinationChainTBTCToken.md).[balanceOf](../interfaces/DestinationChainTBTCToken.md#balanceof)

#### Defined in

[src/lib/base/l2-tbtc-token.ts:53](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/base/l2-tbtc-token.ts#L53)

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

[DestinationChainTBTCToken](../interfaces/DestinationChainTBTCToken.md).[getChainIdentifier](../interfaces/DestinationChainTBTCToken.md#getchainidentifier)

#### Defined in

[src/lib/base/l2-tbtc-token.ts:45](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/base/l2-tbtc-token.ts#L45)
