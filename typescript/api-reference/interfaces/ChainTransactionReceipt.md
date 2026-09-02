# Interface: ChainTransactionReceipt

Minimal chain-agnostic transaction receipt. Replaces the ethers
`TransactionReceipt` type in public unions.

## Table of contents

### Properties

- [blockNumber](ChainTransactionReceipt.md#blocknumber)
- [status](ChainTransactionReceipt.md#status)
- [transactionHash](ChainTransactionReceipt.md#transactionhash)

## Properties

### blockNumber

• `Optional` **blockNumber**: `number`

Number of the block the transaction was included in.

#### Defined in

[src/lib/contracts/chain-event.ts:15](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/chain-event.ts#L15)

___

### status

• `Optional` **status**: `number` \| ``"success"`` \| ``"reverted"``

Status of the transaction. The `number` variant is kept for relayer
passthrough responses (e.g. StarkNet).

#### Defined in

[src/lib/contracts/chain-event.ts:20](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/chain-event.ts#L20)

___

### transactionHash

• **transactionHash**: `string`

0x-prefixed transaction hash.

#### Defined in

[src/lib/contracts/chain-event.ts:11](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/chain-event.ts#L11)
