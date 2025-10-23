# Interface: BitcoinTxMerkleBranch

Information about the merkle branch to a confirmed transaction.

## Table of contents

### Properties

- [blockHeight](BitcoinTxMerkleBranch.md#blockheight)
- [merkle](BitcoinTxMerkleBranch.md#merkle)
- [position](BitcoinTxMerkleBranch.md#position)

## Properties

### blockHeight

• **blockHeight**: `number`

The height of the block the transaction was confirmed in.

#### Defined in

[lib/bitcoin/spv.ts:52](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/spv.ts#L52)

___

### merkle

• **merkle**: [`Hex`](../classes/Hex.md)[]

A list of transaction hashes the current hash is paired with, recursively,
in order to trace up to obtain the merkle root of the including block,
the deepest pairing first. Each hash is an unprefixed hex string.

#### Defined in

[lib/bitcoin/spv.ts:59](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/spv.ts#L59)

___

### position

• **position**: `number`

The 0-based index of the transaction's position in the block.

#### Defined in

[lib/bitcoin/spv.ts:64](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/spv.ts#L64)
