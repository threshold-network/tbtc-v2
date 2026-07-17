# Class: EthereumWalletRegistry

Implementation of the Ethereum WalletRegistry handle.

**`See`**

for reference.

## Hierarchy

- `EvmContractHandle`

  ↳ **`EthereumWalletRegistry`**

## Implements

- [`WalletRegistry`](../interfaces/WalletRegistry.md)

## Table of contents

### Constructors

- [constructor](EthereumWalletRegistry.md#constructor)

### Properties

- [\_abi](EthereumWalletRegistry.md#_abi)
- [\_address](EthereumWalletRegistry.md#_address)
- [\_deployedAtBlockNumber](EthereumWalletRegistry.md#_deployedatblocknumber)
- [\_totalRetryAttempts](EthereumWalletRegistry.md#_totalretryattempts)

### Methods

- [\_connection](EthereumWalletRegistry.md#_connection)
- [\_getEvents](EthereumWalletRegistry.md#_getevents)
- [\_read](EthereumWalletRegistry.md#_read)
- [\_write](EthereumWalletRegistry.md#_write)
- [getAddress](EthereumWalletRegistry.md#getaddress)
- [getChainIdentifier](EthereumWalletRegistry.md#getchainidentifier)
- [getDkgResultApprovedEvents](EthereumWalletRegistry.md#getdkgresultapprovedevents)
- [getDkgResultChallengedEvents](EthereumWalletRegistry.md#getdkgresultchallengedevents)
- [getDkgResultSubmittedEvents](EthereumWalletRegistry.md#getdkgresultsubmittedevents)
- [getWalletPublicKey](EthereumWalletRegistry.md#getwalletpublickey)

## Constructors

### constructor

• **new EthereumWalletRegistry**(`config`, `chainId?`): [`EthereumWalletRegistry`](EthereumWalletRegistry.md)

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `config` | [`EthereumContractConfig`](../interfaces/EthereumContractConfig.md) | `undefined` |
| `chainId` | [`Ethereum`](../enums/Chains.Ethereum.md) | `Chains.Ethereum.Local` |

#### Returns

[`EthereumWalletRegistry`](EthereumWalletRegistry.md)

#### Overrides

EvmContractHandle.constructor

#### Defined in

[src/lib/ethereum/wallet-registry.ts:62](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/wallet-registry.ts#L62)

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

[WalletRegistry](../interfaces/WalletRegistry.md).[getChainIdentifier](../interfaces/WalletRegistry.md#getchainidentifier)

#### Defined in

[src/lib/ethereum/wallet-registry.ts:89](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/wallet-registry.ts#L89)

___

### getDkgResultApprovedEvents

▸ **getDkgResultApprovedEvents**(`options?`, `...filterArgs`): `Promise`\<[`DkgResultApprovedEvent`](../README.md#dkgresultapprovedevent)[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `options?` | [`Options`](../interfaces/GetChainEvents.Options.md) |
| `...filterArgs` | `unknown`[] |

#### Returns

`Promise`\<[`DkgResultApprovedEvent`](../README.md#dkgresultapprovedevent)[]\>

**`See`**

#### Implementation of

WalletRegistry.getDkgResultApprovedEvents

#### Defined in

[src/lib/ethereum/wallet-registry.ts:161](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/wallet-registry.ts#L161)

___

### getDkgResultChallengedEvents

▸ **getDkgResultChallengedEvents**(`options?`, `...filterArgs`): `Promise`\<[`DkgResultChallengedEvent`](../README.md#dkgresultchallengedevent)[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `options?` | [`Options`](../interfaces/GetChainEvents.Options.md) |
| `...filterArgs` | `unknown`[] |

#### Returns

`Promise`\<[`DkgResultChallengedEvent`](../README.md#dkgresultchallengedevent)[]\>

**`See`**

#### Implementation of

WalletRegistry.getDkgResultChallengedEvents

#### Defined in

[src/lib/ethereum/wallet-registry.ts:186](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/wallet-registry.ts#L186)

___

### getDkgResultSubmittedEvents

▸ **getDkgResultSubmittedEvents**(`options?`, `...filterArgs`): `Promise`\<[`DkgResultSubmittedEvent`](../README.md#dkgresultsubmittedevent)[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `options?` | [`Options`](../interfaces/GetChainEvents.Options.md) |
| `...filterArgs` | `unknown`[] |

#### Returns

`Promise`\<[`DkgResultSubmittedEvent`](../README.md#dkgresultsubmittedevent)[]\>

**`See`**

#### Implementation of

WalletRegistry.getDkgResultSubmittedEvents

#### Defined in

[src/lib/ethereum/wallet-registry.ts:119](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/wallet-registry.ts#L119)

___

### getWalletPublicKey

▸ **getWalletPublicKey**(`walletID`, `skipRetryWhenNotRegistered?`): `Promise`\<[`Hex`](Hex.md)\>

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `walletID` | [`Hex`](Hex.md) | `undefined` |
| `skipRetryWhenNotRegistered` | `boolean` | `false` |

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

**`See`**

#### Implementation of

[WalletRegistry](../interfaces/WalletRegistry.md).[getWalletPublicKey](../interfaces/WalletRegistry.md#getwalletpublickey)

#### Defined in

[src/lib/ethereum/wallet-registry.ts:97](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/wallet-registry.ts#L97)
