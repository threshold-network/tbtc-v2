# Class: BaseBitcoinDepositor

Implementation of the Base BitcoinDepositor handle.

**`See`**

for reference.

## Hierarchy

- `EvmContractHandle`

  ↳ **`BaseBitcoinDepositor`**

## Implements

- [`BitcoinDepositor`](../interfaces/BitcoinDepositor.md)

## Table of contents

### Constructors

- [constructor](BaseBitcoinDepositor.md#constructor)

### Properties

- [#depositOwner](BaseBitcoinDepositor.md##depositowner)
- [#extraDataEncoder](BaseBitcoinDepositor.md##extradataencoder)
- [\_abi](BaseBitcoinDepositor.md#_abi)
- [\_address](BaseBitcoinDepositor.md#_address)
- [\_deployedAtBlockNumber](BaseBitcoinDepositor.md#_deployedatblocknumber)
- [\_totalRetryAttempts](BaseBitcoinDepositor.md#_totalretryattempts)

### Methods

- [\_connection](BaseBitcoinDepositor.md#_connection)
- [\_getEvents](BaseBitcoinDepositor.md#_getevents)
- [\_read](BaseBitcoinDepositor.md#_read)
- [\_write](BaseBitcoinDepositor.md#_write)
- [extraDataEncoder](BaseBitcoinDepositor.md#extradataencoder)
- [getAddress](BaseBitcoinDepositor.md#getaddress)
- [getChainIdentifier](BaseBitcoinDepositor.md#getchainidentifier)
- [getDepositOwner](BaseBitcoinDepositor.md#getdepositowner)
- [initializeDeposit](BaseBitcoinDepositor.md#initializedeposit)
- [setDepositOwner](BaseBitcoinDepositor.md#setdepositowner)

## Constructors

### constructor

• **new BaseBitcoinDepositor**(`config`, `chainId`): [`BaseBitcoinDepositor`](BaseBitcoinDepositor.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `config` | `EvmContractHandleConfig` |
| `chainId` | [`Base`](../enums/Chains.Base.md) |

#### Returns

[`BaseBitcoinDepositor`](BaseBitcoinDepositor.md)

#### Overrides

EvmContractHandle.constructor

#### Defined in

[src/lib/base/l2-bitcoin-depositor.ts:34](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/base/l2-bitcoin-depositor.ts#L34)

## Properties

### #depositOwner

• `Private` **#depositOwner**: `undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

#### Defined in

[src/lib/base/l2-bitcoin-depositor.ts:32](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/base/l2-bitcoin-depositor.ts#L32)

___

### #extraDataEncoder

• `Private` `Readonly` **#extraDataEncoder**: [`ExtraDataEncoder`](../interfaces/ExtraDataEncoder.md)

#### Defined in

[src/lib/base/l2-bitcoin-depositor.ts:31](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/base/l2-bitcoin-depositor.ts#L31)

___

### \_abi

• `Protected` `Readonly` **\_abi**: `Abi`

ABI of the contract instance.

#### Inherited from

EvmContractHandle.\_abi

#### Defined in

[src/lib/ethereum/adapter.ts:392](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L392)

___

### \_address

• `Protected` `Readonly` **\_address**: \`0x$\{string}\`

Address of the contract instance.

#### Inherited from

EvmContractHandle.\_address

#### Defined in

[src/lib/ethereum/adapter.ts:388](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L388)

___

### \_deployedAtBlockNumber

• `Protected` `Readonly` **\_deployedAtBlockNumber**: `number`

Number of a block within which the contract was deployed. Value is read
from the contract deployment artifact. It can be overwritten by setting
a [EthereumContractConfig.deployedAtBlockNumber](../interfaces/EthereumContractConfig.md#deployedatblocknumber) property.

#### Inherited from

EvmContractHandle.\_deployedAtBlockNumber

#### Defined in

[src/lib/ethereum/adapter.ts:398](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L398)

___

### \_totalRetryAttempts

• `Protected` `Readonly` **\_totalRetryAttempts**: `number`

Number of retries for ethereum requests.

#### Inherited from

EvmContractHandle.\_totalRetryAttempts

#### Defined in

[src/lib/ethereum/adapter.ts:402](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L402)

## Methods

### \_connection

▸ **_connection**(): `Promise`\<`EvmConnection`\>

#### Returns

`Promise`\<`EvmConnection`\>

The normalized connection this handle operates on.

#### Inherited from

EvmContractHandle.\_connection

#### Defined in

[src/lib/ethereum/adapter.ts:438](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L438)

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
| `...filterArgs` | `unknown`[] | Filter arguments in full ABI input order. Use null or undefined for non-indexed inputs and indexed wildcards. Filter values must be 0x-prefixed hex strings, addresses, or `bigint`. |

#### Returns

`Promise`\<`EvmEvent`[]\>

Array of found events.

#### Inherited from

EvmContractHandle.\_getEvents

#### Defined in

[src/lib/ethereum/adapter.ts:568](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L568)

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

[src/lib/ethereum/adapter.ts:451](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L451)

___

### \_write

▸ **_write**(`functionName`, `args`, `opts?`): `Promise`\<[`Hex`](Hex.md)\>

Sends a contract write transaction with retries. The transaction is
simulated first (`eth_call`) so that reverts surface with a parseable
reason before anything is sent - mirroring the ethers v5 gas-estimation
pre-flight. A retry count of zero submits at most once.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `functionName` | `string` | Name of the contract function. |
| `args` | readonly `unknown`[] | Positional arguments of the function. |
| `opts?` | `Object` | Optional value to send, retry count, non-retryable error matchers and logger. |
| `opts.logger?` | [`ExecutionLoggerFn`](../README.md#executionloggerfn) | - |
| `opts.nonRetryableErrors?` | (`string` \| `RegExp`)[] | - |
| `opts.retries?` | `number` | - |
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

[src/lib/ethereum/adapter.ts:499](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L499)

___

### extraDataEncoder

▸ **extraDataEncoder**(): [`ExtraDataEncoder`](../interfaces/ExtraDataEncoder.md)

#### Returns

[`ExtraDataEncoder`](../interfaces/ExtraDataEncoder.md)

**`See`**

#### Implementation of

[BitcoinDepositor](../interfaces/BitcoinDepositor.md).[extraDataEncoder](../interfaces/BitcoinDepositor.md#extradataencoder)

#### Defined in

[src/lib/base/l2-bitcoin-depositor.ts:81](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/base/l2-bitcoin-depositor.ts#L81)

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

[src/lib/ethereum/adapter.ts:431](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L431)

___

### getChainIdentifier

▸ **getChainIdentifier**(): [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

#### Returns

[`ChainIdentifier`](../interfaces/ChainIdentifier.md)

**`See`**

#### Implementation of

[BitcoinDepositor](../interfaces/BitcoinDepositor.md).[getChainIdentifier](../interfaces/BitcoinDepositor.md#getchainidentifier)

#### Defined in

[src/lib/base/l2-bitcoin-depositor.ts:57](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/base/l2-bitcoin-depositor.ts#L57)

___

### getDepositOwner

▸ **getDepositOwner**(): `undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

#### Returns

`undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

**`See`**

#### Implementation of

[BitcoinDepositor](../interfaces/BitcoinDepositor.md).[getDepositOwner](../interfaces/BitcoinDepositor.md#getdepositowner)

#### Defined in

[src/lib/base/l2-bitcoin-depositor.ts:65](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/base/l2-bitcoin-depositor.ts#L65)

___

### initializeDeposit

▸ **initializeDeposit**(`depositTx`, `depositOutputIndex`, `deposit`, `vault?`): `Promise`\<[`Hex`](Hex.md) \| [`ChainTransactionReceipt`](../interfaces/ChainTransactionReceipt.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `depositTx` | [`BitcoinRawTxVectors`](../interfaces/BitcoinRawTxVectors.md) |
| `depositOutputIndex` | `number` |
| `deposit` | [`DepositReceipt`](../interfaces/DepositReceipt.md) |
| `vault?` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) |

#### Returns

`Promise`\<[`Hex`](Hex.md) \| [`ChainTransactionReceipt`](../interfaces/ChainTransactionReceipt.md)\>

**`See`**

#### Implementation of

[BitcoinDepositor](../interfaces/BitcoinDepositor.md).[initializeDeposit](../interfaces/BitcoinDepositor.md#initializedeposit)

#### Defined in

[src/lib/base/l2-bitcoin-depositor.ts:89](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/base/l2-bitcoin-depositor.ts#L89)

___

### setDepositOwner

▸ **setDepositOwner**(`depositOwner`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `depositOwner` | `undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md) |

#### Returns

`void`

**`See`**

#### Implementation of

[BitcoinDepositor](../interfaces/BitcoinDepositor.md).[setDepositOwner](../interfaces/BitcoinDepositor.md#setdepositowner)

#### Defined in

[src/lib/base/l2-bitcoin-depositor.ts:73](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/base/l2-bitcoin-depositor.ts#L73)
