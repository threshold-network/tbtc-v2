# Interface: BitcoinDepositor

Interface for communication with the BitcoinDepositor on-chain contract
deployed on the given destination chain.

## Implemented by

- [`ArbitrumBitcoinDepositor`](../classes/ArbitrumBitcoinDepositor.md)
- [`BaseBitcoinDepositor`](../classes/BaseBitcoinDepositor.md)
- [`StarkNetBitcoinDepositor`](../classes/StarkNetBitcoinDepositor.md)

## Table of contents

### Methods

- [extraDataEncoder](BitcoinDepositor.md#extradataencoder)
- [getChainIdentifier](BitcoinDepositor.md#getchainidentifier)
- [getDepositOwner](BitcoinDepositor.md#getdepositowner)
- [initializeDeposit](BitcoinDepositor.md#initializedeposit)
- [setDepositOwner](BitcoinDepositor.md#setdepositowner)

## Methods

### extraDataEncoder

▸ **extraDataEncoder**(): [`ExtraDataEncoder`](ExtraDataEncoder.md)

#### Returns

[`ExtraDataEncoder`](ExtraDataEncoder.md)

Extra data encoder for this contract. The encoder is used to
encode and decode the extra data included in the cross-chain deposit script.

#### Defined in

[lib/contracts/cross-chain.ts:99](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L99)

___

### getChainIdentifier

▸ **getChainIdentifier**(): [`ChainIdentifier`](ChainIdentifier.md)

Gets the chain-specific identifier of this contract.
Optional method - may not be available for off-chain implementations.

#### Returns

[`ChainIdentifier`](ChainIdentifier.md)

#### Defined in

[lib/contracts/cross-chain.ts:79](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L79)

___

### getDepositOwner

▸ **getDepositOwner**(): `undefined` \| [`ChainIdentifier`](ChainIdentifier.md)

Gets the identifier that should be used as the owner of the deposits
issued by this contract.

#### Returns

`undefined` \| [`ChainIdentifier`](ChainIdentifier.md)

The identifier of the deposit owner or undefined if not set.

#### Defined in

[lib/contracts/cross-chain.ts:86](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L86)

___

### initializeDeposit

▸ **initializeDeposit**(`depositTx`, `depositOutputIndex`, `deposit`, `vault?`): `Promise`\<[`Hex`](../classes/Hex.md) \| `TransactionReceipt`\>

Initializes the cross-chain deposit indirectly through the given destination chain.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositTx` | [`BitcoinRawTxVectors`](BitcoinRawTxVectors.md) | Deposit transaction data |
| `depositOutputIndex` | `number` | Index of the deposit transaction output that funds the revealed deposit |
| `deposit` | [`DepositReceipt`](DepositReceipt.md) | Data of the revealed deposit |
| `vault?` | [`ChainIdentifier`](ChainIdentifier.md) | Optional parameter denoting the vault the given deposit should be routed to |

#### Returns

`Promise`\<[`Hex`](../classes/Hex.md) \| `TransactionReceipt`\>

Transaction hash of the reveal deposit transaction or full transaction receipt.

#### Defined in

[lib/contracts/cross-chain.ts:111](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L111)

___

### setDepositOwner

▸ **setDepositOwner**(`depositOwner`): `void`

Sets the identifier that should be used as the owner of the deposits
issued by this contract.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositOwner` | [`ChainIdentifier`](ChainIdentifier.md) | Identifier of the deposit owner or undefined to clear. |

#### Returns

`void`

#### Defined in

[lib/contracts/cross-chain.ts:93](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L93)
