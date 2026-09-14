# Class: BaseTBTCToken

Implementation of the Base DestinationChainTBTCToken handle.

**`See`**

for reference.

## Hierarchy

- `EthersContractHandle`\<`L2TBTCTypechain`\>

  ↳ **`BaseTBTCToken`**

## Implements

- [`DestinationChainTBTCToken`](../interfaces/DestinationChainTBTCToken.md)

## Table of contents

### Constructors

- [constructor](BaseTBTCToken.md#constructor)

### Properties

- [\_deployedAtBlockNumber](BaseTBTCToken.md#_deployedatblocknumber)
- [\_instance](BaseTBTCToken.md#_instance)
- [\_totalRetryAttempts](BaseTBTCToken.md#_totalretryattempts)

### Methods

- [balanceOf](BaseTBTCToken.md#balanceof)
- [getAddress](BaseTBTCToken.md#getaddress)
- [getChainIdentifier](BaseTBTCToken.md#getchainidentifier)
- [getEvents](BaseTBTCToken.md#getevents)

## Constructors

### constructor

• **new BaseTBTCToken**(`config`, `chainId`): [`BaseTBTCToken`](BaseTBTCToken.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `config` | [`EthereumContractConfig`](../interfaces/EthereumContractConfig.md) |
| `chainId` | [`Base`](../enums/Chains.Base.md) |

#### Returns

[`BaseTBTCToken`](BaseTBTCToken.md)

#### Overrides

EthersContractHandle\&lt;L2TBTCTypechain\&gt;.constructor

#### Defined in

[src/lib/base/l2-tbtc-token.ts:26](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/base/l2-tbtc-token.ts#L26)

## Properties

### \_deployedAtBlockNumber

• `Protected` `Readonly` **\_deployedAtBlockNumber**: `number`

Number of a block within which the contract was deployed. Value is read from
the contract deployment artifact. It can be overwritten by setting a
[EthersContractConfig.deployedAtBlockNumber](../interfaces/EthereumContractConfig.md#deployedatblocknumber) property.

#### Inherited from

EthersContractHandle.\_deployedAtBlockNumber

#### Defined in

[src/lib/ethereum/adapter.ts:78](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L78)

___

### \_instance

• `Protected` `Readonly` **\_instance**: `L2TBTC`

Ethers instance of the deployed contract.

#### Inherited from

EthersContractHandle.\_instance

#### Defined in

[src/lib/ethereum/adapter.ts:72](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L72)

___

### \_totalRetryAttempts

• `Protected` `Readonly` **\_totalRetryAttempts**: `number`

Number of retries for ethereum requests.

#### Inherited from

EthersContractHandle.\_totalRetryAttempts

#### Defined in

[src/lib/ethereum/adapter.ts:82](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L82)

## Methods

### balanceOf

▸ **balanceOf**(`identifier`): `Promise`\<`BigNumber`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `identifier` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) |

#### Returns

`Promise`\<`BigNumber`\>

**`See`**

#### Implementation of

[DestinationChainTBTCToken](../interfaces/DestinationChainTBTCToken.md).[balanceOf](../interfaces/DestinationChainTBTCToken.md#balanceof)

#### Defined in

[src/lib/base/l2-tbtc-token.ts:55](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/base/l2-tbtc-token.ts#L55)

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

[src/lib/ethereum/adapter.ts:110](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L110)

___

### getChainIdentifier

▸ **getChainIdentifier**(): [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

#### Returns

[`ChainIdentifier`](../interfaces/ChainIdentifier.md)

**`See`**

#### Implementation of

[DestinationChainTBTCToken](../interfaces/DestinationChainTBTCToken.md).[getChainIdentifier](../interfaces/DestinationChainTBTCToken.md#getchainidentifier)

#### Defined in

[src/lib/base/l2-tbtc-token.ts:47](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/base/l2-tbtc-token.ts#L47)

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

[src/lib/ethereum/adapter.ts:125](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L125)
