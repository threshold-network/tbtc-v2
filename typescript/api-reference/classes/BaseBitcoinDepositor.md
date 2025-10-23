# Class: BaseBitcoinDepositor

Implementation of the Base BitcoinDepositor handle.

**`See`**

for reference.

## Hierarchy

- `EthersContractHandle`\<`L2BitcoinDepositorTypechain`\>

  ↳ **`BaseBitcoinDepositor`**

## Implements

- [`BitcoinDepositor`](../interfaces/BitcoinDepositor.md)

## Table of contents

### Constructors

- [constructor](BaseBitcoinDepositor.md#constructor)

### Properties

- [#depositOwner](BaseBitcoinDepositor.md##depositowner)
- [#extraDataEncoder](BaseBitcoinDepositor.md##extradataencoder)
- [\_deployedAtBlockNumber](BaseBitcoinDepositor.md#_deployedatblocknumber)
- [\_instance](BaseBitcoinDepositor.md#_instance)
- [\_totalRetryAttempts](BaseBitcoinDepositor.md#_totalretryattempts)

### Methods

- [extraDataEncoder](BaseBitcoinDepositor.md#extradataencoder)
- [getAddress](BaseBitcoinDepositor.md#getaddress)
- [getChainIdentifier](BaseBitcoinDepositor.md#getchainidentifier)
- [getDepositOwner](BaseBitcoinDepositor.md#getdepositowner)
- [getEvents](BaseBitcoinDepositor.md#getevents)
- [initializeDeposit](BaseBitcoinDepositor.md#initializedeposit)
- [setDepositOwner](BaseBitcoinDepositor.md#setdepositowner)

## Constructors

### constructor

• **new BaseBitcoinDepositor**(`config`, `chainId`): [`BaseBitcoinDepositor`](BaseBitcoinDepositor.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `config` | [`EthereumContractConfig`](../interfaces/EthereumContractConfig.md) |
| `chainId` | [`Base`](../enums/Chains.Base.md) |

#### Returns

[`BaseBitcoinDepositor`](BaseBitcoinDepositor.md)

#### Overrides

EthersContractHandle\&lt;L2BitcoinDepositorTypechain\&gt;.constructor

#### Defined in

[lib/base/l2-bitcoin-depositor.ts:37](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/base/l2-bitcoin-depositor.ts#L37)

## Properties

### #depositOwner

• `Private` **#depositOwner**: `undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

#### Defined in

[lib/base/l2-bitcoin-depositor.ts:35](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/base/l2-bitcoin-depositor.ts#L35)

___

### #extraDataEncoder

• `Private` `Readonly` **#extraDataEncoder**: [`ExtraDataEncoder`](../interfaces/ExtraDataEncoder.md)

#### Defined in

[lib/base/l2-bitcoin-depositor.ts:34](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/base/l2-bitcoin-depositor.ts#L34)

___

### \_deployedAtBlockNumber

• `Protected` `Readonly` **\_deployedAtBlockNumber**: `number`

Number of a block within which the contract was deployed. Value is read from
the contract deployment artifact. It can be overwritten by setting a
[EthersContractConfig.deployedAtBlockNumber](../interfaces/EthereumContractConfig.md#deployedatblocknumber) property.

#### Inherited from

EthersContractHandle.\_deployedAtBlockNumber

#### Defined in

[lib/ethereum/adapter.ts:80](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L80)

___

### \_instance

• `Protected` `Readonly` **\_instance**: `L2BitcoinDepositor`

Ethers instance of the deployed contract.

#### Inherited from

EthersContractHandle.\_instance

#### Defined in

[lib/ethereum/adapter.ts:74](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L74)

___

### \_totalRetryAttempts

• `Protected` `Readonly` **\_totalRetryAttempts**: `number`

Number of retries for ethereum requests.

#### Inherited from

EthersContractHandle.\_totalRetryAttempts

#### Defined in

[lib/ethereum/adapter.ts:84](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L84)

## Methods

### extraDataEncoder

▸ **extraDataEncoder**(): [`ExtraDataEncoder`](../interfaces/ExtraDataEncoder.md)

#### Returns

[`ExtraDataEncoder`](../interfaces/ExtraDataEncoder.md)

**`See`**

#### Implementation of

[BitcoinDepositor](../interfaces/BitcoinDepositor.md).[extraDataEncoder](../interfaces/BitcoinDepositor.md#extradataencoder)

#### Defined in

[lib/base/l2-bitcoin-depositor.ts:84](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/base/l2-bitcoin-depositor.ts#L84)

___

### getAddress

▸ **getAddress**(): [`EthereumAddress`](EthereumAddress.md)

Get address of the contract instance.

#### Returns

[`EthereumAddress`](EthereumAddress.md)

Address of this contract instance.

#### Inherited from

EthersContractHandle.getAddress

#### Defined in

[lib/ethereum/adapter.ts:112](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L112)

___

### getChainIdentifier

▸ **getChainIdentifier**(): [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

#### Returns

[`ChainIdentifier`](../interfaces/ChainIdentifier.md)

**`See`**

#### Implementation of

[BitcoinDepositor](../interfaces/BitcoinDepositor.md).[getChainIdentifier](../interfaces/BitcoinDepositor.md#getchainidentifier)

#### Defined in

[lib/base/l2-bitcoin-depositor.ts:60](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/base/l2-bitcoin-depositor.ts#L60)

___

### getDepositOwner

▸ **getDepositOwner**(): `undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

#### Returns

`undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

**`See`**

#### Implementation of

[BitcoinDepositor](../interfaces/BitcoinDepositor.md).[getDepositOwner](../interfaces/BitcoinDepositor.md#getdepositowner)

#### Defined in

[lib/base/l2-bitcoin-depositor.ts:68](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/base/l2-bitcoin-depositor.ts#L68)

___

### getEvents

▸ **getEvents**(`eventName`, `options?`, `...filterArgs`): `Promise`\<`Event`[]\>

Get events emitted by the Ethereum contract.
It starts searching from provided block number. If the GetEvents.Options#fromBlock
option is missing it looks for a contract's defined property
[_deployedAtBlockNumber](BaseBitcoinDepositor.md#_deployedatblocknumber). If the property is missing starts searching
from block `0`.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `eventName` | `string` | Name of the event. |
| `options?` | [`Options`](../interfaces/GetChainEvents.Options.md) | Options for events fetching. |
| `...filterArgs` | `unknown`[] | Arguments for events filtering. |

#### Returns

`Promise`\<`Event`[]\>

Array of found events.

#### Inherited from

EthersContractHandle.getEvents

#### Defined in

[lib/ethereum/adapter.ts:127](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L127)

___

### initializeDeposit

▸ **initializeDeposit**(`depositTx`, `depositOutputIndex`, `deposit`, `vault?`): `Promise`\<[`Hex`](Hex.md) \| `TransactionReceipt`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `depositTx` | [`BitcoinRawTxVectors`](../interfaces/BitcoinRawTxVectors.md) |
| `depositOutputIndex` | `number` |
| `deposit` | [`DepositReceipt`](../interfaces/DepositReceipt.md) |
| `vault?` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) |

#### Returns

`Promise`\<[`Hex`](Hex.md) \| `TransactionReceipt`\>

**`See`**

#### Implementation of

[BitcoinDepositor](../interfaces/BitcoinDepositor.md).[initializeDeposit](../interfaces/BitcoinDepositor.md#initializedeposit)

#### Defined in

[lib/base/l2-bitcoin-depositor.ts:92](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/base/l2-bitcoin-depositor.ts#L92)

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

[lib/base/l2-bitcoin-depositor.ts:76](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/base/l2-bitcoin-depositor.ts#L76)
