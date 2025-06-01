# Interface: L2BitcoinDepositor

Interface for communication with the L2BitcoinDepositor on-chain contract
deployed on the given L2 chain.

## Implemented by

- [`ArbitrumL2BitcoinDepositor`](../classes/ArbitrumL2BitcoinDepositor.md)
- [`BaseL2BitcoinDepositor`](../classes/BaseL2BitcoinDepositor.md)
- [`StarkNetDepositorInterface`](../classes/StarkNetDepositorInterface.md)

## Table of contents

### Methods

- [extraDataEncoder](L2BitcoinDepositor.md#extradataencoder)
- [getChainIdentifier](L2BitcoinDepositor.md#getchainidentifier)
- [getDepositOwner](L2BitcoinDepositor.md#getdepositowner)
- [initializeDeposit](L2BitcoinDepositor.md#initializedeposit)
- [setDepositOwner](L2BitcoinDepositor.md#setdepositowner)

## Methods

### extraDataEncoder

▸ **extraDataEncoder**(): [`CrossChainExtraDataEncoder`](CrossChainExtraDataEncoder.md)

#### Returns

[`CrossChainExtraDataEncoder`](CrossChainExtraDataEncoder.md)

Extra data encoder for this contract. The encoder is used to
encode and decode the extra data included in the cross-chain deposit script.

#### Defined in

[lib/contracts/cross-chain.ts:92](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L92)

___

### getChainIdentifier

▸ **getChainIdentifier**(): [`ChainIdentifier`](ChainIdentifier.md)

Gets the chain-specific identifier of this contract.

#### Returns

[`ChainIdentifier`](ChainIdentifier.md)

#### Defined in

[lib/contracts/cross-chain.ts:72](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L72)

___

### getDepositOwner

▸ **getDepositOwner**(): `undefined` \| [`ChainIdentifier`](ChainIdentifier.md)

Gets the identifier that should be used as the owner of the deposits
issued by this contract.

#### Returns

`undefined` \| [`ChainIdentifier`](ChainIdentifier.md)

The identifier of the deposit owner or undefined if not set.

#### Defined in

[lib/contracts/cross-chain.ts:79](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L79)

___

### initializeDeposit

▸ **initializeDeposit**(`depositTx`, `depositOutputIndex`, `deposit`, `vault?`): `Promise`\<[`Hex`](../classes/Hex.md)\>

Initializes the cross-chain deposit indirectly through the given L2 chain.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositTx` | [`BitcoinRawTxVectors`](BitcoinRawTxVectors.md) | Deposit transaction data |
| `depositOutputIndex` | `number` | Index of the deposit transaction output that funds the revealed deposit |
| `deposit` | [`DepositReceipt`](DepositReceipt.md) | Data of the revealed deposit |
| `vault?` | [`ChainIdentifier`](ChainIdentifier.md) | Optional parameter denoting the vault the given deposit should be routed to |

#### Returns

`Promise`\<[`Hex`](../classes/Hex.md)\>

Transaction hash of the reveal deposit transaction.

#### Defined in

[lib/contracts/cross-chain.ts:104](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L104)

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

[lib/contracts/cross-chain.ts:86](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L86)
