# Interface: ChainEvent

Represents a generic chain event.

## Table of contents

### Properties

- [blockHash](ChainEvent.md#blockhash)
- [blockNumber](ChainEvent.md#blocknumber)
- [transactionHash](ChainEvent.md#transactionhash)

## Properties

### blockHash

• **blockHash**: [`Hex`](../classes/Hex.md)

Block hash of the event emission.

#### Defined in

[lib/contracts/chain-event.ts:14](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/chain-event.ts#L14)

___

### blockNumber

• **blockNumber**: `number`

Block number of the event emission.

#### Defined in

[lib/contracts/chain-event.ts:10](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/chain-event.ts#L10)

___

### transactionHash

• **transactionHash**: [`Hex`](../classes/Hex.md)

Transaction hash within which the event was emitted.

#### Defined in

[lib/contracts/chain-event.ts:18](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/chain-event.ts#L18)
