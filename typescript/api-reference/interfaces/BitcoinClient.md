# Interface: BitcoinClient

Represents a Bitcoin client.

## Implemented by

- [`ElectrumClient`](../classes/ElectrumClient.md)

## Table of contents

### Methods

- [broadcast](BitcoinClient.md#broadcast)
- [findAllUnspentTransactionOutputs](BitcoinClient.md#findallunspenttransactionoutputs)
- [getCoinbaseTxHash](BitcoinClient.md#getcoinbasetxhash)
- [getHeadersChain](BitcoinClient.md#getheaderschain)
- [getNetwork](BitcoinClient.md#getnetwork)
- [getRawTransaction](BitcoinClient.md#getrawtransaction)
- [getTransaction](BitcoinClient.md#gettransaction)
- [getTransactionConfirmations](BitcoinClient.md#gettransactionconfirmations)
- [getTransactionHistory](BitcoinClient.md#gettransactionhistory)
- [getTransactionMerkle](BitcoinClient.md#gettransactionmerkle)
- [getTxHashesForPublicKeyHash](BitcoinClient.md#gettxhashesforpublickeyhash)
- [latestBlockHeight](BitcoinClient.md#latestblockheight)

## Methods

### broadcast

▸ **broadcast**(`transaction`): `Promise`\<`void`\>

Broadcasts the given transaction over the network.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `transaction` | [`BitcoinRawTx`](BitcoinRawTx.md) | Transaction to broadcast. |

#### Returns

`Promise`\<`void`\>

#### Defined in

[lib/bitcoin/client.ts:103](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/client.ts#L103)

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

#### Defined in

[lib/bitcoin/client.ts:23](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/client.ts#L23)

___

### getCoinbaseTxHash

▸ **getCoinbaseTxHash**(`blockHeight`): `Promise`\<[`BitcoinTxHash`](../classes/BitcoinTxHash.md)\>

Gets the hash of the coinbase transaction for the given block height.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `blockHeight` | `number` | Height of the block. |

#### Returns

`Promise`\<[`BitcoinTxHash`](../classes/BitcoinTxHash.md)\>

#### Defined in

[lib/bitcoin/client.ts:109](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/client.ts#L109)

___

### getHeadersChain

▸ **getHeadersChain**(`blockHeight`, `chainLength`): `Promise`\<[`Hex`](../classes/Hex.md)\>

Gets concatenated chunk of block headers built on a starting block.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `blockHeight` | `number` | Starting block height. |
| `chainLength` | `number` | Number of subsequent blocks built on the starting block. |

#### Returns

`Promise`\<[`Hex`](../classes/Hex.md)\>

Concatenation of block headers in a hexadecimal format.

#### Defined in

[lib/bitcoin/client.ts:86](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/client.ts#L86)

___

### getNetwork

▸ **getNetwork**(): `Promise`\<[`BitcoinNetwork`](../enums/BitcoinNetwork-1.md)\>

Gets the network supported by the server the client connected to.

#### Returns

`Promise`\<[`BitcoinNetwork`](../enums/BitcoinNetwork-1.md)\>

Bitcoin network.

#### Defined in

[lib/bitcoin/client.ts:14](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/client.ts#L14)

___

### getRawTransaction

▸ **getRawTransaction**(`transactionHash`): `Promise`\<[`BitcoinRawTx`](BitcoinRawTx.md)\>

Gets the raw transaction data for given transaction hash.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `transactionHash` | [`BitcoinTxHash`](../classes/BitcoinTxHash.md) | Hash of the transaction. |

#### Returns

`Promise`\<[`BitcoinRawTx`](BitcoinRawTx.md)\>

Raw transaction.

#### Defined in

[lib/bitcoin/client.ts:49](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/client.ts#L49)

___

### getTransaction

▸ **getTransaction**(`transactionHash`): `Promise`\<[`BitcoinTx`](BitcoinTx.md)\>

Gets the full transaction object for given transaction hash.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `transactionHash` | [`BitcoinTxHash`](../classes/BitcoinTxHash.md) | Hash of the transaction. |

#### Returns

`Promise`\<[`BitcoinTx`](BitcoinTx.md)\>

Transaction object.

#### Defined in

[lib/bitcoin/client.ts:42](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/client.ts#L42)

___

### getTransactionConfirmations

▸ **getTransactionConfirmations**(`transactionHash`): `Promise`\<`number`\>

Gets the number of confirmations that a given transaction has accumulated
so far.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `transactionHash` | [`BitcoinTxHash`](../classes/BitcoinTxHash.md) | Hash of the transaction. |

#### Returns

`Promise`\<`number`\>

The number of confirmations.

#### Defined in

[lib/bitcoin/client.ts:57](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/client.ts#L57)

___

### getTransactionHistory

▸ **getTransactionHistory**(`address`, `limit?`): `Promise`\<[`BitcoinTx`](BitcoinTx.md)[]\>

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

`Promise`\<[`BitcoinTx`](BitcoinTx.md)[]\>

#### Defined in

[lib/bitcoin/client.ts:35](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/client.ts#L35)

___

### getTransactionMerkle

▸ **getTransactionMerkle**(`transactionHash`, `blockHeight`): `Promise`\<[`BitcoinTxMerkleBranch`](BitcoinTxMerkleBranch.md)\>

Get Merkle branch for a given transaction.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `transactionHash` | [`BitcoinTxHash`](../classes/BitcoinTxHash.md) | Hash of a transaction. |
| `blockHeight` | `number` | Height of the block where transaction was confirmed. |

#### Returns

`Promise`\<[`BitcoinTxMerkleBranch`](BitcoinTxMerkleBranch.md)\>

Merkle branch.

#### Defined in

[lib/bitcoin/client.ts:94](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/client.ts#L94)

___

### getTxHashesForPublicKeyHash

▸ **getTxHashesForPublicKeyHash**(`publicKeyHash`): `Promise`\<[`BitcoinTxHash`](../classes/BitcoinTxHash.md)[]\>

Gets hashes of confirmed transactions that pay the given public key hash
using either a P2PKH or P2WPKH script. The returned transactions hashes are
ordered by block height in the ascending order, i.e. the latest transaction
hash is at the end of the list. The returned list does not contain
unconfirmed transactions hashes living in the mempool at the moment of
request.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `publicKeyHash` | [`Hex`](../classes/Hex.md) | Hash of the public key for which to find corresponding transaction hashes. |

#### Returns

`Promise`\<[`BitcoinTxHash`](../classes/BitcoinTxHash.md)[]\>

Array of confirmed transaction hashes related to the provided
         public key hash.

#### Defined in

[lib/bitcoin/client.ts:71](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/client.ts#L71)

___

### latestBlockHeight

▸ **latestBlockHeight**(): `Promise`\<`number`\>

Gets height of the latest mined block.

#### Returns

`Promise`\<`number`\>

Height of the last mined block.

#### Defined in

[lib/bitcoin/client.ts:77](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/client.ts#L77)
