# Interface: SerializableWallet

## Table of contents

### Properties

- [index](SerializableWallet.md#index)
- [mainUtxo](SerializableWallet.md#mainutxo)
- [walletBTCBalance](SerializableWallet.md#walletbtcbalance)
- [walletPublicKey](SerializableWallet.md#walletpublickey)

## Properties

### index

• **index**: `number`

Index of the wallet in the list of wallets.

#### Defined in

[lib/utils/types.ts:39](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/types.ts#L39)

___

### mainUtxo

• **mainUtxo**: `Object`

Main UTXO of the wallet.

#### Type declaration

| Name | Type | Description |
| :------ | :------ | :------ |
| `outputIndex` | `number` | Output index of the UTXO. |
| `transactionHash` | `string` | Transaction hash of the UTXO. |
| `value` | `string` | Value of the UTXO in satoshis. |

#### Defined in

[lib/utils/types.ts:49](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/types.ts#L49)

___

### walletBTCBalance

• **walletBTCBalance**: `string`

Balance of the wallet in BTC.

#### Defined in

[lib/utils/types.ts:69](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/types.ts#L69)

___

### walletPublicKey

• **walletPublicKey**: `string`

Public key of the wallet.

#### Defined in

[lib/utils/types.ts:44](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/types.ts#L44)
