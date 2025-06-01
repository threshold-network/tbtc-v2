# Class: StarkNetDepositorInterface

Implementation of the L2BitcoinDepositor interface for StarkNet.
Since StarkNet doesn't have L2 contracts, this is an interface-only
implementation that throws errors for unsupported operations.

This class is used to maintain compatibility with the cross-chain
contracts structure while StarkNet deposits are handled through
the L1 Bitcoin depositor.

## Implements

- [`L2BitcoinDepositor`](../interfaces/L2BitcoinDepositor.md)

## Table of contents

### Constructors

- [constructor](StarkNetDepositorInterface.md#constructor)

### Properties

- [#depositOwner](StarkNetDepositorInterface.md##depositowner)
- [#extraDataEncoder](StarkNetDepositorInterface.md##extradataencoder)

### Methods

- [extraDataEncoder](StarkNetDepositorInterface.md#extradataencoder)
- [getChainIdentifier](StarkNetDepositorInterface.md#getchainidentifier)
- [getDepositOwner](StarkNetDepositorInterface.md#getdepositowner)
- [initializeDeposit](StarkNetDepositorInterface.md#initializedeposit)
- [setDepositOwner](StarkNetDepositorInterface.md#setdepositowner)

## Constructors

### constructor

• **new StarkNetDepositorInterface**(): [`StarkNetDepositorInterface`](StarkNetDepositorInterface.md)

#### Returns

[`StarkNetDepositorInterface`](StarkNetDepositorInterface.md)

## Properties

### #depositOwner

• `Private` **#depositOwner**: `undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

#### Defined in

[lib/starknet/starknet-depositor-interface.ts:23](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor-interface.ts#L23)

___

### #extraDataEncoder

• `Private` `Readonly` **#extraDataEncoder**: [`StarkNetCrossChainExtraDataEncoder`](StarkNetCrossChainExtraDataEncoder.md)

#### Defined in

[lib/starknet/starknet-depositor-interface.ts:22](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor-interface.ts#L22)

## Methods

### extraDataEncoder

▸ **extraDataEncoder**(): [`CrossChainExtraDataEncoder`](../interfaces/CrossChainExtraDataEncoder.md)

Returns the extra data encoder for StarkNet.

#### Returns

[`CrossChainExtraDataEncoder`](../interfaces/CrossChainExtraDataEncoder.md)

The StarkNetCrossChainExtraDataEncoder instance.

#### Implementation of

[L2BitcoinDepositor](../interfaces/L2BitcoinDepositor.md).[extraDataEncoder](../interfaces/L2BitcoinDepositor.md#extradataencoder)

#### Defined in

[lib/starknet/starknet-depositor-interface.ts:67](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor-interface.ts#L67)

___

### getChainIdentifier

▸ **getChainIdentifier**(): [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

Gets the chain-specific identifier of this contract.

#### Returns

[`ChainIdentifier`](../interfaces/ChainIdentifier.md)

**`Throws`**

Always throws since StarkNet doesn't have an L2 contract.

#### Implementation of

[L2BitcoinDepositor](../interfaces/L2BitcoinDepositor.md).[getChainIdentifier](../interfaces/L2BitcoinDepositor.md#getchainidentifier)

#### Defined in

[lib/starknet/starknet-depositor-interface.ts:30](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor-interface.ts#L30)

___

### getDepositOwner

▸ **getDepositOwner**(): `undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

Gets the identifier that should be used as the owner of deposits.

#### Returns

`undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

The StarkNet address set as deposit owner, or undefined if not set.

#### Implementation of

[L2BitcoinDepositor](../interfaces/L2BitcoinDepositor.md).[getDepositOwner](../interfaces/L2BitcoinDepositor.md#getdepositowner)

#### Defined in

[lib/starknet/starknet-depositor-interface.ts:41](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor-interface.ts#L41)

___

### initializeDeposit

▸ **initializeDeposit**(`_depositTx`, `_depositOutputIndex`, `_deposit`, `_vault?`): `Promise`\<[`Hex`](Hex.md)\>

Initializes a cross-chain deposit.

#### Parameters

| Name | Type |
| :------ | :------ |
| `_depositTx` | [`BitcoinRawTxVectors`](../interfaces/BitcoinRawTxVectors.md) |
| `_depositOutputIndex` | `number` |
| `_deposit` | [`DepositReceipt`](../interfaces/DepositReceipt.md) |
| `_vault?` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) |

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

**`Throws`**

Always throws since StarkNet deposits must go through L1.

#### Implementation of

[L2BitcoinDepositor](../interfaces/L2BitcoinDepositor.md).[initializeDeposit](../interfaces/L2BitcoinDepositor.md#initializedeposit)

#### Defined in

[lib/starknet/starknet-depositor-interface.ts:76](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor-interface.ts#L76)

___

### setDepositOwner

▸ **setDepositOwner**(`depositOwner`): `void`

Sets the identifier that should be used as the owner of deposits.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositOwner` | `undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md) | Must be a StarkNetAddress instance or undefined/null to clear. |

#### Returns

`void`

**`Throws`**

Error if the deposit owner is not a StarkNetAddress and not undefined/null.

#### Implementation of

[L2BitcoinDepositor](../interfaces/L2BitcoinDepositor.md).[setDepositOwner](../interfaces/L2BitcoinDepositor.md#setdepositowner)

#### Defined in

[lib/starknet/starknet-depositor-interface.ts:51](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor-interface.ts#L51)
