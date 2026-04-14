# Class: TBTCCore

Entrypoint component of the tBTC v2 SDK.

This base class provides core tBTC functionality (deposits, maintenance,
redemptions) without importing chain-specific modules. Use this when only
the core functionality of Bitcoin-to-Ethereum bridging is needed.

For cross-chain support (L2 bridging), import from the root entry point
which provides the full TBTC class with `initializeCrossChain`.

## Hierarchy

- **`TBTCCore`**

  ↳ [`TBTC`](TBTC.md)

## Table of contents

### Constructors

- [constructor](TBTCCore.md#constructor)

### Properties

- [bitcoinClient](TBTCCore.md#bitcoinclient)
- [deposits](TBTCCore.md#deposits)
- [maintenance](TBTCCore.md#maintenance)
- [redemptions](TBTCCore.md#redemptions)
- [tbtcContracts](TBTCCore.md#tbtccontracts)

### Methods

- [initializeCustom](TBTCCore.md#initializecustom)
- [initializeEthereum](TBTCCore.md#initializeethereum)
- [initializeMainnet](TBTCCore.md#initializemainnet)
- [initializeSepolia](TBTCCore.md#initializesepolia)

## Constructors

### constructor

• **new TBTCCore**(`tbtcContracts`, `bitcoinClient`): [`TBTCCore`](TBTCCore.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `tbtcContracts` | [`TBTCContracts`](../README.md#tbtccontracts) |
| `bitcoinClient` | [`BitcoinClient`](../interfaces/BitcoinClient.md) |

#### Returns

[`TBTCCore`](TBTCCore.md)

#### Defined in

[services/tbtc-core.ts:47](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc-core.ts#L47)

## Properties

### bitcoinClient

• `Readonly` **bitcoinClient**: [`BitcoinClient`](../interfaces/BitcoinClient.md)

Bitcoin client handle for low-level access.

#### Defined in

[services/tbtc-core.ts:45](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc-core.ts#L45)

___

### deposits

• `Readonly` **deposits**: [`DepositsService`](DepositsService.md)

Service supporting the tBTC v2 deposit flow.

#### Defined in

[services/tbtc-core.ts:28](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc-core.ts#L28)

___

### maintenance

• `Readonly` **maintenance**: [`MaintenanceService`](MaintenanceService.md)

Service supporting authorized operations of tBTC v2 system maintainers
and operators.

#### Defined in

[services/tbtc-core.ts:33](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc-core.ts#L33)

___

### redemptions

• `Readonly` **redemptions**: [`RedemptionsService`](RedemptionsService.md)

Service supporting the tBTC v2 redemption flow.

#### Defined in

[services/tbtc-core.ts:37](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc-core.ts#L37)

___

### tbtcContracts

• `Readonly` **tbtcContracts**: [`TBTCContracts`](../README.md#tbtccontracts)

Handle to tBTC contracts for low-level access.

#### Defined in

[services/tbtc-core.ts:41](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc-core.ts#L41)

## Methods

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

#### Defined in

[services/tbtc-core.ts:142](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc-core.ts#L142)

___

### initializeEthereum

▸ **initializeEthereum**(`ethereumSignerOrProvider`, `ethereumChainId`, `bitcoinNetwork`): `Promise`\<[`TBTCCore`](TBTCCore.md)\>

Initializes the tBTC v2 SDK entrypoint for the given Ethereum network
and Bitcoin network. The initialized instance uses default Electrum
servers to interact with Bitcoin network.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `ethereumSignerOrProvider` | [`EthereumSigner`](../README.md#ethereumsigner) | Ethereum signer or provider. |
| `ethereumChainId` | [`Ethereum`](../enums/Chains.Ethereum.md) | Ethereum chain ID. |
| `bitcoinNetwork` | [`BitcoinNetwork`](../enums/BitcoinNetwork-1.md) | Bitcoin network. |

#### Returns

`Promise`\<[`TBTCCore`](TBTCCore.md)\>

Initialized tBTC v2 SDK entrypoint.

**`Throws`**

Throws an error if the underlying signer's Ethereum network is
        other than the given Ethereum network.

#### Defined in

[services/tbtc-core.ts:107](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc-core.ts#L107)

___

### initializeMainnet

▸ **initializeMainnet**(`ethereumSignerOrProvider`): `Promise`\<[`TBTCCore`](TBTCCore.md)\>

Initializes the tBTC v2 SDK entrypoint for Ethereum and Bitcoin mainnets.
The initialized instance uses default Electrum servers to interact
with Bitcoin mainnet

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `ethereumSignerOrProvider` | [`EthereumSigner`](../README.md#ethereumsigner) | Ethereum signer or provider. |

#### Returns

`Promise`\<[`TBTCCore`](TBTCCore.md)\>

Initialized tBTC v2 SDK entrypoint.

**`Throws`**

Throws an error if the signer's Ethereum network is other than
        Ethereum mainnet.

#### Defined in

[services/tbtc-core.ts:67](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc-core.ts#L67)

___

### initializeSepolia

▸ **initializeSepolia**(`ethereumSignerOrProvider`): `Promise`\<[`TBTCCore`](TBTCCore.md)\>

Initializes the tBTC v2 SDK entrypoint for Ethereum Sepolia and Bitcoin testnet.
The initialized instance uses default Electrum servers to interact
with Bitcoin testnet

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `ethereumSignerOrProvider` | [`EthereumSigner`](../README.md#ethereumsigner) | Ethereum signer or provider. |

#### Returns

`Promise`\<[`TBTCCore`](TBTCCore.md)\>

Initialized tBTC v2 SDK entrypoint.

**`Throws`**

Throws an error if the signer's Ethereum network is other than
        Ethereum mainnet.

#### Defined in

[services/tbtc-core.ts:86](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc-core.ts#L86)
