# Class: EthereumBridge

Implementation of the Ethereum Bridge handle.

**`See`**

for reference.

## Hierarchy

- `EvmContractHandle`

  ↳ **`EthereumBridge`**

## Implements

- [`Bridge`](../interfaces/Bridge.md)

## Table of contents

### Constructors

- [constructor](EthereumBridge.md#constructor)

### Properties

- [\_abi](EthereumBridge.md#_abi)
- [\_address](EthereumBridge.md#_address)
- [\_deployedAtBlockNumber](EthereumBridge.md#_deployedatblocknumber)
- [\_totalRetryAttempts](EthereumBridge.md#_totalretryattempts)

### Methods

- [\_connection](EthereumBridge.md#_connection)
- [\_getEvents](EthereumBridge.md#_getevents)
- [\_read](EthereumBridge.md#_read)
- [\_write](EthereumBridge.md#_write)
- [activeWalletPublicKey](EthereumBridge.md#activewalletpublickey)
- [buildUtxoHash](EthereumBridge.md#buildutxohash)
- [deposits](EthereumBridge.md#deposits)
- [getAddress](EthereumBridge.md#getaddress)
- [getChainIdentifier](EthereumBridge.md#getchainidentifier)
- [getDepositRevealedEvents](EthereumBridge.md#getdepositrevealedevents)
- [getNewWalletRegisteredEvents](EthereumBridge.md#getnewwalletregisteredevents)
- [getRedemptionEvents](EthereumBridge.md#getredemptionevents)
- [getRedemptionRequestedEvents](EthereumBridge.md#getredemptionrequestedevents)
- [getRedemptionTimedOutEvents](EthereumBridge.md#getredemptiontimedoutevents)
- [getRedemptionTimeout](EthereumBridge.md#getredemptiontimeout)
- [getRedemptionsCompletedEvents](EthereumBridge.md#getredemptionscompletedevents)
- [getWalletCompressedPublicKey](EthereumBridge.md#getwalletcompressedpublickey)
- [parseDepositRequest](EthereumBridge.md#parsedepositrequest)
- [parseRedemptionRequest](EthereumBridge.md#parseredemptionrequest)
- [parseWalletDetails](EthereumBridge.md#parsewalletdetails)
- [pendingRedemptions](EthereumBridge.md#pendingredemptions)
- [pendingRedemptionsByWalletPKH](EthereumBridge.md#pendingredemptionsbywalletpkh)
- [requestRedemption](EthereumBridge.md#requestredemption)
- [revealDeposit](EthereumBridge.md#revealdeposit)
- [submitDepositSweepProof](EthereumBridge.md#submitdepositsweepproof)
- [submitRedemptionProof](EthereumBridge.md#submitredemptionproof)
- [timedOutRedemptions](EthereumBridge.md#timedoutredemptions)
- [txProofDifficultyFactor](EthereumBridge.md#txproofdifficultyfactor)
- [walletRegistry](EthereumBridge.md#walletregistry)
- [wallets](EthereumBridge.md#wallets)
- [buildDepositKey](EthereumBridge.md#builddepositkey)
- [buildRedemptionKey](EthereumBridge.md#buildredemptionkey)

## Constructors

### constructor

• **new EthereumBridge**(`config`, `chainId?`): [`EthereumBridge`](EthereumBridge.md)

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `config` | [`EthereumContractConfig`](../interfaces/EthereumContractConfig.md) | `undefined` |
| `chainId` | [`Ethereum`](../enums/Chains.Ethereum.md) | `Chains.Ethereum.Local` |

#### Returns

[`EthereumBridge`](EthereumBridge.md)

#### Overrides

EvmContractHandle.constructor

#### Defined in

[src/lib/ethereum/bridge.ts:89](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L89)

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

### activeWalletPublicKey

▸ **activeWalletPublicKey**(): `Promise`\<`undefined` \| [`Hex`](Hex.md)\>

#### Returns

`Promise`\<`undefined` \| [`Hex`](Hex.md)\>

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[activeWalletPublicKey](../interfaces/Bridge.md#activewalletpublickey)

#### Defined in

[src/lib/ethereum/bridge.ts:502](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L502)

___

### buildUtxoHash

▸ **buildUtxoHash**(`utxo`): [`Hex`](Hex.md)

Builds the UTXO hash based on the UTXO components. UTXO hash is computed as
`keccak256(txHash | txOutputIndex | txOutputValue)`.

#### Parameters

| Name | Type |
| :------ | :------ |
| `utxo` | [`BitcoinUtxo`](../README.md#bitcoinutxo) |

#### Returns

[`Hex`](Hex.md)

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[buildUtxoHash](../interfaces/Bridge.md#buildutxohash)

#### Defined in

[src/lib/ethereum/bridge.ts:637](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L637)

___

### deposits

▸ **deposits**(`depositTxHash`, `depositOutputIndex`): `Promise`\<[`DepositRequest`](../interfaces/DepositRequest.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `depositTxHash` | [`BitcoinTxHash`](BitcoinTxHash.md) |
| `depositOutputIndex` | `number` |

#### Returns

`Promise`\<[`DepositRequest`](../interfaces/DepositRequest.md)\>

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[deposits](../interfaces/Bridge.md#deposits)

#### Defined in

[src/lib/ethereum/bridge.ts:440](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L440)

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

[Bridge](../interfaces/Bridge.md).[getChainIdentifier](../interfaces/Bridge.md#getchainidentifier)

#### Defined in

[src/lib/ethereum/bridge.ts:116](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L116)

___

### getDepositRevealedEvents

▸ **getDepositRevealedEvents**(`options?`, `...filterArgs`): `Promise`\<[`DepositRevealedEvent`](../README.md#depositrevealedevent)[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `options?` | [`Options`](../interfaces/GetChainEvents.Options.md) |
| `...filterArgs` | `unknown`[] |

#### Returns

`Promise`\<[`DepositRevealedEvent`](../README.md#depositrevealedevent)[]\>

**`See`**

#### Implementation of

Bridge.getDepositRevealedEvents

#### Defined in

[src/lib/ethereum/bridge.ts:124](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L124)

___

### getNewWalletRegisteredEvents

▸ **getNewWalletRegisteredEvents**(`options?`, `...filterArgs`): `Promise`\<[`NewWalletRegisteredEvent`](../README.md#newwalletregisteredevent)[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `options?` | [`Options`](../interfaces/GetChainEvents.Options.md) |
| `...filterArgs` | `unknown`[] |

#### Returns

`Promise`\<[`NewWalletRegisteredEvent`](../README.md#newwalletregisteredevent)[]\>

**`See`**

#### Implementation of

Bridge.getNewWalletRegisteredEvents

#### Defined in

[src/lib/ethereum/bridge.ts:552](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L552)

___

### getRedemptionEvents

▸ **getRedemptionEvents**(`eventName`, `options?`, `...filterArgs`): `Promise`\<`EvmEvent`[]\>

Queries redemption lifecycle events with ABI-correct wallet topics.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `eventName` | ``"RedemptionRequested"`` \| ``"RedemptionTimedOut"`` \| ``"RedemptionsCompleted"`` | Name of the lifecycle event. |
| `options?` | [`Options`](../interfaces/GetChainEvents.Options.md) | Event query options. |
| `...filterArgs` | `unknown`[] | Indexed event filters. |

#### Returns

`Promise`\<`EvmEvent`[]\>

Matching events.

#### Defined in

[src/lib/ethereum/bridge.ts:730](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L730)

___

### getRedemptionRequestedEvents

▸ **getRedemptionRequestedEvents**(`options?`, `...filterArgs`): `Promise`\<[`RedemptionRequestedEvent`](../README.md#redemptionrequestedevent)[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `options?` | [`Options`](../interfaces/GetChainEvents.Options.md) |
| `...filterArgs` | `unknown`[] |

#### Returns

`Promise`\<[`RedemptionRequestedEvent`](../README.md#redemptionrequestedevent)[]\>

**`See`**

#### Implementation of

Bridge.getRedemptionRequestedEvents

#### Defined in

[src/lib/ethereum/bridge.ts:770](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L770)

___

### getRedemptionTimedOutEvents

▸ **getRedemptionTimedOutEvents**(`options?`, `...filterArgs`): `Promise`\<[`RedemptionTimedOutEvent`](../README.md#redemptiontimedoutevent)[]\>

Reads reported redemption timeout events.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `options?` | [`Options`](../interfaces/GetChainEvents.Options.md) | Event query options. |
| `...filterArgs` | `unknown`[] | Indexed event filters. |

#### Returns

`Promise`\<[`RedemptionTimedOutEvent`](../README.md#redemptiontimedoutevent)[]\>

Timeout events with output scripts without their length prefix.

#### Implementation of

Bridge.getRedemptionTimedOutEvents

#### Defined in

[src/lib/ethereum/bridge.ts:698](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L698)

___

### getRedemptionTimeout

▸ **getRedemptionTimeout**(`blockNumber?`): `Promise`\<`number`\>

Reads the redemption timeout at the specified block.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `blockNumber?` | `number` | Block to read, or the latest block when omitted. |

#### Returns

`Promise`\<`number`\>

Timeout in seconds.

#### Implementation of

[Bridge](../interfaces/Bridge.md).[getRedemptionTimeout](../interfaces/Bridge.md#getredemptiontimeout)

#### Defined in

[src/lib/ethereum/bridge.ts:657](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L657)

___

### getRedemptionsCompletedEvents

▸ **getRedemptionsCompletedEvents**(`options?`, `...filterArgs`): `Promise`\<[`RedemptionsCompletedEvent`](../README.md#redemptionscompletedevent)[]\>

Reads accepted redemption proof events.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `options?` | [`Options`](../interfaces/GetChainEvents.Options.md) | Event query options. |
| `...filterArgs` | `unknown`[] | Indexed event filters. |

#### Returns

`Promise`\<[`RedemptionsCompletedEvent`](../README.md#redemptionscompletedevent)[]\>

Completion events with Bitcoin hashes in display byte order.

#### Implementation of

Bridge.getRedemptionsCompletedEvents

#### Defined in

[src/lib/ethereum/bridge.ts:672](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L672)

___

### getWalletCompressedPublicKey

▸ **getWalletCompressedPublicKey**(`ecdsaWalletID`): `Promise`\<`undefined` \| [`Hex`](Hex.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `ecdsaWalletID` | [`Hex`](Hex.md) |

#### Returns

`Promise`\<`undefined` \| [`Hex`](Hex.md)\>

#### Defined in

[src/lib/ethereum/bridge.ts:521](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L521)

___

### parseDepositRequest

▸ **parseDepositRequest**(`deposit`): [`DepositRequest`](../interfaces/DepositRequest.md)

Parses a deposit request using data fetched from the on-chain contract.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `deposit` | `DepositRequestStruct` | Data of the deposit request. |

#### Returns

[`DepositRequest`](../interfaces/DepositRequest.md)

Parsed deposit request.

#### Defined in

[src/lib/ethereum/bridge.ts:484](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L484)

___

### parseRedemptionRequest

▸ **parseRedemptionRequest**(`request`, `redeemerOutputScript`): [`RedemptionRequest`](../interfaces/RedemptionRequest.md)

Parses a redemption request using data fetched from the on-chain contract.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `request` | `RedemptionRequestStruct` | Data of the request. |
| `redeemerOutputScript` | [`Hex`](Hex.md) | The redeemer output script that identifies the pending redemption (along with the wallet public key hash). Must not be prepended with length. |

#### Returns

[`RedemptionRequest`](../interfaces/RedemptionRequest.md)

Parsed redemption request.

#### Defined in

[src/lib/ethereum/bridge.ts:259](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L259)

___

### parseWalletDetails

▸ **parseWalletDetails**(`wallet`): `Promise`\<[`Wallet`](../interfaces/Wallet.md)\>

Parses a wallet data using data fetched from the on-chain contract.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `wallet` | `WalletStruct` | Data of the wallet. |

#### Returns

`Promise`\<[`Wallet`](../interfaces/Wallet.md)\>

Parsed wallet data.

#### Defined in

[src/lib/ethereum/bridge.ts:609](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L609)

___

### pendingRedemptions

▸ **pendingRedemptions**(`walletPublicKey`, `redeemerOutputScript`): `Promise`\<[`RedemptionRequest`](../interfaces/RedemptionRequest.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `walletPublicKey` | [`Hex`](Hex.md) |
| `redeemerOutputScript` | [`Hex`](Hex.md) |

#### Returns

`Promise`\<[`RedemptionRequest`](../interfaces/RedemptionRequest.md)\>

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[pendingRedemptions](../interfaces/Bridge.md#pendingredemptions)

#### Defined in

[src/lib/ethereum/bridge.ts:163](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L163)

___

### pendingRedemptionsByWalletPKH

▸ **pendingRedemptionsByWalletPKH**(`walletPublicKeyHash`, `redeemerOutputScript`, `blockNumber?`): `Promise`\<[`RedemptionRequest`](../interfaces/RedemptionRequest.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `walletPublicKeyHash` | [`Hex`](Hex.md) |
| `redeemerOutputScript` | [`Hex`](Hex.md) |
| `blockNumber?` | `number` |

#### Returns

`Promise`\<[`RedemptionRequest`](../interfaces/RedemptionRequest.md)\>

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[pendingRedemptionsByWalletPKH](../interfaces/Bridge.md#pendingredemptionsbywalletpkh)

#### Defined in

[src/lib/ethereum/bridge.ts:178](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L178)

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

[Bridge](../interfaces/Bridge.md).[requestRedemption](../interfaces/Bridge.md#requestredemption)

#### Defined in

[src/lib/ethereum/bridge.ts:359](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L359)

___

### revealDeposit

▸ **revealDeposit**(`depositTx`, `depositOutputIndex`, `deposit`, `vault?`): `Promise`\<[`Hex`](Hex.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `depositTx` | [`BitcoinRawTxVectors`](../interfaces/BitcoinRawTxVectors.md) |
| `depositOutputIndex` | `number` |
| `deposit` | [`DepositReceipt`](../interfaces/DepositReceipt.md) |
| `vault?` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) |

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[revealDeposit](../interfaces/Bridge.md#revealdeposit)

#### Defined in

[src/lib/ethereum/bridge.ts:277](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L277)

___

### submitDepositSweepProof

▸ **submitDepositSweepProof**(`sweepTx`, `sweepProof`, `mainUtxo`, `vault?`): `Promise`\<[`Hex`](Hex.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `sweepTx` | [`BitcoinRawTxVectors`](../interfaces/BitcoinRawTxVectors.md) |
| `sweepProof` | [`BitcoinSpvProof`](../interfaces/BitcoinSpvProof.md) |
| `mainUtxo` | [`BitcoinUtxo`](../README.md#bitcoinutxo) |
| `vault?` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) |

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[submitDepositSweepProof](../interfaces/Bridge.md#submitdepositsweepproof)

#### Defined in

[src/lib/ethereum/bridge.ts:304](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L304)

___

### submitRedemptionProof

▸ **submitRedemptionProof**(`redemptionTx`, `redemptionProof`, `mainUtxo`, `walletPublicKey`): `Promise`\<[`Hex`](Hex.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `redemptionTx` | [`BitcoinRawTxVectors`](../interfaces/BitcoinRawTxVectors.md) |
| `redemptionProof` | [`BitcoinSpvProof`](../interfaces/BitcoinSpvProof.md) |
| `mainUtxo` | [`BitcoinUtxo`](../README.md#bitcoinutxo) |
| `walletPublicKey` | [`Hex`](Hex.md) |

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[submitRedemptionProof](../interfaces/Bridge.md#submitredemptionproof)

#### Defined in

[src/lib/ethereum/bridge.ts:396](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L396)

___

### timedOutRedemptions

▸ **timedOutRedemptions**(`walletPublicKey`, `redeemerOutputScript`): `Promise`\<[`RedemptionRequest`](../interfaces/RedemptionRequest.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `walletPublicKey` | [`Hex`](Hex.md) |
| `redeemerOutputScript` | [`Hex`](Hex.md) |

#### Returns

`Promise`\<[`RedemptionRequest`](../interfaces/RedemptionRequest.md)\>

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[timedOutRedemptions](../interfaces/Bridge.md#timedoutredemptions)

#### Defined in

[src/lib/ethereum/bridge.ts:201](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L201)

___

### txProofDifficultyFactor

▸ **txProofDifficultyFactor**(): `Promise`\<`number`\>

#### Returns

`Promise`\<`number`\>

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[txProofDifficultyFactor](../interfaces/Bridge.md#txproofdifficultyfactor)

#### Defined in

[src/lib/ethereum/bridge.ts:347](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L347)

___

### walletRegistry

▸ **walletRegistry**(): `Promise`\<[`WalletRegistry`](../interfaces/WalletRegistry.md)\>

#### Returns

`Promise`\<[`WalletRegistry`](../interfaces/WalletRegistry.md)\>

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[walletRegistry](../interfaces/Bridge.md#walletregistry)

#### Defined in

[src/lib/ethereum/bridge.ts:577](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L577)

___

### wallets

▸ **wallets**(`walletPublicKeyHash`): `Promise`\<[`Wallet`](../interfaces/Wallet.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `walletPublicKeyHash` | [`Hex`](Hex.md) |

#### Returns

`Promise`\<[`Wallet`](../interfaces/Wallet.md)\>

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[wallets](../interfaces/Bridge.md#wallets)

#### Defined in

[src/lib/ethereum/bridge.ts:596](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L596)

___

### buildDepositKey

▸ **buildDepositKey**(`depositTxHash`, `depositOutputIndex`): `string`

Builds the deposit key required to refer a revealed deposit.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositTxHash` | [`BitcoinTxHash`](BitcoinTxHash.md) | The revealed deposit transaction's hash. |
| `depositOutputIndex` | `number` | Index of the deposit transaction output that funds the revealed deposit. |

#### Returns

`string`

Deposit key.

#### Defined in

[src/lib/ethereum/bridge.ts:463](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L463)

___

### buildRedemptionKey

▸ **buildRedemptionKey**(`walletPublicKeyHash`, `redeemerOutputScript`): `string`

Builds a redemption key required to refer a redemption request.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `walletPublicKeyHash` | [`Hex`](Hex.md) | The wallet public key hash that identifies the pending redemption (along with the redeemer output script). |
| `redeemerOutputScript` | [`Hex`](Hex.md) | The redeemer output script that identifies the pending redemption (along with the wallet public key hash). Must not be prepended with length. |

#### Returns

`string`

The redemption key.

#### Defined in

[src/lib/ethereum/bridge.ts:227](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L227)
