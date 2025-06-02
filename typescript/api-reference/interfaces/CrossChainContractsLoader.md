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

[lib/contracts/cross-chain.ts:38](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L38)

___

### loadL1Contracts

• **loadL1Contracts**: (`l2ChainName`: [`L2Chain`](../README.md#l2chain)) => `Promise`\<[`L1CrossChainContracts`](../README.md#l1crosschaincontracts)\>

Loads L1-specific TBTC cross-chain contracts for the given L2 chain.

#### Type declaration

▸ (`l2ChainName`): `Promise`\<[`L1CrossChainContracts`](../README.md#l1crosschaincontracts)\>

##### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `l2ChainName` | [`L2Chain`](../README.md#l2chain) | Name of the L2 chain for which to load L1 contracts. |

##### Returns

`Promise`\<[`L1CrossChainContracts`](../README.md#l1crosschaincontracts)\>

#### Defined in

[lib/contracts/cross-chain.ts:43](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L43)
