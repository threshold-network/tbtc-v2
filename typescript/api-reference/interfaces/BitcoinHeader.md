# Interface: BitcoinHeader

BitcoinHeader represents the header of a Bitcoin block. For reference, see:
https://developer.bitcoin.org/reference/block_chain.html#block-headers.

## Table of contents

### Properties

- [bits](BitcoinHeader.md#bits)
- [merkleRootHash](BitcoinHeader.md#merkleroothash)
- [nonce](BitcoinHeader.md#nonce)
- [previousBlockHeaderHash](BitcoinHeader.md#previousblockheaderhash)
- [time](BitcoinHeader.md#time)
- [version](BitcoinHeader.md#version)

## Properties

### bits

• **bits**: `number`

Bits that determine the target threshold this block's header hash must be
less than or equal to. The field is 4-byte long.

#### Defined in

[src/lib/bitcoin/header.ts:36](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/header.ts#L36)

___

### merkleRootHash

• **merkleRootHash**: [`Hex`](../classes/Hex.md)

The hash derived from the hashes of all transactions included in this block.
The field is 32-byte long.

#### Defined in

[src/lib/bitcoin/header.ts:24](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/header.ts#L24)

___

### nonce

• **nonce**: `number`

An arbitrary number miners change to modify the header hash in order to
produce a hash less than or equal to the target threshold. The field is
4-byte long.

#### Defined in

[src/lib/bitcoin/header.ts:43](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/header.ts#L43)

___

### previousBlockHeaderHash

• **previousBlockHeaderHash**: [`Hex`](../classes/Hex.md)

The hash of the previous block's header. The field is 32-byte long.

#### Defined in

[src/lib/bitcoin/header.ts:18](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/header.ts#L18)

___

### time

• **time**: `number`

The Unix epoch time when the miner started hashing the header. The field is
4-byte long.

#### Defined in

[src/lib/bitcoin/header.ts:30](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/header.ts#L30)

___

### version

• **version**: `number`

The block version number that indicates which set of block validation rules
to follow. The field is 4-byte long.

#### Defined in

[src/lib/bitcoin/header.ts:13](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/header.ts#L13)
