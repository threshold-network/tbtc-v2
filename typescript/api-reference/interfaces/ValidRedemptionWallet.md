# Interface: ValidRedemptionWallet

## Hierarchy

- `Omit`\<[`RedemptionWallet`](RedemptionWallet.md), ``"redeemerOutputScript"``\>

  ↳ **`ValidRedemptionWallet`**

## Table of contents

### Properties

- [index](ValidRedemptionWallet.md#index)
- [mainUtxo](ValidRedemptionWallet.md#mainutxo)
- [walletBTCBalance](ValidRedemptionWallet.md#walletbtcbalance)
- [walletPublicKey](ValidRedemptionWallet.md#walletpublickey)

## Properties

### index

• **index**: `number`

Index of the wallet in the list of wallets.

#### Defined in

[lib/utils/types.ts:27](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/types.ts#L27)

___

### mainUtxo

• **mainUtxo**: [`BitcoinUtxo`](../README.md#bitcoinutxo)

Main UTXO of the wallet.

#### Inherited from

Omit.mainUtxo

#### Defined in

[lib/utils/types.ts:14](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/types.ts#L14)

___

### walletBTCBalance

• **walletBTCBalance**: `BigNumber`

Balance of the wallet in BTC.

#### Defined in

[lib/utils/types.ts:32](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/types.ts#L32)

___

### walletPublicKey

• **walletPublicKey**: [`Hex`](../classes/Hex.md)

Public key of the wallet.

#### Inherited from

Omit.walletPublicKey

#### Defined in

[lib/utils/types.ts:9](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/types.ts#L9)
