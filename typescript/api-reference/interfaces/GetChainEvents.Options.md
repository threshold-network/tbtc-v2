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

[lib/contracts/chain-event.ts:43](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/chain-event.ts#L43)

___

### fromBlock

• `Optional` **fromBlock**: `number`

Block number from which events should be queried.
If not defined a block number of a contract deployment is used.

#### Defined in

[lib/contracts/chain-event.ts:30](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/chain-event.ts#L30)

___

### logger

• `Optional` **logger**: [`ExecutionLoggerFn`](../README.md#executionloggerfn)

A logger function to pass execution messages.

#### Defined in

[lib/contracts/chain-event.ts:47](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/chain-event.ts#L47)

___

### retries

• `Optional` **retries**: `number`

Number of retries in case of an error getting the events.

#### Defined in

[lib/contracts/chain-event.ts:39](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/chain-event.ts#L39)

___

### toBlock

• `Optional` **toBlock**: `number`

Block number to which events should be queried.
If not defined the latest block number will be used.

#### Defined in

[lib/contracts/chain-event.ts:35](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/chain-event.ts#L35)
