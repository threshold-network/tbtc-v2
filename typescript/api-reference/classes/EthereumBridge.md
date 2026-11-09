# Class: EthereumBridge

Implementation of the Ethereum Bridge handle.

**`See`**

for reference.

## Hierarchy

- `EthersContractHandle`\<`BridgeTypechain`\>

  ↳ **`EthereumBridge`**

## Implements

- [`Bridge`](../interfaces/Bridge.md)

## Table of contents

### Constructors

- [constructor](EthereumBridge.md#constructor)

### Properties

- [\_deployedAtBlockNumber](EthereumBridge.md#_deployedatblocknumber)
- [\_instance](EthereumBridge.md#_instance)
- [\_totalRetryAttempts](EthereumBridge.md#_totalretryattempts)

### Methods

- [activeWalletPublicKey](EthereumBridge.md#activewalletpublickey)
- [buildUtxoHash](EthereumBridge.md#buildutxohash)
- [deposits](EthereumBridge.md#deposits)
- [getAddress](EthereumBridge.md#getaddress)
- [getChainIdentifier](EthereumBridge.md#getchainidentifier)
- [getDepositRevealedEvents](EthereumBridge.md#getdepositrevealedevents)
- [getEvents](EthereumBridge.md#getevents)
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

EthersContractHandle\&lt;BridgeTypechain\&gt;.constructor

#### Defined in

[src/lib/ethereum/bridge.ts:69](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L69)

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

• `Protected` `Readonly` **\_instance**: `Bridge`

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

### activeWalletPublicKey

▸ **activeWalletPublicKey**(): `Promise`\<`undefined` \| [`Hex`](Hex.md)\>

#### Returns

`Promise`\<`undefined` \| [`Hex`](Hex.md)\>

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[activeWalletPublicKey](../interfaces/Bridge.md#activewalletpublickey)

#### Defined in

[src/lib/ethereum/bridge.ts:519](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L519)

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

[src/lib/ethereum/bridge.ts:659](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L659)

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

[src/lib/ethereum/bridge.ts:454](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L454)

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

[Bridge](../interfaces/Bridge.md).[getChainIdentifier](../interfaces/Bridge.md#getchainidentifier)

#### Defined in

[src/lib/ethereum/bridge.ts:96](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L96)

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

[src/lib/ethereum/bridge.ts:104](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L104)

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

[src/lib/ethereum/bridge.ts:571](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L571)

___

### getRedemptionEvents

▸ **getRedemptionEvents**(`eventName`, `options?`, `...filterArgs`): `Promise`\<`Event`[]\>

Queries redemption lifecycle events with ABI-correct wallet topics.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `eventName` | ``"RedemptionRequested"`` \| ``"RedemptionTimedOut"`` \| ``"RedemptionsCompleted"`` | Name of the lifecycle event. |
| `options?` | [`Options`](../interfaces/GetChainEvents.Options.md) | Event query options. |
| `...filterArgs` | `unknown`[] | Indexed event filters. |

#### Returns

`Promise`\<`Event`[]\>

Matching events.

#### Defined in

[src/lib/ethereum/bridge.ts:750](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L750)

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

[src/lib/ethereum/bridge.ts:817](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L817)

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

[src/lib/ethereum/bridge.ts:718](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L718)

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

[src/lib/ethereum/bridge.ts:677](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L677)

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

[src/lib/ethereum/bridge.ts:692](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L692)

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

[src/lib/ethereum/bridge.ts:540](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L540)

___

### parseDepositRequest

▸ **parseDepositRequest**(`deposit`): [`DepositRequest`](../interfaces/DepositRequest.md)

Parses a deposit request using data fetched from the on-chain contract.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `deposit` | `DepositRequestStructOutput` | Data of the deposit request. |

#### Returns

[`DepositRequest`](../interfaces/DepositRequest.md)

Parsed deposit request.

#### Defined in

[src/lib/ethereum/bridge.ts:499](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L499)

___

### parseRedemptionRequest

▸ **parseRedemptionRequest**(`request`, `redeemerOutputScript`): [`RedemptionRequest`](../interfaces/RedemptionRequest.md)

Parses a redemption request using data fetched from the on-chain contract.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `request` | `RedemptionRequestStructOutput` | Data of the request. |
| `redeemerOutputScript` | [`Hex`](Hex.md) | The redeemer output script that identifies the pending redemption (along with the wallet public key hash). Must not be prepended with length. |

#### Returns

[`RedemptionRequest`](../interfaces/RedemptionRequest.md)

Parsed redemption request.

#### Defined in

[src/lib/ethereum/bridge.ts:240](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L240)

___

### parseWalletDetails

▸ **parseWalletDetails**(`wallet`): `Promise`\<[`Wallet`](../interfaces/Wallet.md)\>

Parses a wallet data using data fetched from the on-chain contract.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `wallet` | `WalletStructOutput` | Data of the wallet. |

#### Returns

`Promise`\<[`Wallet`](../interfaces/Wallet.md)\>

Parsed wallet data.

#### Defined in

[src/lib/ethereum/bridge.ts:630](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L630)

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

[src/lib/ethereum/bridge.ts:141](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L141)

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

[src/lib/ethereum/bridge.ts:156](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L156)

___

### requestRedemption

▸ **requestRedemption**(`walletPublicKey`, `mainUtxo`, `redeemerOutputScript`, `amount`): `Promise`\<[`Hex`](Hex.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `walletPublicKey` | [`Hex`](Hex.md) |
| `mainUtxo` | [`BitcoinUtxo`](../README.md#bitcoinutxo) |
| `redeemerOutputScript` | [`Hex`](Hex.md) |
| `amount` | `BigNumber` |

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

[src/lib/ethereum/bridge.ts:258](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L258)

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

[src/lib/ethereum/bridge.ts:295](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L295)

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

[src/lib/ethereum/bridge.ts:403](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L403)

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

[src/lib/ethereum/bridge.ts:182](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L182)

___

### txProofDifficultyFactor

▸ **txProofDifficultyFactor**(): `Promise`\<`number`\>

#### Returns

`Promise`\<`number`\>

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[txProofDifficultyFactor](../interfaces/Bridge.md#txproofdifficultyfactor)

#### Defined in

[src/lib/ethereum/bridge.ts:345](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L345)

___

### walletRegistry

▸ **walletRegistry**(): `Promise`\<[`WalletRegistry`](../interfaces/WalletRegistry.md)\>

#### Returns

`Promise`\<[`WalletRegistry`](../interfaces/WalletRegistry.md)\>

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[walletRegistry](../interfaces/Bridge.md#walletregistry)

#### Defined in

[src/lib/ethereum/bridge.ts:596](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L596)

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

[src/lib/ethereum/bridge.ts:613](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L613)

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

[src/lib/ethereum/bridge.ts:480](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L480)

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

[src/lib/ethereum/bridge.ts:210](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L210)
