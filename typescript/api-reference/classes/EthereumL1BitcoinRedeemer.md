# Class: EthereumL1BitcoinRedeemer

Implementation of the Ethereum L1BitcoinRedeemer handle. It can be
constructed for each supported L2 chain.

**`See`**

for reference.

## Hierarchy

- `EthersContractHandle`\<`L1BitcoinRedeemerTypechain`\>

  ↳ **`EthereumL1BitcoinRedeemer`**

## Implements

- [`L1BitcoinRedeemer`](../interfaces/L1BitcoinRedeemer.md)

## Table of contents

### Constructors

- [constructor](EthereumL1BitcoinRedeemer.md#constructor)

### Properties

- [\_deployedAtBlockNumber](EthereumL1BitcoinRedeemer.md#_deployedatblocknumber)
- [\_instance](EthereumL1BitcoinRedeemer.md#_instance)
- [\_totalRetryAttempts](EthereumL1BitcoinRedeemer.md#_totalretryattempts)

### Methods

- [getAddress](EthereumL1BitcoinRedeemer.md#getaddress)
- [getChainIdentifier](EthereumL1BitcoinRedeemer.md#getchainidentifier)
- [getEvents](EthereumL1BitcoinRedeemer.md#getevents)
- [requestRedemption](EthereumL1BitcoinRedeemer.md#requestredemption)

## Constructors

### constructor

• **new EthereumL1BitcoinRedeemer**(`config`, `chainId`, `l2ChainName`): [`EthereumL1BitcoinRedeemer`](EthereumL1BitcoinRedeemer.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `config` | [`EthereumContractConfig`](../interfaces/EthereumContractConfig.md) |
| `chainId` | [`Ethereum`](../enums/Chains.Ethereum.md) |
| `l2ChainName` | [`DestinationChainName`](../README.md#destinationchainname) |

#### Returns

[`EthereumL1BitcoinRedeemer`](EthereumL1BitcoinRedeemer.md)

#### Overrides

EthersContractHandle\&lt;L1BitcoinRedeemerTypechain\&gt;.constructor

#### Defined in

[lib/ethereum/l1-bitcoin-redeemer.ts:51](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/l1-bitcoin-redeemer.ts#L51)

## Properties

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

• `Protected` `Readonly` **\_instance**: `L1BitcoinRedeemer`

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

[L1BitcoinRedeemer](../interfaces/L1BitcoinRedeemer.md).[getChainIdentifier](../interfaces/L1BitcoinRedeemer.md#getchainidentifier)

#### Defined in

[lib/ethereum/l1-bitcoin-redeemer.ts:76](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/l1-bitcoin-redeemer.ts#L76)

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

### requestRedemption

▸ **requestRedemption**(`walletPublicKey`, `mainUtxo`, `encodedVm`): `Promise`\<[`Hex`](Hex.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `walletPublicKey` | [`Hex`](Hex.md) |
| `mainUtxo` | [`BitcoinUtxo`](../README.md#bitcoinutxo) |
| `encodedVm` | `BytesLike` |

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

**`See`**

#### Implementation of

[L1BitcoinRedeemer](../interfaces/L1BitcoinRedeemer.md).[requestRedemption](../interfaces/L1BitcoinRedeemer.md#requestredemption)

#### Defined in

[lib/ethereum/l1-bitcoin-redeemer.ts:84](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/l1-bitcoin-redeemer.ts#L84)
