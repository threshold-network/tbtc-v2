# Interface: BitcoinTx

Data about a Bitcoin transaction.

## Table of contents

### Properties

- [inputs](BitcoinTx.md#inputs)
- [outputs](BitcoinTx.md#outputs)
- [transactionHash](BitcoinTx.md#transactionhash)

## Properties

### inputs

• **inputs**: [`BitcoinTxInput`](../README.md#bitcointxinput)[]

The vector of transaction inputs.

#### Defined in

[lib/bitcoin/tx.ts:37](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/tx.ts#L37)

___

### outputs

• **outputs**: [`BitcoinTxOutput`](BitcoinTxOutput.md)[]

The vector of transaction outputs.

#### Defined in

[lib/bitcoin/tx.ts:42](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/tx.ts#L42)

___

### transactionHash

• **transactionHash**: [`BitcoinTxHash`](../classes/BitcoinTxHash.md)

The transaction hash (or transaction ID) as an un-prefixed hex string.

#### Defined in

[lib/bitcoin/tx.ts:32](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/tx.ts#L32)
