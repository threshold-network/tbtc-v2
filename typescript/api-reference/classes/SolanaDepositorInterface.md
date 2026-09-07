# Class: SolanaDepositorInterface

Implementation of the Solana Depositor Interface handle.

**`See`**

for reference.

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

[src/lib/solana/solana-depositor-interface.ts:44](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/solana/solana-depositor-interface.ts#L44)

## Properties

### #depositOwner

• `Private` **#depositOwner**: `undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

#### Defined in

[src/lib/solana/solana-depositor-interface.ts:42](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/solana/solana-depositor-interface.ts#L42)

___

### #extraDataEncoder

• `Private` `Readonly` **#extraDataEncoder**: [`SolanaExtraDataEncoder`](SolanaExtraDataEncoder.md)

#### Defined in

[src/lib/solana/solana-depositor-interface.ts:41](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/solana/solana-depositor-interface.ts#L41)

## Methods

### extraDataEncoder

▸ **extraDataEncoder**(): [`SolanaExtraDataEncoder`](SolanaExtraDataEncoder.md)

#### Returns

[`SolanaExtraDataEncoder`](SolanaExtraDataEncoder.md)

**`See`**

#### Implementation of

[BitcoinDepositor](../interfaces/BitcoinDepositor.md).[extraDataEncoder](../interfaces/BitcoinDepositor.md#extradataencoder)

#### Defined in

[src/lib/solana/solana-depositor-interface.ts:68](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/solana/solana-depositor-interface.ts#L68)

___

### getDepositOwner

▸ **getDepositOwner**(): `undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

#### Returns

`undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

**`See`**

#### Implementation of

[BitcoinDepositor](../interfaces/BitcoinDepositor.md).[getDepositOwner](../interfaces/BitcoinDepositor.md#getdepositowner)

#### Defined in

[src/lib/solana/solana-depositor-interface.ts:52](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/solana/solana-depositor-interface.ts#L52)

___

### initializeDeposit

▸ **initializeDeposit**(`depositTx`, `depositOutputIndex`, `deposit`, `vault?`): `Promise`\<`TransactionReceipt`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `depositTx` | [`BitcoinRawTxVectors`](../interfaces/BitcoinRawTxVectors.md) |
| `depositOutputIndex` | `number` |
| `deposit` | [`DepositReceipt`](../interfaces/DepositReceipt.md) |
| `vault?` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) |

#### Returns

`Promise`\<`TransactionReceipt`\>

**`See`**

This method calls the external service at `https://relayer.tbtcscan.com/api/reveal`
to trigger the deposit transaction via a relayer off-chain process.
It returns the resulting transaction hash as a Hex.

#### Implementation of

[BitcoinDepositor](../interfaces/BitcoinDepositor.md).[initializeDeposit](../interfaces/BitcoinDepositor.md#initializedeposit)

#### Defined in

[src/lib/solana/solana-depositor-interface.ts:80](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/solana/solana-depositor-interface.ts#L80)

___

### setDepositOwner

▸ **setDepositOwner**(`depositOwner`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `depositOwner` | `undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md) |

#### Returns

`void`

**`See`**

#### Implementation of

[BitcoinDepositor](../interfaces/BitcoinDepositor.md).[setDepositOwner](../interfaces/BitcoinDepositor.md#setdepositowner)

#### Defined in

[src/lib/solana/solana-depositor-interface.ts:60](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/solana/solana-depositor-interface.ts#L60)
