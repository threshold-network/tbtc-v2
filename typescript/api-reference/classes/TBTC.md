# Class: TBTC

Entrypoint component of the tBTC v2 SDK.

## Table of contents

### Constructors

- [constructor](TBTC.md#constructor)

### Properties

- [#crossChainContracts](TBTC.md##crosschaincontracts)
- [#crossChainContractsLoader](TBTC.md##crosschaincontractsloader)
- [\_l2Signer](TBTC.md#_l2signer)
- [bitcoinClient](TBTC.md#bitcoinclient)
- [deposits](TBTC.md#deposits)
- [maintenance](TBTC.md#maintenance)
- [redemptions](TBTC.md#redemptions)
- [tbtcContracts](TBTC.md#tbtccontracts)

### Methods

- [crossChainContracts](TBTC.md#crosschaincontracts)
- [initializeCrossChain](TBTC.md#initializecrosschain)
- [extractStarkNetAddress](TBTC.md#extractstarknetaddress)
- [initializeCustom](TBTC.md#initializecustom)
- [initializeEthereum](TBTC.md#initializeethereum)
- [initializeMainnet](TBTC.md#initializemainnet)
- [initializeSepolia](TBTC.md#initializesepolia)

## Constructors

### constructor

• **new TBTC**(`tbtcContracts`, `bitcoinClient`, `crossChainContractsLoader?`): [`TBTC`](TBTC.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `tbtcContracts` | [`TBTCContracts`](../README.md#tbtccontracts) |
| `bitcoinClient` | [`BitcoinClient`](../interfaces/BitcoinClient.md) |
| `crossChainContractsLoader?` | [`CrossChainContractsLoader`](../interfaces/CrossChainContractsLoader.md) |

#### Returns

[`TBTC`](TBTC.md)

#### Defined in

[services/tbtc.ts:64](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L64)

## Properties

### #crossChainContracts

• `Private` `Readonly` **#crossChainContracts**: `Map`\<[`L2Chain`](../README.md#l2chain), [`CrossChainContracts`](../README.md#crosschaincontracts)\>

Mapping of cross-chain contracts for different supported L2 chains.
Each set of cross-chain contracts must be first initialized using
the `initializeCrossChain` method.

#### Defined in

[services/tbtc.ts:62](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L62)

___

### #crossChainContractsLoader

• `Private` `Optional` `Readonly` **#crossChainContractsLoader**: [`CrossChainContractsLoader`](../interfaces/CrossChainContractsLoader.md)

Reference to the cross-chain contracts loader.

#### Defined in

[services/tbtc.ts:56](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L56)

___

### \_l2Signer

• `Optional` **\_l2Signer**: [`EthereumSigner`](../README.md#ethereumsigner) \| [`StarkNetProvider`](../README.md#starknetprovider)

Internal property to store L2 signer/provider for advanced use cases.

**`Deprecated`**

Will be removed in next major version. Use two-parameter pattern instead.

#### Defined in

[services/tbtc.ts:245](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L245)

___

### bitcoinClient

• `Readonly` **bitcoinClient**: [`BitcoinClient`](../interfaces/BitcoinClient.md)

Bitcoin client handle for low-level access.

#### Defined in

[services/tbtc.ts:52](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L52)

___

### deposits

• `Readonly` **deposits**: [`DepositsService`](DepositsService.md)

Service supporting the tBTC v2 deposit flow.

#### Defined in

[services/tbtc.ts:35](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L35)

___

### maintenance

• `Readonly` **maintenance**: [`MaintenanceService`](MaintenanceService.md)

Service supporting authorized operations of tBTC v2 system maintainers
and operators.

#### Defined in

[services/tbtc.ts:40](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L40)

___

### redemptions

• `Readonly` **redemptions**: [`RedemptionsService`](RedemptionsService.md)

Service supporting the tBTC v2 redemption flow.

#### Defined in

[services/tbtc.ts:44](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L44)

___

### tbtcContracts

• `Readonly` **tbtcContracts**: [`TBTCContracts`](../README.md#tbtccontracts)

Handle to tBTC contracts for low-level access.

#### Defined in

[services/tbtc.ts:48](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L48)

## Methods

### crossChainContracts

▸ **crossChainContracts**(`l2ChainName`): `undefined` \| [`CrossChainContracts`](../README.md#crosschaincontracts)

Gets cross-chain contracts for the given supported L2 chain.
The given L2 chain contracts must be first initialized using the
`initializeCrossChain` method.

 THIS IS EXPERIMENTAL CODE THAT CAN BE CHANGED OR REMOVED
              IN FUTURE RELEASES. IT SHOULD BE USED ONLY FOR INTERNAL
              PURPOSES AND EXTERNAL APPLICATIONS SHOULD NOT DEPEND ON IT.
              CROSS-CHAIN SUPPORT IS NOT FULLY OPERATIONAL YET.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `l2ChainName` | [`L2Chain`](../README.md#l2chain) | Name of the L2 chain for which to get cross-chain contracts. |

#### Returns

`undefined` \| [`CrossChainContracts`](../README.md#crosschaincontracts)

Cross-chain contracts for the given L2 chain or
         undefined if not initialized.

#### Defined in

[services/tbtc.ts:448](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L448)

___

### initializeCrossChain

▸ **initializeCrossChain**(`l2ChainName`, `signerOrEthereumSigner`, `l2Provider?`): `Promise`\<`void`\>

Initializes cross-chain contracts for the given L2 chain.

For StarkNet, this method now supports single-parameter initialization:
```
// Recommended: Single-parameter (StarkNet wallet only)
await tbtc.initializeCrossChain("StarkNet", starknetProvider)
```

The two-parameter pattern is deprecated but still supported:
```
// Deprecated: Two-parameter (requires Ethereum wallet)
await tbtc.initializeCrossChain("StarkNet", ethereumSigner, starknetProvider)
```

For other L2 chains, continue using the standard pattern:
```
await tbtc.initializeCrossChain("Base", ethereumSigner)
```

 THIS IS EXPERIMENTAL CODE THAT CAN BE CHANGED OR REMOVED
              IN FUTURE RELEASES. IT SHOULD BE USED ONLY FOR INTERNAL
              PURPOSES AND EXTERNAL APPLICATIONS SHOULD NOT DEPEND ON IT.
              CROSS-CHAIN SUPPORT IS NOT FULLY OPERATIONAL YET.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `l2ChainName` | [`L2Chain`](../README.md#l2chain) | Name of the L2 chain |
| `signerOrEthereumSigner` | [`EthereumSigner`](../README.md#ethereumsigner) \| [`StarkNetProvider`](../README.md#starknetprovider) | - |
| `l2Provider?` | [`StarkNetProvider`](../README.md#starknetprovider) | [DEPRECATED] For StarkNet two-parameter mode only. |

#### Returns

`Promise`\<`void`\>

Void promise

**`Throws`**

Throws an error if:
        - Cross-chain contracts loader not available
        - Invalid provider type for StarkNet
        - No connected account in StarkNet provider

**`Example`**

```ts
// StarkNet with single parameter (recommended)
const starknetAccount = await starknet.connect();
await tbtc.initializeCrossChain("StarkNet", starknetAccount);
```

**`Deprecated`**

The two-parameter variant for StarkNet is deprecated.
           Use single-parameter initialization instead.

#### Defined in

[services/tbtc.ts:290](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L290)

___

### extractStarkNetAddress

▸ **extractStarkNetAddress**(`provider`): `Promise`\<`string`\>

Extracts StarkNet wallet address from a provider or account object.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `provider` | `undefined` \| ``null`` \| [`StarkNetProvider`](../README.md#starknetprovider) | StarkNet provider or account object. |

#### Returns

`Promise`\<`string`\>

The StarkNet wallet address in hex format.

**`Throws`**

Throws an error if the provider is invalid or address cannot be extracted.

#### Defined in

[services/tbtc.ts:199](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L199)

___

### initializeCustom

▸ **initializeCustom**(`tbtcContracts`, `bitcoinClient`): `Promise`\<[`TBTC`](TBTC.md)\>

Initializes the tBTC v2 SDK entrypoint with custom tBTC contracts and
Bitcoin client.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `tbtcContracts` | [`TBTCContracts`](../README.md#tbtccontracts) | Custom tBTC contracts handle. |
| `bitcoinClient` | [`BitcoinClient`](../interfaces/BitcoinClient.md) | Custom Bitcoin client implementation. |

#### Returns

`Promise`\<[`TBTC`](TBTC.md)\>

Initialized tBTC v2 SDK entrypoint.

**`Dev`**

This function is especially useful for local development as it gives
     flexibility to combine different implementations of tBTC v2 contracts
     with different Bitcoin networks.

#### Defined in

[services/tbtc.ts:185](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L185)

___

### initializeEthereum

▸ **initializeEthereum**(`signer`, `ethereumChainId`, `bitcoinNetwork`, `crossChainSupport?`): `Promise`\<[`TBTC`](TBTC.md)\>

Initializes the tBTC v2 SDK entrypoint for the given Ethereum network and Bitcoin network.
The initialized instance uses default Electrum servers to interact
with Bitcoin network.

#### Parameters

| Name | Type | Default value | Description |
| :------ | :------ | :------ | :------ |
| `signer` | [`EthereumSigner`](../README.md#ethereumsigner) | `undefined` | Ethereum signer. |
| `ethereumChainId` | [`Ethereum`](../enums/Chains.Ethereum.md) | `undefined` | Ethereum chain ID. |
| `bitcoinNetwork` | [`BitcoinNetwork`](../enums/BitcoinNetwork-1.md) | `undefined` | Bitcoin network. |
| `crossChainSupport` | `boolean` | `false` | Whether to enable cross-chain support. False by default. |

#### Returns

`Promise`\<[`TBTC`](TBTC.md)\>

Initialized tBTC v2 SDK entrypoint.

**`Throws`**

Throws an error if the underlying signer's Ethereum network is
        other than the given Ethereum network.

#### Defined in

[services/tbtc.ts:138](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L138)

___

### initializeMainnet

▸ **initializeMainnet**(`signer`, `crossChainSupport?`): `Promise`\<[`TBTC`](TBTC.md)\>

Initializes the tBTC v2 SDK entrypoint for Ethereum and Bitcoin mainnets.
The initialized instance uses default Electrum servers to interact
with Bitcoin mainnet

#### Parameters

| Name | Type | Default value | Description |
| :------ | :------ | :------ | :------ |
| `signer` | [`EthereumSigner`](../README.md#ethereumsigner) | `undefined` | Ethereum signer. |
| `crossChainSupport` | `boolean` | `false` | Whether to enable cross-chain support. False by default. |

#### Returns

`Promise`\<[`TBTC`](TBTC.md)\>

Initialized tBTC v2 SDK entrypoint.

**`Throws`**

Throws an error if the signer's Ethereum network is other than
        Ethereum mainnet.

#### Defined in

[services/tbtc.ts:92](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L92)

___

### initializeSepolia

▸ **initializeSepolia**(`signer`, `crossChainSupport?`): `Promise`\<[`TBTC`](TBTC.md)\>

Initializes the tBTC v2 SDK entrypoint for Ethereum Sepolia and Bitcoin testnet.
The initialized instance uses default Electrum servers to interact
with Bitcoin testnet

#### Parameters

| Name | Type | Default value | Description |
| :------ | :------ | :------ | :------ |
| `signer` | [`EthereumSigner`](../README.md#ethereumsigner) | `undefined` | Ethereum signer. |
| `crossChainSupport` | `boolean` | `false` | Whether to enable cross-chain support. False by default. |

#### Returns

`Promise`\<[`TBTC`](TBTC.md)\>

Initialized tBTC v2 SDK entrypoint.

**`Throws`**

Throws an error if the signer's Ethereum network is other than
        Ethereum mainnet.

#### Defined in

[services/tbtc.ts:114](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L114)
