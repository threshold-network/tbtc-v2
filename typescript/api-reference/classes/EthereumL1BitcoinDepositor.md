# Class: EthereumL1BitcoinDepositor

Implementation of the Ethereum L1BitcoinDepositor handle. It can be
constructed for each supported L2 chain.

**`See`**

for reference.

## Hierarchy

- `EthersContractHandle`\<`L1BitcoinDepositorTypechain`\>

  ↳ **`EthereumL1BitcoinDepositor`**

## Implements

- [`L1BitcoinDepositor`](../README.md#l1bitcoindepositor)

## Table of contents

### Constructors

- [constructor](EthereumL1BitcoinDepositor.md#constructor)

### Properties

- [#depositOwner](EthereumL1BitcoinDepositor.md##depositowner)
- [#extraDataEncoder](EthereumL1BitcoinDepositor.md##extradataencoder)
- [\_deployedAtBlockNumber](EthereumL1BitcoinDepositor.md#_deployedatblocknumber)
- [\_instance](EthereumL1BitcoinDepositor.md#_instance)
- [\_totalRetryAttempts](EthereumL1BitcoinDepositor.md#_totalretryattempts)

### Methods

- [extraDataEncoder](EthereumL1BitcoinDepositor.md#extradataencoder)
- [getAddress](EthereumL1BitcoinDepositor.md#getaddress)
- [getChainIdentifier](EthereumL1BitcoinDepositor.md#getchainidentifier)
- [getDepositOwner](EthereumL1BitcoinDepositor.md#getdepositowner)
- [getDepositState](EthereumL1BitcoinDepositor.md#getdepositstate)
- [getEvents](EthereumL1BitcoinDepositor.md#getevents)
- [initializeDeposit](EthereumL1BitcoinDepositor.md#initializedeposit)
- [setDepositOwner](EthereumL1BitcoinDepositor.md#setdepositowner)

## Constructors

### constructor

• **new EthereumL1BitcoinDepositor**(`config`, `chainId`, `destinationChainName`): [`EthereumL1BitcoinDepositor`](EthereumL1BitcoinDepositor.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `config` | [`EthereumContractConfig`](../interfaces/EthereumContractConfig.md) |
| `chainId` | [`Ethereum`](../enums/Chains.Ethereum.md) |
| `destinationChainName` | [`DestinationChainName`](../README.md#destinationchainname) |

#### Returns

[`EthereumL1BitcoinDepositor`](EthereumL1BitcoinDepositor.md)

#### Overrides

EthersContractHandle\&lt;L1BitcoinDepositorTypechain\&gt;.constructor

#### Defined in

[lib/ethereum/l1-bitcoin-depositor.ts:85](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/l1-bitcoin-depositor.ts#L85)

## Properties

### #depositOwner

• `Private` **#depositOwner**: `undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

#### Defined in

[lib/ethereum/l1-bitcoin-depositor.ts:83](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/l1-bitcoin-depositor.ts#L83)

___

### #extraDataEncoder

• `Private` `Readonly` **#extraDataEncoder**: [`ExtraDataEncoder`](../interfaces/ExtraDataEncoder.md)

#### Defined in

[lib/ethereum/l1-bitcoin-depositor.ts:82](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/l1-bitcoin-depositor.ts#L82)

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

• `Protected` `Readonly` **\_instance**: `L1BitcoinDepositor`

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

L1BitcoinDepositor.extraDataEncoder

#### Defined in

[lib/ethereum/l1-bitcoin-depositor.ts:156](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/l1-bitcoin-depositor.ts#L156)

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

L1BitcoinDepositor.getChainIdentifier

#### Defined in

[lib/ethereum/l1-bitcoin-depositor.ts:148](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/l1-bitcoin-depositor.ts#L148)

___

### getDepositOwner

▸ **getDepositOwner**(): `undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

#### Returns

`undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

**`See`**

#### Implementation of

L1BitcoinDepositor.getDepositOwner

#### Defined in

[lib/ethereum/l1-bitcoin-depositor.ts:125](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/l1-bitcoin-depositor.ts#L125)

___

### getDepositState

▸ **getDepositState**(`depositId`): `Promise`\<[`DepositState`](../enums/DepositState.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `depositId` | `string` |

#### Returns

`Promise`\<[`DepositState`](../enums/DepositState.md)\>

**`See`**

#### Implementation of

L1BitcoinDepositor.getDepositState

#### Defined in

[lib/ethereum/l1-bitcoin-depositor.ts:141](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/l1-bitcoin-depositor.ts#L141)

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

▸ **initializeDeposit**(`depositTx`, `depositOutputIndex`, `deposit`, `vault?`): `Promise`\<[`Hex`](Hex.md)\>

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

#### Implementation of

L1BitcoinDepositor.initializeDeposit

#### Defined in

[lib/ethereum/l1-bitcoin-depositor.ts:164](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/l1-bitcoin-depositor.ts#L164)

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

L1BitcoinDepositor.setDepositOwner

#### Defined in

[lib/ethereum/l1-bitcoin-depositor.ts:133](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/l1-bitcoin-depositor.ts#L133)
