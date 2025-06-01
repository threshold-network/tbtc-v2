# Class: ArbitrumL2TBTCToken

Implementation of the Arbitrum L2TBTCToken handle.

**`See`**

for reference.

## Hierarchy

- `EthersContractHandle`\<`L2TBTCTypechain`\>

  ↳ **`ArbitrumL2TBTCToken`**

## Implements

- [`L2TBTCToken`](../interfaces/L2TBTCToken.md)

## Table of contents

### Constructors

- [constructor](ArbitrumL2TBTCToken.md#constructor)

### Properties

- [\_deployedAtBlockNumber](ArbitrumL2TBTCToken.md#_deployedatblocknumber)
- [\_instance](ArbitrumL2TBTCToken.md#_instance)
- [\_totalRetryAttempts](ArbitrumL2TBTCToken.md#_totalretryattempts)

### Methods

- [balanceOf](ArbitrumL2TBTCToken.md#balanceof)
- [getAddress](ArbitrumL2TBTCToken.md#getaddress)
- [getChainIdentifier](ArbitrumL2TBTCToken.md#getchainidentifier)
- [getEvents](ArbitrumL2TBTCToken.md#getevents)

## Constructors

### constructor

• **new ArbitrumL2TBTCToken**(`config`, `chainId`): [`ArbitrumL2TBTCToken`](ArbitrumL2TBTCToken.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `config` | [`EthereumContractConfig`](../interfaces/EthereumContractConfig.md) |
| `chainId` | [`Arbitrum`](../enums/Chains.Arbitrum.md) |

#### Returns

[`ArbitrumL2TBTCToken`](ArbitrumL2TBTCToken.md)

#### Overrides

EthersContractHandle\&lt;L2TBTCTypechain\&gt;.constructor

#### Defined in

[lib/arbitrum/l2-tbtc-token.ts:22](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/arbitrum/l2-tbtc-token.ts#L22)

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

• `Protected` `Readonly` **\_instance**: `L2TBTC`

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

[L2TBTCToken](../interfaces/L2TBTCToken.md).[balanceOf](../interfaces/L2TBTCToken.md#balanceof)

#### Defined in

[lib/arbitrum/l2-tbtc-token.ts:51](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/arbitrum/l2-tbtc-token.ts#L51)

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

[L2TBTCToken](../interfaces/L2TBTCToken.md).[getChainIdentifier](../interfaces/L2TBTCToken.md#getchainidentifier)

#### Defined in

[lib/arbitrum/l2-tbtc-token.ts:43](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/arbitrum/l2-tbtc-token.ts#L43)

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
