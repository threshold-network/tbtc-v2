# Class: EthereumTBTCToken

Implementation of the Ethereum TBTC v2 token handle.

**`See`**

for reference.

## Hierarchy

- `EvmContractHandle`

  ↳ **`EthereumTBTCToken`**

## Implements

- [`TBTCToken`](../interfaces/TBTCToken.md)

## Table of contents

### Constructors

- [constructor](EthereumTBTCToken.md#constructor)

### Properties

- [\_abi](EthereumTBTCToken.md#_abi)
- [\_address](EthereumTBTCToken.md#_address)
- [\_deployedAtBlockNumber](EthereumTBTCToken.md#_deployedatblocknumber)
- [\_totalRetryAttempts](EthereumTBTCToken.md#_totalretryattempts)

### Methods

- [\_connection](EthereumTBTCToken.md#_connection)
- [\_getEvents](EthereumTBTCToken.md#_getevents)
- [\_read](EthereumTBTCToken.md#_read)
- [\_write](EthereumTBTCToken.md#_write)
- [buildBridgeRequestRedemptionData](EthereumTBTCToken.md#buildbridgerequestredemptiondata)
- [buildRequestRedemptionData](EthereumTBTCToken.md#buildrequestredemptiondata)
- [getAddress](EthereumTBTCToken.md#getaddress)
- [getChainIdentifier](EthereumTBTCToken.md#getchainidentifier)
- [requestRedemption](EthereumTBTCToken.md#requestredemption)
- [totalSupply](EthereumTBTCToken.md#totalsupply)

## Constructors

### constructor

• **new EthereumTBTCToken**(`config`, `chainId?`): [`EthereumTBTCToken`](EthereumTBTCToken.md)

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `config` | [`EthereumContractConfig`](../interfaces/EthereumContractConfig.md) | `undefined` |
| `chainId` | [`Ethereum`](../enums/Chains.Ethereum.md) | `Chains.Ethereum.Local` |

#### Returns

[`EthereumTBTCToken`](EthereumTBTCToken.md)

#### Overrides

EvmContractHandle.constructor

#### Defined in

[src/lib/ethereum/tbtc-token.ts:23](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-token.ts#L23)

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

### buildBridgeRequestRedemptionData

▸ **buildBridgeRequestRedemptionData**(`walletPublicKey`, `mainUtxo`, `redeemerOutputScript`): `Object`

#### Parameters

| Name | Type |
| :------ | :------ |
| `walletPublicKey` | [`Hex`](Hex.md) |
| `mainUtxo` | [`BitcoinUtxo`](../README.md#bitcoinutxo) |
| `redeemerOutputScript` | [`Hex`](Hex.md) |

#### Returns

`Object`

| Name | Type |
| :------ | :------ |
| `mainUtxo` | \{ `txHash`: `string` ; `txOutputIndex`: `number` = mainUtxo.outputIndex; `txOutputValue`: `bigint` = mainUtxo.value } |
| `mainUtxo.txHash` | `string` |
| `mainUtxo.txOutputIndex` | `number` |
| `mainUtxo.txOutputValue` | `bigint` |
| `prefixedRawRedeemerOutputScript` | `string` |
| `walletPublicKeyHash` | `string` |

#### Defined in

[src/lib/ethereum/tbtc-token.ts:140](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-token.ts#L140)

___

### buildRequestRedemptionData

▸ **buildRequestRedemptionData**(`redeemer`, `walletPublicKey`, `mainUtxo`, `redeemerOutputScript`): [`Hex`](Hex.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `redeemer` | [`EthereumAddress`](EthereumAddress.md) |
| `walletPublicKey` | [`Hex`](Hex.md) |
| `mainUtxo` | [`BitcoinUtxo`](../README.md#bitcoinutxo) |
| `redeemerOutputScript` | [`Hex`](Hex.md) |

#### Returns

[`Hex`](Hex.md)

**`See`**

#### Implementation of

[TBTCToken](../interfaces/TBTCToken.md).[buildRequestRedemptionData](../interfaces/TBTCToken.md#buildrequestredemptiondata)

#### Defined in

[src/lib/ethereum/tbtc-token.ts:102](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-token.ts#L102)

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

[TBTCToken](../interfaces/TBTCToken.md).[getChainIdentifier](../interfaces/TBTCToken.md#getchainidentifier)

#### Defined in

[src/lib/ethereum/tbtc-token.ts:50](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-token.ts#L50)

___

### requestRedemption

▸ **requestRedemption**(`walletPublicKey`, `mainUtxo`, `redeemerOutputScript`, `amount`): `Promise`\<[`Hex`](Hex.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `walletPublicKey` | [`Hex`](Hex.md) |
| `mainUtxo` | [`BitcoinUtxo`](../README.md#bitcoinutxo) |
| `redeemerOutputScript` | [`Hex`](Hex.md) |
| `amount` | `bigint` |

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

**`See`**

#### Implementation of

[TBTCToken](../interfaces/TBTCToken.md).[requestRedemption](../interfaces/TBTCToken.md#requestredemption)

#### Defined in

[src/lib/ethereum/tbtc-token.ts:72](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-token.ts#L72)

___

### totalSupply

▸ **totalSupply**(`blockNumber?`): `Promise`\<`bigint`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `blockNumber?` | `number` |

#### Returns

`Promise`\<`bigint`\>

**`See`**

#### Implementation of

[TBTCToken](../interfaces/TBTCToken.md).[totalSupply](../interfaces/TBTCToken.md#totalsupply)

#### Defined in

[src/lib/ethereum/tbtc-token.ts:58](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/tbtc-token.ts#L58)
