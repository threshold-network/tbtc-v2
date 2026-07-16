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

[src/services/tbtc-core.ts:48](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc-core.ts#L48)

## Properties

### bitcoinClient

• `Readonly` **bitcoinClient**: [`BitcoinClient`](../interfaces/BitcoinClient.md)

Bitcoin client handle for low-level access.

#### Defined in

[src/services/tbtc-core.ts:46](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc-core.ts#L46)

___

### deposits

• `Readonly` **deposits**: [`DepositsService`](DepositsService.md)

Service supporting the tBTC v2 deposit flow.

#### Defined in

[src/services/tbtc-core.ts:29](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc-core.ts#L29)

___

### maintenance

• `Readonly` **maintenance**: [`MaintenanceService`](MaintenanceService.md)

Service supporting authorized operations of tBTC v2 system maintainers
and operators.

#### Defined in

[src/services/tbtc-core.ts:34](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc-core.ts#L34)

___

### redemptions

• `Readonly` **redemptions**: [`RedemptionsService`](RedemptionsService.md)

Service supporting the tBTC v2 redemption flow.

#### Defined in

[src/services/tbtc-core.ts:38](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc-core.ts#L38)

___

### tbtcContracts

• `Readonly` **tbtcContracts**: [`TBTCContracts`](../README.md#tbtccontracts)

Handle to tBTC contracts for low-level access.

#### Defined in

[src/services/tbtc-core.ts:42](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc-core.ts#L42)

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

[src/services/tbtc-core.ts:163](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc-core.ts#L163)

___

### initializeEthereum

▸ **initializeEthereum**(`ethereumSignerOrProvider`, `ethereumChainId`, `bitcoinNetwork`, `activeWalletIdentityQuorum?`): `Promise`\<[`TBTCCore`](TBTCCore.md)\>

Initializes the tBTC v2 SDK entrypoint for the given Ethereum network
and Bitcoin network. The initialized instance uses default Electrum
servers to interact with Bitcoin network.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `ethereumSignerOrProvider` | [`EthereumSigner`](../README.md#ethereumsigner) | Ethereum signer or provider. |
| `ethereumChainId` | [`Ethereum`](../enums/Chains.Ethereum.md) | Ethereum chain ID. |
| `bitcoinNetwork` | [`BitcoinNetwork`](../enums/BitcoinNetwork-1.md) | Bitcoin network. |
| `activeWalletIdentityQuorum?` | [`EthereumActiveWalletIdentityQuorum`](../interfaces/EthereumActiveWalletIdentityQuorum.md) | Independent finalized-state provider required before the SDK can create deposit addresses. |

#### Returns

`Promise`\<[`TBTCCore`](TBTCCore.md)\>

Initialized tBTC v2 SDK entrypoint.

**`Throws`**

Throws an error if the underlying signer's Ethereum network is
        other than the given Ethereum network.

#### Defined in

[src/services/tbtc-core.ts:126](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc-core.ts#L126)

___

### initializeMainnet

▸ **initializeMainnet**(`ethereumSignerOrProvider`, `activeWalletIdentityQuorum?`): `Promise`\<[`TBTCCore`](TBTCCore.md)\>

Initializes the tBTC v2 SDK entrypoint for Ethereum and Bitcoin mainnets.
The initialized instance uses default Electrum servers to interact
with Bitcoin mainnet

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `ethereumSignerOrProvider` | [`EthereumSigner`](../README.md#ethereumsigner) | Ethereum signer or provider. |
| `activeWalletIdentityQuorum?` | [`EthereumActiveWalletIdentityQuorum`](../interfaces/EthereumActiveWalletIdentityQuorum.md) | Independent finalized-state provider required before the SDK can create deposit addresses. |

#### Returns

`Promise`\<[`TBTCCore`](TBTCCore.md)\>

Initialized tBTC v2 SDK entrypoint.

**`Throws`**

Throws an error if the signer's Ethereum network is other than
        Ethereum mainnet.

#### Defined in

[src/services/tbtc-core.ts:70](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc-core.ts#L70)

___

### initializeSepolia

▸ **initializeSepolia**(`ethereumSignerOrProvider`, `activeWalletIdentityQuorum?`): `Promise`\<[`TBTCCore`](TBTCCore.md)\>

Initializes the tBTC v2 SDK entrypoint for Ethereum Sepolia and Bitcoin testnet4.
The initialized instance uses default Electrum servers to interact
with Bitcoin testnet4.

BREAKING CHANGE (v4): This method previously connected to Bitcoin testnet3
(BitcoinNetwork.Testnet). It now connects to Bitcoin testnet4
(BitcoinNetwork.Testnet4, BIP-94). Both networks share the same address
prefixes (tb1/m/2), so callers will not see a compile-time or runtime
error -- they will silently connect to the wrong Bitcoin network if not
updated. Update your integration to testnet4 Bitcoin tooling before
upgrading this SDK.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `ethereumSignerOrProvider` | [`EthereumSigner`](../README.md#ethereumsigner) | Ethereum signer or provider. |
| `activeWalletIdentityQuorum?` | [`EthereumActiveWalletIdentityQuorum`](../interfaces/EthereumActiveWalletIdentityQuorum.md) | Independent finalized-state provider required before the SDK can create deposit addresses. |

#### Returns

`Promise`\<[`TBTCCore`](TBTCCore.md)\>

Initialized tBTC v2 SDK entrypoint.

**`Throws`**

Throws an error if the signer's Ethereum network is other than
        Ethereum mainnet.

#### Defined in

[src/services/tbtc-core.ts:101](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/tbtc-core.ts#L101)
