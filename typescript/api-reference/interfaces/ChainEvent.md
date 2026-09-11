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

[src/lib/contracts/chain-event.ts:34](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/chain-event.ts#L34)

___

### blockNumber

• **blockNumber**: `number`

Block number of the event emission.

#### Defined in

[src/lib/contracts/chain-event.ts:30](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/chain-event.ts#L30)

___

### transactionHash

• **transactionHash**: [`Hex`](../classes/Hex.md)

Transaction hash within which the event was emitted.

#### Defined in

[src/lib/contracts/chain-event.ts:38](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/chain-event.ts#L38)
