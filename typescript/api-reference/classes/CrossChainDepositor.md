# Class: CrossChainDepositor

Implementation of the cross chain depositor proxy. This component is used to
reveal cross-chain deposits whose target chain is not the same as the L1
chain the tBTC system is deployed on.

**`See`**

for reference.

## Implements

- [`DepositorProxy`](../interfaces/DepositorProxy.md)

## Table of contents

### Constructors

- [constructor](CrossChainDepositor.md#constructor)

### Properties

- [#crossChainContracts](CrossChainDepositor.md##crosschaincontracts)
- [#revealMode](CrossChainDepositor.md##revealmode)

### Methods

- [#extraDataEncoder](CrossChainDepositor.md##extradataencoder)
- [extraData](CrossChainDepositor.md#extradata)
- [getChainIdentifier](CrossChainDepositor.md#getchainidentifier)
- [revealDeposit](CrossChainDepositor.md#revealdeposit)

## Constructors

### constructor

• **new CrossChainDepositor**(`crossChainContracts`, `revealMode?`): [`CrossChainDepositor`](CrossChainDepositor.md)

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `crossChainContracts` | [`CrossChainContracts`](../README.md#crosschaincontracts) | `undefined` |
| `revealMode` | [`CrossChainDepositorMode`](../README.md#crosschaindepositormode) | `"L2Transaction"` |

#### Returns

[`CrossChainDepositor`](CrossChainDepositor.md)

#### Defined in

[services/deposits/cross-chain.ts:31](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/cross-chain.ts#L31)

## Properties

### #crossChainContracts

• `Private` `Readonly` **#crossChainContracts**: [`CrossChainContracts`](../README.md#crosschaincontracts)

#### Defined in

[services/deposits/cross-chain.ts:28](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/cross-chain.ts#L28)

___

### #revealMode

• `Private` `Readonly` **#revealMode**: [`CrossChainDepositorMode`](../README.md#crosschaindepositormode)

#### Defined in

[services/deposits/cross-chain.ts:29](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/cross-chain.ts#L29)

## Methods

### #extraDataEncoder

▸ **#extraDataEncoder**(): [`CrossChainExtraDataEncoder`](../interfaces/CrossChainExtraDataEncoder.md)

#### Returns

[`CrossChainExtraDataEncoder`](../interfaces/CrossChainExtraDataEncoder.md)

#### Defined in

[services/deposits/cross-chain.ts:72](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/cross-chain.ts#L72)

___

### extraData

▸ **extraData**(): [`Hex`](Hex.md)

#### Returns

[`Hex`](Hex.md)

Extra data for the cross-chain deposit script. Actually, this is
         the L2 deposit owner identifier took from the L2BitcoinDepositor
         contract.

**`Throws`**

Throws if the L2 deposit owner cannot be resolved. This
        typically happens if the L2BitcoinDepositor operates with
        a read-only signer whose address cannot be resolved.

#### Defined in

[services/deposits/cross-chain.ts:61](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/cross-chain.ts#L61)

___

### getChainIdentifier

▸ **getChainIdentifier**(): [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

#### Returns

[`ChainIdentifier`](../interfaces/ChainIdentifier.md)

The chain-specific identifier of the contract that will be
         used as the actual L1 depositor embedded in the deposit script.
         In this case, the depositor must be the L1BitcoinDepositor contract
         corresponding to the given L2 chain the deposit is targeting.
         This is because the L1BitcoinDepositor contract reveals the deposit to
         the Bridge contract (on L1) and transfers minted TBTC token to the
         target L2 chain once the deposit is processed.

**`See`**

#### Implementation of

[DepositorProxy](../interfaces/DepositorProxy.md).[getChainIdentifier](../interfaces/DepositorProxy.md#getchainidentifier)

#### Defined in

[services/deposits/cross-chain.ts:49](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/cross-chain.ts#L49)

___

### revealDeposit

▸ **revealDeposit**(`depositTx`, `depositOutputIndex`, `deposit`, `vault?`): `Promise`\<[`Hex`](Hex.md)\>

Reveals the given deposit depending on the reveal mode.

#### Parameters

| Name | Type |
| :------ | :------ |
| `depositTx` | [`BitcoinRawTxVectors`](../interfaces/BitcoinRawTxVectors.md) |
| `depositOutputIndex` | `number` |
| `deposit` | [`DepositReceipt`](../interfaces/DepositReceipt.md) |
| `vault?` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) |

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

**`See`**

 - for reveal modes description.
 - 

#### Implementation of

[DepositorProxy](../interfaces/DepositorProxy.md).[revealDeposit](../interfaces/DepositorProxy.md#revealdeposit)

#### Defined in

[services/deposits/cross-chain.ts:87](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/cross-chain.ts#L87)
