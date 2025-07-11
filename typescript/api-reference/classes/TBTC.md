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

[services/tbtc.ts:68](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L68)

## Properties

### #crossChainContracts

• `Private` `Readonly` **#crossChainContracts**: `Map`\<[`DestinationChainName`](../README.md#destinationchainname), [`CrossChainInterfaces`](../README.md#crosschaininterfaces)\>

Mapping of cross-chain contracts for different supported L2 chains.
Each set of cross-chain contracts must be first initialized using
the `initializeCrossChain` method.

#### Defined in

[services/tbtc.ts:66](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L66)

___

### #crossChainContractsLoader

• `Private` `Optional` `Readonly` **#crossChainContractsLoader**: [`CrossChainContractsLoader`](../interfaces/CrossChainContractsLoader.md)

Reference to the cross-chain contracts loader.

#### Defined in

[services/tbtc.ts:60](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L60)

___

### \_l2Signer

• `Optional` **\_l2Signer**: `SuiSignerWithAddress` \| [`StarkNetProvider`](../README.md#starknetprovider) \| `AnchorProvider` \| [`EthereumSigner`](../README.md#ethereumsigner)

Internal property to store L2 signer/provider for advanced use cases.

**`Deprecated`**

Will be removed in next major version.

#### Defined in

[services/tbtc.ts:258](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L258)

___

### bitcoinClient

• `Readonly` **bitcoinClient**: [`BitcoinClient`](../interfaces/BitcoinClient.md)

Bitcoin client handle for low-level access.

#### Defined in

[services/tbtc.ts:56](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L56)

___

### deposits

• `Readonly` **deposits**: [`DepositsService`](DepositsService.md)

Service supporting the tBTC v2 deposit flow.

#### Defined in

[services/tbtc.ts:39](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L39)

___

### maintenance

• `Readonly` **maintenance**: [`MaintenanceService`](MaintenanceService.md)

Service supporting authorized operations of tBTC v2 system maintainers
and operators.

#### Defined in

[services/tbtc.ts:44](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L44)

___

### redemptions

• `Readonly` **redemptions**: [`RedemptionsService`](RedemptionsService.md)

Service supporting the tBTC v2 redemption flow.

#### Defined in

[services/tbtc.ts:48](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L48)

___

### tbtcContracts

• `Readonly` **tbtcContracts**: [`TBTCContracts`](../README.md#tbtccontracts)

Handle to tBTC contracts for low-level access.

#### Defined in

[services/tbtc.ts:52](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L52)

## Methods

### crossChainContracts

▸ **crossChainContracts**(`l2ChainName`): `undefined` \| [`CrossChainInterfaces`](../README.md#crosschaininterfaces)

Gets cross-chain contracts for the given supported L2 chain.
The given destination chain contracts must be first initialized using the
`initializeCrossChain` method.

 THIS IS EXPERIMENTAL CODE THAT CAN BE CHANGED OR REMOVED
              IN FUTURE RELEASES. IT SHOULD BE USED ONLY FOR INTERNAL
              PURPOSES AND EXTERNAL APPLICATIONS SHOULD NOT DEPEND ON IT.
              CROSS-CHAIN SUPPORT IS NOT FULLY OPERATIONAL YET.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `l2ChainName` | [`DestinationChainName`](../README.md#destinationchainname) | Name of the destination chain for which to get cross-chain contracts. |

#### Returns

`undefined` \| [`CrossChainInterfaces`](../README.md#crosschaininterfaces)

Cross-chain contracts for the given L2 chain or
         undefined if not initialized.

#### Defined in

[services/tbtc.ts:437](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L437)

___

### initializeCrossChain

▸ **initializeCrossChain**(`l2ChainName`, `signerOrEthereumSigner`): `Promise`\<`void`\>

Initializes cross-chain contracts for the given L2 chain.

For StarkNet, use single-parameter initialization:
```
await tbtc.initializeCrossChain("StarkNet", starknetProvider)
```

For SUI, use single-parameter initialization:
```
await tbtc.initializeCrossChain("Sui", suiSigner)
```

For other L2 chains, use the standard pattern:
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
| `l2ChainName` | [`DestinationChainName`](../README.md#destinationchainname) | Name of the L2 chain |
| `signerOrEthereumSigner` | `SuiSignerWithAddress` \| [`StarkNetProvider`](../README.md#starknetprovider) \| [`EthereumSigner`](../README.md#ethereumsigner) | For StarkNet: StarkNet provider/account. For SUI: SUI signer/wallet. For Solana: Solana provider. For other L2s: Ethereum signer. |

#### Returns

`Promise`\<`void`\>

Void promise

**`Throws`**

Throws an error if:
        - Cross-chain contracts loader not available
        - Invalid provider type for StarkNet or SUI
        - No connected account in StarkNet provider
        - Two-parameter mode is used for StarkNet or SUI (no longer supported)

**`Example`**

```ts
// StarkNet with single parameter
const starknetAccount = await starknet.connect();
await tbtc.initializeCrossChain("StarkNet", starknetAccount);

// SUI with single parameter
const suiWallet = await wallet.connect();
await tbtc.initializeCrossChain("Sui", suiWallet);
```

#### Defined in

[services/tbtc.ts:309](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L309)

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

[services/tbtc.ts:212](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L212)

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

[services/tbtc.ts:198](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L198)

___

### initializeEthereum

▸ **initializeEthereum**(`ethereumSignerOrProvider`, `ethereumChainId`, `bitcoinNetwork`, `crossChainSupport?`): `Promise`\<[`TBTC`](TBTC.md)\>

Initializes the tBTC v2 SDK entrypoint for the given Ethereum network and Bitcoin network.
The initialized instance uses default Electrum servers to interact
with Bitcoin network.

#### Parameters

| Name | Type | Default value | Description |
| :------ | :------ | :------ | :------ |
| `ethereumSignerOrProvider` | [`EthereumSigner`](../README.md#ethereumsigner) | `undefined` | Ethereum signer or provider. |
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

[services/tbtc.ts:149](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L149)

___

### initializeMainnet

▸ **initializeMainnet**(`ethereumSignerOrProvider`, `crossChainSupport?`): `Promise`\<[`TBTC`](TBTC.md)\>

Initializes the tBTC v2 SDK entrypoint for Ethereum and Bitcoin mainnets.
The initialized instance uses default Electrum servers to interact
with Bitcoin mainnet

#### Parameters

| Name | Type | Default value | Description |
| :------ | :------ | :------ | :------ |
| `ethereumSignerOrProvider` | [`EthereumSigner`](../README.md#ethereumsigner) | `undefined` | Ethereum signer or provider. |
| `crossChainSupport` | `boolean` | `false` | Whether to enable cross-chain support. False by default. |

#### Returns

`Promise`\<[`TBTC`](TBTC.md)\>

Initialized tBTC v2 SDK entrypoint.

**`Throws`**

Throws an error if the signer's Ethereum network is other than
        Ethereum mainnet.

#### Defined in

[services/tbtc.ts:103](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L103)

___

### initializeSepolia

▸ **initializeSepolia**(`ethereumSignerOrProvider`, `crossChainSupport?`): `Promise`\<[`TBTC`](TBTC.md)\>

Initializes the tBTC v2 SDK entrypoint for Ethereum Sepolia and Bitcoin testnet.
The initialized instance uses default Electrum servers to interact
with Bitcoin testnet

#### Parameters

| Name | Type | Default value | Description |
| :------ | :------ | :------ | :------ |
| `ethereumSignerOrProvider` | [`EthereumSigner`](../README.md#ethereumsigner) | `undefined` | Ethereum signer or provider. |
| `crossChainSupport` | `boolean` | `false` | Whether to enable cross-chain support. False by default. |

#### Returns

`Promise`\<[`TBTC`](TBTC.md)\>

Initialized tBTC v2 SDK entrypoint.

**`Throws`**

Throws an error if the signer's Ethereum network is other than
        Ethereum mainnet.

#### Defined in

[services/tbtc.ts:125](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L125)
