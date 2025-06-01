# Class: TBTC

Entrypoint component of the tBTC v2 SDK.

## Table of contents

### Constructors

- [constructor](TBTC.md#constructor)

### Properties

- [#crossChainContracts](TBTC.md##crosschaincontracts)
- [#crossChainContractsLoader](TBTC.md##crosschaincontractsloader)
- [bitcoinClient](TBTC.md#bitcoinclient)
- [deposits](TBTC.md#deposits)
- [maintenance](TBTC.md#maintenance)
- [redemptions](TBTC.md#redemptions)
- [tbtcContracts](TBTC.md#tbtccontracts)

### Methods

- [crossChainContracts](TBTC.md#crosschaincontracts)
- [initializeCrossChain](TBTC.md#initializecrosschain)
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

[services/tbtc.ts:61](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L61)

## Properties

### #crossChainContracts

• `Private` `Readonly` **#crossChainContracts**: `Map`\<[`L2Chain`](../README.md#l2chain), [`CrossChainContracts`](../README.md#crosschaincontracts)\>

Mapping of cross-chain contracts for different supported L2 chains.
Each set of cross-chain contracts must be first initialized using
the `initializeCrossChain` method.

#### Defined in

[services/tbtc.ts:59](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L59)

___

### #crossChainContractsLoader

• `Private` `Optional` `Readonly` **#crossChainContractsLoader**: [`CrossChainContractsLoader`](../interfaces/CrossChainContractsLoader.md)

Reference to the cross-chain contracts loader.

#### Defined in

[services/tbtc.ts:53](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L53)

___

### bitcoinClient

• `Readonly` **bitcoinClient**: [`BitcoinClient`](../interfaces/BitcoinClient.md)

Bitcoin client handle for low-level access.

#### Defined in

[services/tbtc.ts:49](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L49)

___

### deposits

• `Readonly` **deposits**: [`DepositsService`](DepositsService.md)

Service supporting the tBTC v2 deposit flow.

#### Defined in

[services/tbtc.ts:32](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L32)

___

### maintenance

• `Readonly` **maintenance**: [`MaintenanceService`](MaintenanceService.md)

Service supporting authorized operations of tBTC v2 system maintainers
and operators.

#### Defined in

[services/tbtc.ts:37](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L37)

___

### redemptions

• `Readonly` **redemptions**: [`RedemptionsService`](RedemptionsService.md)

Service supporting the tBTC v2 redemption flow.

#### Defined in

[services/tbtc.ts:41](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L41)

___

### tbtcContracts

• `Readonly` **tbtcContracts**: [`TBTCContracts`](../README.md#tbtccontracts)

Handle to tBTC contracts for low-level access.

#### Defined in

[services/tbtc.ts:45](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L45)

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

[services/tbtc.ts:293](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L293)

___

### initializeCrossChain

▸ **initializeCrossChain**(`l2ChainName`, `l2Signer`): `Promise`\<`void`\>

Initializes cross-chain contracts for the given L2 chain, using the
given signer. Updates the signer on subsequent calls.

 THIS IS EXPERIMENTAL CODE THAT CAN BE CHANGED OR REMOVED
              IN FUTURE RELEASES. IT SHOULD BE USED ONLY FOR INTERNAL
              PURPOSES AND EXTERNAL APPLICATIONS SHOULD NOT DEPEND ON IT.
              CROSS-CHAIN SUPPORT IS NOT FULLY OPERATIONAL YET.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `l2ChainName` | [`L2Chain`](../README.md#l2chain) | Name of the L2 chain for which to initialize cross-chain contracts. |
| `l2Signer` | [`EthereumSigner`](../README.md#ethereumsigner) | Signer to use with the L2 chain contracts. For StarkNet, this is used to extract the wallet address since StarkNet uses wallet addresses instead of signers. |

#### Returns

`Promise`\<`void`\>

Void promise.

**`Throws`**

Throws an error if:
        - Cross-chain contracts loader is not available for this TBTC SDK instance,
        - Chain mapping between the L1 and the given L2 chain is not defined,
        - StarkNet chain ID is not available in chain mapping (StarkNet only),
        - Could not extract wallet address from signer (StarkNet only).

**`Dev`**

In case this function needs to support non-EVM L2 chains that can't
     use EthereumSigner as a signer type, the l2Signer parameter should
     probably be turned into a union of multiple supported types or
     generalized in some other way.

#### Defined in

[services/tbtc.ts:214](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L214)

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

[services/tbtc.ts:182](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L182)

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

[services/tbtc.ts:135](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L135)

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

[services/tbtc.ts:89](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L89)

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

[services/tbtc.ts:111](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc.ts#L111)
