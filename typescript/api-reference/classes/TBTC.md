# Class: TBTC

Full tBTC v2 SDK entrypoint with cross-chain (L2) support.

Extends the base TBTC class with `initializeCrossChain` for L2 bridging.
Chain-specific modules (Solana, StarkNet, Sui, Base, Arbitrum) are loaded
on demand when `initializeCrossChain` is called.

For consumers not interested in the cross-chain (L2) support, use the `/core`
subpath which exports the base TBTC class.

## Hierarchy

- [`TBTCCore`](TBTCCore.md)

  ↳ **`TBTC`**

## Table of contents

### Constructors

- [constructor](TBTC.md#constructor)

### Properties

- [\_crossChainContracts](TBTC.md#_crosschaincontracts)
- [\_crossChainContractsLoader](TBTC.md#_crosschaincontractsloader)
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

#### Overrides

[TBTCCore](TBTCCore.md).[constructor](TBTCCore.md#constructor)

#### Defined in

[services/tbtc.ts:40](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L40)

## Properties

### \_crossChainContracts

• `Private` `Readonly` **\_crossChainContracts**: `Map`\<[`DestinationChainName`](../README.md#destinationchainname), [`CrossChainInterfaces`](../README.md#crosschaininterfaces)\>

#### Defined in

[services/tbtc.ts:35](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L35)

___

### \_crossChainContractsLoader

• `Private` `Optional` **\_crossChainContractsLoader**: [`CrossChainContractsLoader`](../interfaces/CrossChainContractsLoader.md)

#### Defined in

[services/tbtc.ts:33](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L33)

___

### \_l2Signer

• `Optional` **\_l2Signer**: [`EthereumSigner`](../README.md#ethereumsigner) \| `SuiSignerWithAddress` \| [`StarkNetProvider`](../README.md#starknetprovider) \| `AnchorProvider`

Internal property to store L2 signer/provider for advanced use cases.

**`Deprecated`**

Will be removed in next major version.

#### Defined in

[services/tbtc.ts:191](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L191)

___

### bitcoinClient

• `Readonly` **bitcoinClient**: [`BitcoinClient`](../interfaces/BitcoinClient.md)

Bitcoin client handle for low-level access.

#### Inherited from

[TBTCCore](TBTCCore.md).[bitcoinClient](TBTCCore.md#bitcoinclient)

#### Defined in

[services/tbtc-core.ts:45](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc-core.ts#L45)

___

### deposits

• `Readonly` **deposits**: [`DepositsService`](DepositsService.md)

Service supporting the tBTC v2 deposit flow.

#### Inherited from

[TBTCCore](TBTCCore.md).[deposits](TBTCCore.md#deposits)

#### Defined in

[services/tbtc-core.ts:28](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc-core.ts#L28)

___

### maintenance

• `Readonly` **maintenance**: [`MaintenanceService`](MaintenanceService.md)

Service supporting authorized operations of tBTC v2 system maintainers
and operators.

#### Inherited from

[TBTCCore](TBTCCore.md).[maintenance](TBTCCore.md#maintenance)

#### Defined in

[services/tbtc-core.ts:33](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc-core.ts#L33)

___

### redemptions

• `Readonly` **redemptions**: [`RedemptionsService`](RedemptionsService.md)

Service supporting the tBTC v2 redemption flow.

#### Inherited from

[TBTCCore](TBTCCore.md).[redemptions](TBTCCore.md#redemptions)

#### Defined in

[services/tbtc-core.ts:37](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc-core.ts#L37)

___

### tbtcContracts

• `Readonly` **tbtcContracts**: [`TBTCContracts`](../README.md#tbtccontracts)

Handle to tBTC contracts for low-level access.

#### Inherited from

[TBTCCore](TBTCCore.md).[tbtcContracts](TBTCCore.md#tbtccontracts)

#### Defined in

[services/tbtc-core.ts:41](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc-core.ts#L41)

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

[services/tbtc.ts:369](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L369)

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
| `signerOrEthereumSigner` | [`EthereumSigner`](../README.md#ethereumsigner) \| `SuiSignerWithAddress` \| [`StarkNetProvider`](../README.md#starknetprovider) \| `AnchorProvider` | For StarkNet: StarkNet provider/account. For SUI: SUI signer/wallet. For Solana: Solana provider. For other L2s: Ethereum signer. |

#### Returns

`Promise`\<`void`\>

Void promise

**`Throws`**

Throws an error if:
        - Cross-chain contracts loader not available
        - Invalid provider type for StarkNet or SUI
        - No connected account in StarkNet provider

#### Defined in

[services/tbtc.ts:231](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L231)

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

[services/tbtc.ts:145](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L145)

___

### initializeCustom

▸ **initializeCustom**(`tbtcContracts`, `bitcoinClient`): `Promise`\<[`TBTCCore`](TBTCCore.md)\>

Initializes the tBTC v2 SDK entrypoint with custom tBTC contracts and
Bitcoin client.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `tbtcContracts` | [`TBTCContracts`](../README.md#tbtccontracts) | Custom tBTC contracts handle. |
| `bitcoinClient` | [`BitcoinClient`](../interfaces/BitcoinClient.md) | Custom Bitcoin client implementation. |

#### Returns

`Promise`\<[`TBTCCore`](TBTCCore.md)\>

Initialized tBTC v2 SDK entrypoint.

**`Dev`**

This function is especially useful for local development as it gives
     flexibility to combine different implementations of tBTC v2 contracts
     with different Bitcoin networks.

#### Inherited from

[TBTCCore](TBTCCore.md).[initializeCustom](TBTCCore.md#initializecustom)

#### Defined in

[services/tbtc-core.ts:142](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc-core.ts#L142)

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

#### Overrides

[TBTCCore](TBTCCore.md).[initializeEthereum](TBTCCore.md#initializeethereum)

#### Defined in

[services/tbtc.ts:105](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L105)

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

#### Overrides

[TBTCCore](TBTCCore.md).[initializeMainnet](TBTCCore.md#initializemainnet)

#### Defined in

[services/tbtc.ts:59](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L59)

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

#### Overrides

[TBTCCore](TBTCCore.md).[initializeSepolia](TBTCCore.md#initializesepolia)

#### Defined in

[services/tbtc.ts:81](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L81)
