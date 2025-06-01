# Class: EthereumL1BitcoinDepositor

Implementation of the Ethereum L1BitcoinDepositor handle. It can be
constructed for each supported L2 chain.

**`See`**

for reference.

## Hierarchy

- `EthersContractHandle`\<`L1BitcoinDepositorTypechain`\>

  ↳ **`EthereumL1BitcoinDepositor`**

## Implements

- [`L1BitcoinDepositor`](../interfaces/L1BitcoinDepositor.md)

## Table of contents

### Constructors

- [constructor](EthereumL1BitcoinDepositor.md#constructor)

### Properties

- [#extraDataEncoder](EthereumL1BitcoinDepositor.md##extradataencoder)
- [\_deployedAtBlockNumber](EthereumL1BitcoinDepositor.md#_deployedatblocknumber)
- [\_instance](EthereumL1BitcoinDepositor.md#_instance)
- [\_totalRetryAttempts](EthereumL1BitcoinDepositor.md#_totalretryattempts)

### Methods

- [extraDataEncoder](EthereumL1BitcoinDepositor.md#extradataencoder)
- [getAddress](EthereumL1BitcoinDepositor.md#getaddress)
- [getChainIdentifier](EthereumL1BitcoinDepositor.md#getchainidentifier)
- [getDepositState](EthereumL1BitcoinDepositor.md#getdepositstate)
- [getEvents](EthereumL1BitcoinDepositor.md#getevents)
- [initializeDeposit](EthereumL1BitcoinDepositor.md#initializedeposit)

## Constructors

### constructor

• **new EthereumL1BitcoinDepositor**(`config`, `chainId`, `l2ChainName`): [`EthereumL1BitcoinDepositor`](EthereumL1BitcoinDepositor.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `config` | [`EthereumContractConfig`](../interfaces/EthereumContractConfig.md) |
| `chainId` | [`Ethereum`](../enums/Chains.Ethereum.md) |
| `l2ChainName` | [`L2Chain`](../README.md#l2chain) |

#### Returns

[`EthereumL1BitcoinDepositor`](EthereumL1BitcoinDepositor.md)

#### Overrides

EthersContractHandle\&lt;L1BitcoinDepositorTypechain\&gt;.constructor

#### Defined in

[lib/ethereum/l1-bitcoin-depositor.ts:67](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/l1-bitcoin-depositor.ts#L67)

## Properties

### #extraDataEncoder

• `Private` `Readonly` **#extraDataEncoder**: [`CrossChainExtraDataEncoder`](../interfaces/CrossChainExtraDataEncoder.md)

#### Defined in

[lib/ethereum/l1-bitcoin-depositor.ts:65](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/l1-bitcoin-depositor.ts#L65)

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

▸ **extraDataEncoder**(): [`CrossChainExtraDataEncoder`](../interfaces/CrossChainExtraDataEncoder.md)

#### Returns

[`CrossChainExtraDataEncoder`](../interfaces/CrossChainExtraDataEncoder.md)

**`See`**

#### Implementation of

[L1BitcoinDepositor](../interfaces/L1BitcoinDepositor.md).[extraDataEncoder](../interfaces/L1BitcoinDepositor.md#extradataencoder)

#### Defined in

[lib/ethereum/l1-bitcoin-depositor.ts:116](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/l1-bitcoin-depositor.ts#L116)

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

[L1BitcoinDepositor](../interfaces/L1BitcoinDepositor.md).[getChainIdentifier](../interfaces/L1BitcoinDepositor.md#getchainidentifier)

#### Defined in

[lib/ethereum/l1-bitcoin-depositor.ts:108](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/l1-bitcoin-depositor.ts#L108)

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

[L1BitcoinDepositor](../interfaces/L1BitcoinDepositor.md).[getDepositState](../interfaces/L1BitcoinDepositor.md#getdepositstate)

#### Defined in

[lib/ethereum/l1-bitcoin-depositor.ts:100](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/l1-bitcoin-depositor.ts#L100)

___

### getEvents

▸ **getEvents**(`eventName`, `options?`, `...filterArgs`): `Promise`\<`Event`[]\>

Get events emitted by the Ethereum contract.
It starts searching from provided block number. If the GetEvents.Options#fromBlock
option is missing it looks for a contract's defined property
[_deployedAtBlockNumber](BaseL2BitcoinDepositor.md#_deployedatblocknumber). If the property is missing starts searching
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

[L1BitcoinDepositor](../interfaces/L1BitcoinDepositor.md).[initializeDeposit](../interfaces/L1BitcoinDepositor.md#initializedeposit)

#### Defined in

[lib/ethereum/l1-bitcoin-depositor.ts:124](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/l1-bitcoin-depositor.ts#L124)
