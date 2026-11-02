# Class: ElectrumClient

Electrum-based implementation of the Bitcoin client.

## Implements

- [`BitcoinClient`](../interfaces/BitcoinClient.md)

## Table of contents

### Constructors

- [constructor](ElectrumClient.md#constructor)

### Properties

- [connectionTimeout](ElectrumClient.md#connectiontimeout)
- [credentials](ElectrumClient.md#credentials)
- [options](ElectrumClient.md#options)
- [retryBackoffStep](ElectrumClient.md#retrybackoffstep)
- [totalRetryAttempts](ElectrumClient.md#totalretryattempts)

### Methods

- [broadcast](ElectrumClient.md#broadcast)
- [findAllUnspentTransactionOutputs](ElectrumClient.md#findallunspenttransactionoutputs)
- [getCoinbaseTxHash](ElectrumClient.md#getcoinbasetxhash)
- [getHeadersChain](ElectrumClient.md#getheaderschain)
- [getNetwork](ElectrumClient.md#getnetwork)
- [getNetworkFromElectrum](ElectrumClient.md#getnetworkfromelectrum)
- [getRawTransaction](ElectrumClient.md#getrawtransaction)
- [getTransaction](ElectrumClient.md#gettransaction)
- [getTransactionConfirmations](ElectrumClient.md#gettransactionconfirmations)
- [getTransactionHistory](ElectrumClient.md#gettransactionhistory)
- [getTransactionMerkle](ElectrumClient.md#gettransactionmerkle)
- [getTxHashesForPublicKeyHash](ElectrumClient.md#gettxhashesforpublickeyhash)
- [latestBlockHeight](ElectrumClient.md#latestblockheight)
- [withBackoffRetrier](ElectrumClient.md#withbackoffretrier)
- [withElectrum](ElectrumClient.md#withelectrum)
- [fromDefaultConfig](ElectrumClient.md#fromdefaultconfig)
- [fromUrl](ElectrumClient.md#fromurl)
- [parseElectrumCredentials](ElectrumClient.md#parseelectrumcredentials)

## Constructors

### constructor

• **new ElectrumClient**(`credentials`, `options?`, `totalRetryAttempts?`, `retryBackoffStep?`, `connectionTimeout?`): [`ElectrumClient`](ElectrumClient.md)

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `credentials` | [`ElectrumCredentials`](../interfaces/ElectrumCredentials.md)[] | `undefined` |
| `options?` | `object` | `undefined` |
| `totalRetryAttempts` | `number` | `3` |
| `retryBackoffStep` | `number` | `10000` |
| `connectionTimeout` | `number` | `20000` |

#### Returns

[`ElectrumClient`](ElectrumClient.md)

#### Defined in

[lib/electrum/client.ts:73](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L73)

## Properties

### connectionTimeout

• `Private` **connectionTimeout**: `number`

#### Defined in

[lib/electrum/client.ts:71](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L71)

___

### credentials

• `Private` **credentials**: [`ElectrumCredentials`](../interfaces/ElectrumCredentials.md)[]

#### Defined in

[lib/electrum/client.ts:67](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L67)

___

### options

• `Private` `Optional` **options**: `object`

#### Defined in

[lib/electrum/client.ts:68](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L68)

___

### retryBackoffStep

• `Private` **retryBackoffStep**: `number`

#### Defined in

[lib/electrum/client.ts:70](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L70)

___

### totalRetryAttempts

• `Private` **totalRetryAttempts**: `number`

#### Defined in

[lib/electrum/client.ts:69](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L69)

## Methods

### broadcast

▸ **broadcast**(`transaction`): `Promise`\<`void`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `transaction` | [`BitcoinRawTx`](../interfaces/BitcoinRawTx.md) |

#### Returns

`Promise`\<`void`\>

**`See`**

#### Implementation of

[BitcoinClient](../interfaces/BitcoinClient.md).[broadcast](../interfaces/BitcoinClient.md#broadcast)

#### Defined in

[lib/electrum/client.ts:716](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L716)

___

### findAllUnspentTransactionOutputs

▸ **findAllUnspentTransactionOutputs**(`address`): `Promise`\<[`BitcoinUtxo`](../README.md#bitcoinutxo)[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `address` | `string` |

#### Returns

`Promise`\<[`BitcoinUtxo`](../README.md#bitcoinutxo)[]\>

**`See`**

#### Implementation of

[BitcoinClient](../interfaces/BitcoinClient.md).[findAllUnspentTransactionOutputs](../interfaces/BitcoinClient.md#findallunspenttransactionoutputs)

#### Defined in

[lib/electrum/client.ts:341](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L341)

___

### getCoinbaseTxHash

▸ **getCoinbaseTxHash**(`blockHeight`): `Promise`\<[`BitcoinTxHash`](BitcoinTxHash.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `blockHeight` | `number` |

#### Returns

`Promise`\<[`BitcoinTxHash`](BitcoinTxHash.md)\>

**`See`**

#### Implementation of

[BitcoinClient](../interfaces/BitcoinClient.md).[getCoinbaseTxHash](../interfaces/BitcoinClient.md#getcoinbasetxhash)

#### Defined in

[lib/electrum/client.ts:730](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L730)

___

### getHeadersChain

▸ **getHeadersChain**(`blockHeight`, `chainLength`): `Promise`\<[`Hex`](Hex.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `blockHeight` | `number` |
| `chainLength` | `number` |

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

**`See`**

#### Implementation of

[BitcoinClient](../interfaces/BitcoinClient.md).[getHeadersChain](../interfaces/BitcoinClient.md#getheaderschain)

#### Defined in

[lib/electrum/client.ts:666](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L666)

___

### getNetwork

▸ **getNetwork**(): `Promise`\<[`BitcoinNetwork`](../enums/BitcoinNetwork-1.md)\>

#### Returns

`Promise`\<[`BitcoinNetwork`](../enums/BitcoinNetwork-1.md)\>

**`See`**

#### Implementation of

[BitcoinClient](../interfaces/BitcoinClient.md).[getNetwork](../interfaces/BitcoinClient.md#getnetwork)

#### Defined in

[lib/electrum/client.ts:331](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L331)

___

### getNetworkFromElectrum

▸ **getNetworkFromElectrum**(`electrum`): `Promise`\<[`BitcoinNetwork`](../enums/BitcoinNetwork-1.md)\>

Resolves Bitcoin network from an existing Electrum connection.
Use this when already inside withElectrum to avoid nested connections.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `electrum` | `any` | Connected Electrum client. |

#### Returns

`Promise`\<[`BitcoinNetwork`](../enums/BitcoinNetwork-1.md)\>

Promise resolving to the Bitcoin network.

#### Defined in

[lib/electrum/client.ts:278](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L278)

___

### getRawTransaction

▸ **getRawTransaction**(`transactionHash`): `Promise`\<[`BitcoinRawTx`](../interfaces/BitcoinRawTx.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `transactionHash` | [`BitcoinTxHash`](BitcoinTxHash.md) |

#### Returns

`Promise`\<[`BitcoinRawTx`](../interfaces/BitcoinRawTx.md)\>

**`See`**

#### Implementation of

[BitcoinClient](../interfaces/BitcoinClient.md).[getRawTransaction](../interfaces/BitcoinClient.md#getrawtransaction)

#### Defined in

[lib/electrum/client.ts:479](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L479)

___

### getTransaction

▸ **getTransaction**(`transactionHash`): `Promise`\<[`BitcoinTx`](../interfaces/BitcoinTx.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `transactionHash` | [`BitcoinTxHash`](BitcoinTxHash.md) |

#### Returns

`Promise`\<[`BitcoinTx`](../interfaces/BitcoinTx.md)\>

**`See`**

#### Implementation of

[BitcoinClient](../interfaces/BitcoinClient.md).[getTransaction](../interfaces/BitcoinClient.md#gettransaction)

#### Defined in

[lib/electrum/client.ts:429](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L429)

___

### getTransactionConfirmations

▸ **getTransactionConfirmations**(`transactionHash`): `Promise`\<`number`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `transactionHash` | [`BitcoinTxHash`](BitcoinTxHash.md) |

#### Returns

`Promise`\<`number`\>

**`See`**

#### Implementation of

[BitcoinClient](../interfaces/BitcoinClient.md).[getTransactionConfirmations](../interfaces/BitcoinClient.md#gettransactionconfirmations)

#### Defined in

[lib/electrum/client.ts:500](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L500)

___

### getTransactionHistory

▸ **getTransactionHistory**(`address`, `limit?`): `Promise`\<[`BitcoinTx`](../interfaces/BitcoinTx.md)[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `address` | `string` |
| `limit?` | `number` |

#### Returns

`Promise`\<[`BitcoinTx`](../interfaces/BitcoinTx.md)[]\>

**`See`**

#### Implementation of

[BitcoinClient](../interfaces/BitcoinClient.md).[getTransactionHistory](../interfaces/BitcoinClient.md#gettransactionhistory)

#### Defined in

[lib/electrum/client.ts:372](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L372)

___

### getTransactionMerkle

▸ **getTransactionMerkle**(`transactionHash`, `blockHeight`): `Promise`\<[`BitcoinTxMerkleBranch`](../interfaces/BitcoinTxMerkleBranch.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `transactionHash` | [`BitcoinTxHash`](BitcoinTxHash.md) |
| `blockHeight` | `number` |

#### Returns

`Promise`\<[`BitcoinTxMerkleBranch`](../interfaces/BitcoinTxMerkleBranch.md)\>

**`See`**

#### Implementation of

[BitcoinClient](../interfaces/BitcoinClient.md).[getTransactionMerkle](../interfaces/BitcoinClient.md#gettransactionmerkle)

#### Defined in

[lib/electrum/client.ts:685](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L685)

___

### getTxHashesForPublicKeyHash

▸ **getTxHashesForPublicKeyHash**(`publicKeyHash`): `Promise`\<[`BitcoinTxHash`](BitcoinTxHash.md)[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `publicKeyHash` | [`Hex`](Hex.md) |

#### Returns

`Promise`\<[`BitcoinTxHash`](BitcoinTxHash.md)[]\>

**`See`**

#### Implementation of

[BitcoinClient](../interfaces/BitcoinClient.md).[getTxHashesForPublicKeyHash](../interfaces/BitcoinClient.md#gettxhashesforpublickeyhash)

#### Defined in

[lib/electrum/client.ts:592](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L592)

___

### latestBlockHeight

▸ **latestBlockHeight**(): `Promise`\<`number`\>

#### Returns

`Promise`\<`number`\>

**`See`**

#### Implementation of

[BitcoinClient](../interfaces/BitcoinClient.md).[latestBlockHeight](../interfaces/BitcoinClient.md#latestblockheight)

#### Defined in

[lib/electrum/client.ts:650](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L650)

___

### withBackoffRetrier

▸ **withBackoffRetrier**\<`T`\>(): [`RetrierFn`](../README.md#retrierfn)\<`T`\>

Initiates a backoff retrier.

#### Type parameters

| Name |
| :------ |
| `T` |

#### Returns

[`RetrierFn`](../README.md#retrierfn)\<`T`\>

A function that can retry any function.

#### Defined in

[lib/electrum/client.ts:268](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L268)

___

### withElectrum

▸ **withElectrum**\<`T`\>(`action`): `Promise`\<`T`\>

Initiates an Electrum connection and uses it to feed the given action.
Closes the connection regardless of the action outcome.

#### Type parameters

| Name |
| :------ |
| `T` |

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `action` | `ElectrumAction`\<`T`\> | Action that makes use of the Electrum connection. |

#### Returns

`Promise`\<`T`\>

Promise holding the outcome.

#### Defined in

[lib/electrum/client.ts:189](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L189)

___

### fromDefaultConfig

▸ **fromDefaultConfig**(`network`): [`ElectrumClient`](ElectrumClient.md)

Creates an Electrum client instance using a default config for the given
Bitcoin network.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `network` | [`BitcoinNetwork`](../enums/BitcoinNetwork-1.md) | Bitcoin network the instance should be created for. |

#### Returns

[`ElectrumClient`](ElectrumClient.md)

Electrum client instance.

#### Defined in

[lib/electrum/client.ts:128](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L128)

___

### fromUrl

▸ **fromUrl**(`url`, `options?`, `totalRetryAttempts?`, `retryBackoffStep?`, `connectionTimeout?`): [`ElectrumClient`](ElectrumClient.md)

Creates an Electrum client instance from a URL.

#### Parameters

| Name | Type | Default value | Description |
| :------ | :------ | :------ | :------ |
| `url` | `string` \| `string`[] | `undefined` | Connection URL or list of URLs. |
| `options?` | `object` | `undefined` | Additional options used by the Electrum server. |
| `totalRetryAttempts` | `number` | `3` | Number of retries for requests sent to Electrum server. |
| `retryBackoffStep` | `number` | `1000` | Initial backoff duration in milliseconds; increases exponentially for subsequent retry attempts (default 1000). The instance constructor defaults this to 10000 ms when not using [fromUrl](ElectrumClient.md#fromurl). |
| `connectionTimeout` | `number` | `20000` | Timeout in milliseconds for connection establishment per try. |

#### Returns

[`ElectrumClient`](ElectrumClient.md)

Electrum client instance.

#### Defined in

[lib/electrum/client.ts:99](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L99)

___

### parseElectrumCredentials

▸ **parseElectrumCredentials**(`url`): [`ElectrumCredentials`](../interfaces/ElectrumCredentials.md)

Create Electrum credentials by parsing an URL.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `url` | `string` | URL to be parsed. |

#### Returns

[`ElectrumCredentials`](../interfaces/ElectrumCredentials.md)

Electrum credentials object.

#### Defined in

[lib/electrum/client.ts:147](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L147)
