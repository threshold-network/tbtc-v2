# Interface: TaprootDepositorCapability

Optional capability exposed by deposit handlers that can safely reveal
Taproot-native deposits end to end.

## Hierarchy

- **`TaprootDepositorCapability`**

  ↳ [`BitcoinDepositor`](BitcoinDepositor.md)

  ↳ [`DepositorProxy`](DepositorProxy.md)

## Table of contents

### Methods

- [supportsTaprootDeposits](TaprootDepositorCapability.md#supportstaprootdeposits)

## Methods

### supportsTaprootDeposits

▸ **supportsTaprootDeposits**(): `boolean`

#### Returns

`boolean`

True only when the complete reveal path preserves both x-only
         public keys required by a Taproot deposit.

#### Defined in

[src/lib/contracts/depositor-proxy.ts:16](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/depositor-proxy.ts#L16)
