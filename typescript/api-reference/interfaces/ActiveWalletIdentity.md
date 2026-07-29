# Interface: ActiveWalletIdentity

Canonically bound identity of an active Bridge wallet.

## Table of contents

### Properties

- [walletID](ActiveWalletIdentity.md#walletid)
- [walletPublicKeyHash](ActiveWalletIdentity.md#walletpublickeyhash)

## Properties

### walletID

• **walletID**: [`Hex`](../classes/Hex.md)

Canonical wallet ID: a legacy alias or native FROST x-only key.

#### Defined in

[src/lib/contracts/bridge.ts:272](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L272)

___

### walletPublicKeyHash

• **walletPublicKeyHash**: [`Hex`](../classes/Hex.md)

20-byte compatibility public-key hash used by legacy Bridge paths.

#### Defined in

[src/lib/contracts/bridge.ts:270](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L270)
