# Interface: BitcoinSpvProof

Data required to perform a proof that a given transaction was included in
the Bitcoin blockchain.

## Table of contents

### Properties

- [bitcoinHeaders](BitcoinSpvProof.md#bitcoinheaders)
- [coinbasePreimage](BitcoinSpvProof.md#coinbasepreimage)
- [coinbaseProof](BitcoinSpvProof.md#coinbaseproof)
- [merkleProof](BitcoinSpvProof.md#merkleproof)
- [txIndexInBlock](BitcoinSpvProof.md#txindexinblock)

## Properties

### bitcoinHeaders

• **bitcoinHeaders**: [`Hex`](../classes/Hex.md)

Concatenated block headers in hexadecimal format. Each block header is
80-byte-long. The block header with the lowest height is first.

#### Defined in

[lib/bitcoin/spv.ts:31](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/spv.ts#L31)

___

### coinbasePreimage

• **coinbasePreimage**: [`Hex`](../classes/Hex.md)

The sha256 preimage of the coinbase transaction hash i.e.,
the sha256 hash of the coinbase transaction.

#### Defined in

[lib/bitcoin/spv.ts:37](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/spv.ts#L37)

___

### coinbaseProof

• **coinbaseProof**: [`Hex`](../classes/Hex.md)

Merkle proof of coinbase transaction inclusion in a block.

#### Defined in

[lib/bitcoin/spv.ts:42](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/spv.ts#L42)

___

### merkleProof

• **merkleProof**: [`Hex`](../classes/Hex.md)

The merkle proof of transaction inclusion in a block.

#### Defined in

[lib/bitcoin/spv.ts:20](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/spv.ts#L20)

___

### txIndexInBlock

• **txIndexInBlock**: `number`

Transaction index in the block (0-indexed).

#### Defined in

[lib/bitcoin/spv.ts:25](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/spv.ts#L25)
