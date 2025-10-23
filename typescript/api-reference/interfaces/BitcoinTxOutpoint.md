# Interface: BitcoinTxOutpoint

Data about a Bitcoin transaction outpoint.

## Table of contents

### Properties

- [outputIndex](BitcoinTxOutpoint.md#outputindex)
- [transactionHash](BitcoinTxOutpoint.md#transactionhash)

## Properties

### outputIndex

• **outputIndex**: `number`

The zero-based index of the output from the specified transaction.

#### Defined in

[lib/bitcoin/tx.ts:57](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/tx.ts#L57)

___

### transactionHash

• **transactionHash**: [`BitcoinTxHash`](../classes/BitcoinTxHash.md)

The hash of the transaction the outpoint belongs to.

#### Defined in

[lib/bitcoin/tx.ts:52](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/tx.ts#L52)
