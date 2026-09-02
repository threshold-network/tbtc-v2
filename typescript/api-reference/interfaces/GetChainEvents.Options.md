# Interface: Options

[GetChainEvents](../modules/GetChainEvents.md).Options

Represents generic options used for getting events from the chain.

## Table of contents

### Properties

- [batchedQueryBlockInterval](GetChainEvents.Options.md#batchedqueryblockinterval)
- [fromBlock](GetChainEvents.Options.md#fromblock)
- [logger](GetChainEvents.Options.md#logger)
- [retries](GetChainEvents.Options.md#retries)
- [toBlock](GetChainEvents.Options.md#toblock)

## Properties

### batchedQueryBlockInterval

• `Optional` **batchedQueryBlockInterval**: `number`

Number of blocks for interval length in partial events pulls.

#### Defined in

[src/lib/contracts/chain-event.ts:63](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/chain-event.ts#L63)

___

### fromBlock

• `Optional` **fromBlock**: `number`

Block number from which events should be queried.
If not defined a block number of a contract deployment is used.

#### Defined in

[src/lib/contracts/chain-event.ts:50](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/chain-event.ts#L50)

___

### logger

• `Optional` **logger**: [`ExecutionLoggerFn`](../README.md#executionloggerfn)

A logger function to pass execution messages.

#### Defined in

[src/lib/contracts/chain-event.ts:67](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/chain-event.ts#L67)

___

### retries

• `Optional` **retries**: `number`

Number of retries in case of an error getting the events.

#### Defined in

[src/lib/contracts/chain-event.ts:59](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/chain-event.ts#L59)

___

### toBlock

• `Optional` **toBlock**: `number`

Block number to which events should be queried.
If not defined the latest block number will be used.

#### Defined in

[src/lib/contracts/chain-event.ts:55](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/chain-event.ts#L55)
