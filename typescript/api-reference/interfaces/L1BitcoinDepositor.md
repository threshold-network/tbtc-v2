# Interface: L1BitcoinDepositor

Interface for communication with the L1BitcoinDepositor on-chain contract
specific to the given L2 chain, deployed on the L1 chain.

## Implemented by

- [`EthereumL1BitcoinDepositor`](../classes/EthereumL1BitcoinDepositor.md)

## Table of contents

### Methods

- [extraDataEncoder](L1BitcoinDepositor.md#extradataencoder)
- [getChainIdentifier](L1BitcoinDepositor.md#getchainidentifier)
- [getDepositState](L1BitcoinDepositor.md#getdepositstate)
- [initializeDeposit](L1BitcoinDepositor.md#initializedeposit)

## Methods

### extraDataEncoder

▸ **extraDataEncoder**(): [`ExtraDataEncoder`](ExtraDataEncoder.md)

#### Returns

[`ExtraDataEncoder`](ExtraDataEncoder.md)

Extra data encoder for this contract. The encoder is used to
encode and decode the extra data included in the cross-chain deposit script.

#### Defined in

[lib/contracts/cross-chain.ts:180](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L180)

___

### getChainIdentifier

▸ **getChainIdentifier**(): [`ChainIdentifier`](ChainIdentifier.md)

Gets the chain-specific identifier of this contract.

#### Returns

[`ChainIdentifier`](ChainIdentifier.md)

#### Defined in

[lib/contracts/cross-chain.ts:174](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L174)

___

### getDepositState

▸ **getDepositState**(`depositId`): `Promise`\<[`DepositState`](../enums/DepositState.md)\>

Gets the deposit state for the given deposit identifier.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositId` | `string` | Identifier of the deposit to get the state for. |

#### Returns

`Promise`\<[`DepositState`](../enums/DepositState.md)\>

The state of the deposit.

#### Defined in

[lib/contracts/cross-chain.ts:169](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L169)

___

### initializeDeposit

▸ **initializeDeposit**(`depositTx`, `depositOutputIndex`, `deposit`, `vault?`): `Promise`\<`any`\>

Initializes the cross-chain deposit directly on the given L1 chain.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositTx` | [`BitcoinRawTxVectors`](BitcoinRawTxVectors.md) | Deposit transaction data |
| `depositOutputIndex` | `number` | Index of the deposit transaction output that funds the revealed deposit |
| `deposit` | [`DepositReceipt`](DepositReceipt.md) | Data of the revealed deposit |
| `vault?` | [`ChainIdentifier`](ChainIdentifier.md) | Optional parameter denoting the vault the given deposit should be routed to |

#### Returns

`Promise`\<`any`\>

Transaction hash of the reveal deposit transaction or a
        transaction result object for non-EVM chains.

#### Defined in

[lib/contracts/cross-chain.ts:193](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L193)
