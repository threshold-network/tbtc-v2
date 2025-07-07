# Interface: CrossChainContractsLoader

Interface for loading TBTC cross-chain contracts for a specific L2 chain.
It should be implemented for each supported L1 chain tBTC ledger is deployed
on.

## Table of contents

### Properties

- [loadChainMapping](CrossChainContractsLoader.md#loadchainmapping)
- [loadL1Contracts](CrossChainContractsLoader.md#loadl1contracts)

## Properties

### loadChainMapping

• **loadChainMapping**: () => `undefined` \| [`ChainMapping`](../README.md#chainmapping)

Loads the chain mapping based on underlying L1 chain.

#### Type declaration

▸ (): `undefined` \| [`ChainMapping`](../README.md#chainmapping)

##### Returns

`undefined` \| [`ChainMapping`](../README.md#chainmapping)

#### Defined in

[lib/contracts/cross-chain.ts:42](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L42)

___

### loadL1Contracts

• **loadL1Contracts**: (`destinationChainName`: [`DestinationChainName`](../README.md#destinationchainname)) => `Promise`\<[`L1CrossChainContracts`](../README.md#l1crosschaincontracts)\>

Loads L1-specific TBTC cross-chain contracts for the given destination chain.

#### Type declaration

▸ (`destinationChainName`): `Promise`\<[`L1CrossChainContracts`](../README.md#l1crosschaincontracts)\>

##### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `destinationChainName` | [`DestinationChainName`](../README.md#destinationchainname) | Name of the destination chain for which to load L1 contracts. |

##### Returns

`Promise`\<[`L1CrossChainContracts`](../README.md#l1crosschaincontracts)\>

#### Defined in

[lib/contracts/cross-chain.ts:47](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L47)
