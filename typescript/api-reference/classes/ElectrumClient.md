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

[lib/electrum/client.ts:77](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L77)

## Properties

### connectionTimeout

• `Private` **connectionTimeout**: `number`

#### Defined in

[lib/electrum/client.ts:75](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L75)

___

### credentials

• `Private` **credentials**: [`ElectrumCredentials`](../interfaces/ElectrumCredentials.md)[]

#### Defined in

[lib/electrum/client.ts:71](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L71)

___

### options

• `Private` `Optional` **options**: `object`

#### Defined in

[lib/electrum/client.ts:72](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L72)

___

### retryBackoffStep

• `Private` **retryBackoffStep**: `number`

#### Defined in

[lib/electrum/client.ts:74](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L74)

___

### totalRetryAttempts

• `Private` **totalRetryAttempts**: `number`

#### Defined in

[lib/electrum/client.ts:73](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L73)

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

[lib/electrum/client.ts:661](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L661)

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

[lib/electrum/client.ts:289](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L289)

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

[lib/electrum/client.ts:675](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L675)

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

[lib/electrum/client.ts:611](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L611)

___

### getNetwork

▸ **getNetwork**(): `Promise`\<[`BitcoinNetwork`](../enums/BitcoinNetwork-1.md)\>

#### Returns

`Promise`\<[`BitcoinNetwork`](../enums/BitcoinNetwork-1.md)\>

**`See`**

#### Implementation of

[BitcoinClient](../interfaces/BitcoinClient.md).[getNetwork](../interfaces/BitcoinClient.md#getnetwork)

#### Defined in

[lib/electrum/client.ts:267](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L267)

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

[lib/electrum/client.ts:424](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L424)

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

[lib/electrum/client.ts:374](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L374)

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

[lib/electrum/client.ts:445](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L445)

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

[lib/electrum/client.ts:320](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L320)

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

[lib/electrum/client.ts:630](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L630)

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

[lib/electrum/client.ts:537](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L537)

___

### latestBlockHeight

▸ **latestBlockHeight**(): `Promise`\<`number`\>

#### Returns

`Promise`\<`number`\>

**`See`**

#### Implementation of

[BitcoinClient](../interfaces/BitcoinClient.md).[latestBlockHeight](../interfaces/BitcoinClient.md#latestblockheight)

#### Defined in

[lib/electrum/client.ts:595](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L595)

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

[lib/electrum/client.ts:259](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L259)

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

[lib/electrum/client.ts:194](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L194)

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

[lib/electrum/client.ts:131](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L131)

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
| `retryBackoffStep` | `number` | `1000` | Initial backoff step in milliseconds that will be increased exponentially for subsequent retry attempts. |
| `connectionTimeout` | `number` | `20000` | Timeout for a single try of connection establishment. |

#### Returns

[`ElectrumClient`](ElectrumClient.md)

Electrum client instance.

#### Defined in

[lib/electrum/client.ts:102](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L102)

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

[lib/electrum/client.ts:152](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L152)
