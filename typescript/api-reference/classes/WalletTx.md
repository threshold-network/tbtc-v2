# Class: WalletTx

Wallet transactions builder. This feature set is supposed to be used only
for internal purposes like system tests. In real world, tBTC v2 wallets
are formed by peer-to-peer network participants that sign transactions
using threshold signature schemes.

 THIS IS EXPERIMENTAL CODE THAT CAN BE CHANGED OR REMOVED
              IN FUTURE RELEASES. IT SHOULD BE USED ONLY FOR INTERNAL
              PURPOSES AND EXTERNAL APPLICATIONS SHOULD NOT DEPEND ON IT.

## Table of contents

### Constructors

- [constructor](WalletTx.md#constructor)

### Properties

- [depositSweep](WalletTx.md#depositsweep)
- [redemption](WalletTx.md#redemption)

## Constructors

### constructor

• **new WalletTx**(`tbtcContracts`, `bitcoinClient`, `witness?`): [`WalletTx`](WalletTx.md)

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `tbtcContracts` | [`TBTCContracts`](../README.md#tbtccontracts) | `undefined` |
| `bitcoinClient` | [`BitcoinClient`](../interfaces/BitcoinClient.md) | `undefined` |
| `witness` | `boolean` | `true` |

#### Returns

[`WalletTx`](WalletTx.md)

#### Defined in

[services/maintenance/wallet-tx.ts:48](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/wallet-tx.ts#L48)

## Properties

### depositSweep

• `Readonly` **depositSweep**: `DepositSweep`

#### Defined in

[services/maintenance/wallet-tx.ts:45](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/wallet-tx.ts#L45)

___

### redemption

• `Readonly` **redemption**: `Redemption`

#### Defined in

[services/maintenance/wallet-tx.ts:46](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/wallet-tx.ts#L46)
