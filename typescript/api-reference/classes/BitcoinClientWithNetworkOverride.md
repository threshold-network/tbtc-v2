# Class: BitcoinClientWithNetworkOverride

Wraps a BitcoinClient and overrides getNetwork() to return a fixed value
without connecting. Use when the network is known (e.g. Sepolia → testnet4)
and Electrum may be unreachable for the initial address-generation step.

## Implements

- [`BitcoinClient`](../interfaces/BitcoinClient.md)

## Table of contents

### Constructors

- [constructor](BitcoinClientWithNetworkOverride.md#constructor)

### Properties

- [delegate](BitcoinClientWithNetworkOverride.md#delegate)
- [networkOverride](BitcoinClientWithNetworkOverride.md#networkoverride)

### Methods

- [broadcast](BitcoinClientWithNetworkOverride.md#broadcast)
- [findAllUnspentTransactionOutputs](BitcoinClientWithNetworkOverride.md#findallunspenttransactionoutputs)
- [getCoinbaseTxHash](BitcoinClientWithNetworkOverride.md#getcoinbasetxhash)
- [getHeadersChain](BitcoinClientWithNetworkOverride.md#getheaderschain)
- [getNetwork](BitcoinClientWithNetworkOverride.md#getnetwork)
- [getRawTransaction](BitcoinClientWithNetworkOverride.md#getrawtransaction)
- [getTransaction](BitcoinClientWithNetworkOverride.md#gettransaction)
- [getTransactionConfirmations](BitcoinClientWithNetworkOverride.md#gettransactionconfirmations)
- [getTransactionHistory](BitcoinClientWithNetworkOverride.md#gettransactionhistory)
- [getTransactionMerkle](BitcoinClientWithNetworkOverride.md#gettransactionmerkle)
- [getTxHashesForPublicKeyHash](BitcoinClientWithNetworkOverride.md#gettxhashesforpublickeyhash)
- [latestBlockHeight](BitcoinClientWithNetworkOverride.md#latestblockheight)

## Constructors

### constructor

• **new BitcoinClientWithNetworkOverride**(`delegate`, `networkOverride`): [`BitcoinClientWithNetworkOverride`](BitcoinClientWithNetworkOverride.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `delegate` | [`BitcoinClient`](../interfaces/BitcoinClient.md) |
| `networkOverride` | [`BitcoinNetwork`](../enums/BitcoinNetwork-1.md) |

#### Returns

[`BitcoinClientWithNetworkOverride`](BitcoinClientWithNetworkOverride.md)

#### Defined in

[lib/bitcoin/client-with-network-override.ts:13](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/client-with-network-override.ts#L13)

## Properties

### delegate

• `Private` `Readonly` **delegate**: [`BitcoinClient`](../interfaces/BitcoinClient.md)

#### Defined in

[lib/bitcoin/client-with-network-override.ts:14](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/client-with-network-override.ts#L14)

___

### networkOverride

• `Private` `Readonly` **networkOverride**: [`BitcoinNetwork`](../enums/BitcoinNetwork-1.md)

#### Defined in

[lib/bitcoin/client-with-network-override.ts:15](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/client-with-network-override.ts#L15)

## Methods

### broadcast

▸ **broadcast**(`transaction`): `Promise`\<`void`\>

Broadcasts the given transaction over the network.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `transaction` | [`BitcoinRawTx`](../interfaces/BitcoinRawTx.md) | Transaction to broadcast. |

#### Returns

`Promise`\<`void`\>

#### Implementation of

[BitcoinClient](../interfaces/BitcoinClient.md).[broadcast](../interfaces/BitcoinClient.md#broadcast)

#### Defined in

[lib/bitcoin/client-with-network-override.ts:61](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/client-with-network-override.ts#L61)

___

### findAllUnspentTransactionOutputs

▸ **findAllUnspentTransactionOutputs**(`address`): `Promise`\<[`BitcoinUtxo`](../README.md#bitcoinutxo)[]\>

Finds all unspent transaction outputs (UTXOs) for given Bitcoin address.
The list includes UTXOs from both the blockchain and the mempool, sorted by
age with the newest ones first. Mempool UTXOs are listed at the beginning.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `address` | `string` | Bitcoin address UTXOs should be determined for. |

#### Returns

`Promise`\<[`BitcoinUtxo`](../README.md#bitcoinutxo)[]\>

List of UTXOs.

#### Implementation of

[BitcoinClient](../interfaces/BitcoinClient.md).[findAllUnspentTransactionOutputs](../interfaces/BitcoinClient.md#findallunspenttransactionoutputs)

#### Defined in

[lib/bitcoin/client-with-network-override.ts:22](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/client-with-network-override.ts#L22)

___

### getCoinbaseTxHash

▸ **getCoinbaseTxHash**(`blockHeight`): `Promise`\<[`BitcoinTxHash`](BitcoinTxHash.md)\>

Gets the hash of the coinbase transaction for the given block height.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `blockHeight` | `number` | Height of the block. |

#### Returns

`Promise`\<[`BitcoinTxHash`](BitcoinTxHash.md)\>

#### Implementation of

[BitcoinClient](../interfaces/BitcoinClient.md).[getCoinbaseTxHash](../interfaces/BitcoinClient.md#getcoinbasetxhash)

#### Defined in

[lib/bitcoin/client-with-network-override.ts:65](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/client-with-network-override.ts#L65)

___

### getHeadersChain

▸ **getHeadersChain**(`blockHeight`, `chainLength`): `Promise`\<[`Hex`](Hex.md)\>

Gets concatenated chunk of block headers built on a starting block.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `blockHeight` | `number` | Starting block height. |
| `chainLength` | `number` | Number of subsequent blocks built on the starting block. |

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

Concatenation of block headers in a hexadecimal format.

#### Implementation of

[BitcoinClient](../interfaces/BitcoinClient.md).[getHeadersChain](../interfaces/BitcoinClient.md#getheaderschain)

#### Defined in

[lib/bitcoin/client-with-network-override.ts:50](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/client-with-network-override.ts#L50)

___

### getNetwork

▸ **getNetwork**(): `Promise`\<[`BitcoinNetwork`](../enums/BitcoinNetwork-1.md)\>

Gets the network supported by the server the client connected to.

#### Returns

`Promise`\<[`BitcoinNetwork`](../enums/BitcoinNetwork-1.md)\>

Bitcoin network.

#### Implementation of

[BitcoinClient](../interfaces/BitcoinClient.md).[getNetwork](../interfaces/BitcoinClient.md#getnetwork)

#### Defined in

[lib/bitcoin/client-with-network-override.ts:18](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/client-with-network-override.ts#L18)

___

### getRawTransaction

▸ **getRawTransaction**(`transactionHash`): `Promise`\<[`BitcoinRawTx`](../interfaces/BitcoinRawTx.md)\>

Gets the raw transaction data for given transaction hash.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `transactionHash` | [`BitcoinTxHash`](BitcoinTxHash.md) | Hash of the transaction. |

#### Returns

`Promise`\<[`BitcoinRawTx`](../interfaces/BitcoinRawTx.md)\>

Raw transaction.

#### Implementation of

[BitcoinClient](../interfaces/BitcoinClient.md).[getRawTransaction](../interfaces/BitcoinClient.md#getrawtransaction)

#### Defined in

[lib/bitcoin/client-with-network-override.ts:34](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/client-with-network-override.ts#L34)

___

### getTransaction

▸ **getTransaction**(`transactionHash`): `Promise`\<[`BitcoinTx`](../interfaces/BitcoinTx.md)\>

Gets the full transaction object for given transaction hash.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `transactionHash` | [`BitcoinTxHash`](BitcoinTxHash.md) | Hash of the transaction. |

#### Returns

`Promise`\<[`BitcoinTx`](../interfaces/BitcoinTx.md)\>

Transaction object.

#### Implementation of

[BitcoinClient](../interfaces/BitcoinClient.md).[getTransaction](../interfaces/BitcoinClient.md#gettransaction)

#### Defined in

[lib/bitcoin/client-with-network-override.ts:30](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/client-with-network-override.ts#L30)

___

### getTransactionConfirmations

▸ **getTransactionConfirmations**(`transactionHash`): `Promise`\<`number`\>

Gets the number of confirmations that a given transaction has accumulated
so far.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `transactionHash` | [`BitcoinTxHash`](BitcoinTxHash.md) | Hash of the transaction. |

#### Returns

`Promise`\<`number`\>

The number of confirmations.

#### Implementation of

[BitcoinClient](../interfaces/BitcoinClient.md).[getTransactionConfirmations](../interfaces/BitcoinClient.md#gettransactionconfirmations)

#### Defined in

[lib/bitcoin/client-with-network-override.ts:38](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/client-with-network-override.ts#L38)

___

### getTransactionHistory

▸ **getTransactionHistory**(`address`, `limit?`): `Promise`\<[`BitcoinTx`](../interfaces/BitcoinTx.md)[]\>

Gets the history of confirmed transactions for given Bitcoin address.
Returned transactions are sorted from oldest to newest. The returned
result does not contain unconfirmed transactions living in the mempool
at the moment of request.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `address` | `string` | Bitcoin address transaction history should be determined for. |
| `limit?` | `number` | Optional parameter that can limit the resulting list to a specific number of last transaction. For example, limit = 5 will return only the last 5 transactions for the given address. |

#### Returns

`Promise`\<[`BitcoinTx`](../interfaces/BitcoinTx.md)[]\>

#### Implementation of

[BitcoinClient](../interfaces/BitcoinClient.md).[getTransactionHistory](../interfaces/BitcoinClient.md#gettransactionhistory)

#### Defined in

[lib/bitcoin/client-with-network-override.ts:26](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/client-with-network-override.ts#L26)

___

### getTransactionMerkle

▸ **getTransactionMerkle**(`transactionHash`, `blockHeight`): `Promise`\<[`BitcoinTxMerkleBranch`](../interfaces/BitcoinTxMerkleBranch.md)\>

Get Merkle branch for a given transaction.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `transactionHash` | [`BitcoinTxHash`](BitcoinTxHash.md) | Hash of a transaction. |
| `blockHeight` | `number` | Height of the block where transaction was confirmed. |

#### Returns

`Promise`\<[`BitcoinTxMerkleBranch`](../interfaces/BitcoinTxMerkleBranch.md)\>

Merkle branch.

#### Implementation of

[BitcoinClient](../interfaces/BitcoinClient.md).[getTransactionMerkle](../interfaces/BitcoinClient.md#gettransactionmerkle)

#### Defined in

[lib/bitcoin/client-with-network-override.ts:54](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/client-with-network-override.ts#L54)

___

### getTxHashesForPublicKeyHash

▸ **getTxHashesForPublicKeyHash**(`publicKeyHash`): `Promise`\<[`BitcoinTxHash`](BitcoinTxHash.md)[]\>

Gets hashes of confirmed transactions that pay the given public key hash
using either a P2PKH or P2WPKH script. The returned transactions hashes are
ordered by block height in the ascending order, i.e. the latest transaction
hash is at the end of the list. The returned list does not contain
unconfirmed transactions hashes living in the mempool at the moment of
request.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `publicKeyHash` | [`Hex`](Hex.md) | Hash of the public key for which to find corresponding transaction hashes. |

#### Returns

`Promise`\<[`BitcoinTxHash`](BitcoinTxHash.md)[]\>

Array of confirmed transaction hashes related to the provided
         public key hash.

#### Implementation of

[BitcoinClient](../interfaces/BitcoinClient.md).[getTxHashesForPublicKeyHash](../interfaces/BitcoinClient.md#gettxhashesforpublickeyhash)

#### Defined in

[lib/bitcoin/client-with-network-override.ts:42](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/client-with-network-override.ts#L42)

___

### latestBlockHeight

▸ **latestBlockHeight**(): `Promise`\<`number`\>

Gets height of the latest mined block.

#### Returns

`Promise`\<`number`\>

Height of the last mined block.

#### Implementation of

[BitcoinClient](../interfaces/BitcoinClient.md).[latestBlockHeight](../interfaces/BitcoinClient.md#latestblockheight)

#### Defined in

[lib/bitcoin/client-with-network-override.ts:46](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/client-with-network-override.ts#L46)
