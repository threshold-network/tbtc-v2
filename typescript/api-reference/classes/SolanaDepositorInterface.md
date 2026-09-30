# Class: SolanaDepositorInterface

Implementation of the Solana Depositor Interface handle.

## Implements

- [`BitcoinDepositor`](../interfaces/BitcoinDepositor.md)

## Table of contents

### Constructors

- [constructor](SolanaDepositorInterface.md#constructor)

### Properties

- [#depositOwner](SolanaDepositorInterface.md##depositowner)
- [#extraDataEncoder](SolanaDepositorInterface.md##extradataencoder)

### Methods

- [extraDataEncoder](SolanaDepositorInterface.md#extradataencoder)
- [getDepositOwner](SolanaDepositorInterface.md#getdepositowner)
- [initializeDeposit](SolanaDepositorInterface.md#initializedeposit)
- [setDepositOwner](SolanaDepositorInterface.md#setdepositowner)

## Constructors

### constructor

• **new SolanaDepositorInterface**(): [`SolanaDepositorInterface`](SolanaDepositorInterface.md)

#### Returns

[`SolanaDepositorInterface`](SolanaDepositorInterface.md)

#### Defined in

[src/lib/solana/solana-depositor-interface.ts:43](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/solana/solana-depositor-interface.ts#L43)

## Properties

### #depositOwner

• `Private` **#depositOwner**: `undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

#### Defined in

[src/lib/solana/solana-depositor-interface.ts:41](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/solana/solana-depositor-interface.ts#L41)

___

### #extraDataEncoder

• `Private` `Readonly` **#extraDataEncoder**: [`SolanaExtraDataEncoder`](SolanaExtraDataEncoder.md)

#### Defined in

[src/lib/solana/solana-depositor-interface.ts:40](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/solana/solana-depositor-interface.ts#L40)

## Methods

### extraDataEncoder

▸ **extraDataEncoder**(): [`SolanaExtraDataEncoder`](SolanaExtraDataEncoder.md)

#### Returns

[`SolanaExtraDataEncoder`](SolanaExtraDataEncoder.md)

Extra data encoder for this contract. The encoder is used to
encode and decode the extra data included in the cross-chain deposit script.

#### Implementation of

[BitcoinDepositor](../interfaces/BitcoinDepositor.md).[extraDataEncoder](../interfaces/BitcoinDepositor.md#extradataencoder)

#### Defined in

[src/lib/solana/solana-depositor-interface.ts:55](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/solana/solana-depositor-interface.ts#L55)

___

### getDepositOwner

▸ **getDepositOwner**(): `undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

Gets the identifier that should be used as the owner of the deposits
issued by this contract.

#### Returns

`undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

The identifier of the deposit owner or undefined if not set.

#### Implementation of

[BitcoinDepositor](../interfaces/BitcoinDepositor.md).[getDepositOwner](../interfaces/BitcoinDepositor.md#getdepositowner)

#### Defined in

[src/lib/solana/solana-depositor-interface.ts:47](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/solana/solana-depositor-interface.ts#L47)

___

### initializeDeposit

▸ **initializeDeposit**(`depositTx`, `depositOutputIndex`, `deposit`, `vault?`): `Promise`\<`TransactionReceipt`\>

Initializes a deposit by calling the external relayer service at
`https://relayer.tbtcscan.com/api/reveal` to trigger the deposit transaction
via an off-chain relayer process.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositTx` | [`BitcoinRawTxVectors`](../interfaces/BitcoinRawTxVectors.md) | The Bitcoin raw transaction vectors. |
| `depositOutputIndex` | `number` | The output index of the deposit in the funding transaction. |
| `deposit` | [`DepositReceipt`](../interfaces/DepositReceipt.md) | The deposit receipt. |
| `vault?` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) | Optional vault identifier. |

#### Returns

`Promise`\<`TransactionReceipt`\>

The resulting transaction receipt containing the transaction hash.

#### Implementation of

[BitcoinDepositor](../interfaces/BitcoinDepositor.md).[initializeDeposit](../interfaces/BitcoinDepositor.md#initializedeposit)

#### Defined in

[src/lib/solana/solana-depositor-interface.ts:70](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/solana/solana-depositor-interface.ts#L70)

___

### setDepositOwner

▸ **setDepositOwner**(`depositOwner`): `void`

Sets the identifier that should be used as the owner of the deposits
issued by this contract.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositOwner` | `undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md) | Identifier of the deposit owner or undefined to clear. |

#### Returns

`void`

#### Implementation of

[BitcoinDepositor](../interfaces/BitcoinDepositor.md).[setDepositOwner](../interfaces/BitcoinDepositor.md#setdepositowner)

#### Defined in

[src/lib/solana/solana-depositor-interface.ts:51](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/solana/solana-depositor-interface.ts#L51)
