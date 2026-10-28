# Interface: ReservationCaps

Values of the on-chain reservation caps.

## Table of contents

### Properties

- [maxActiveReservations](ReservationCaps.md#maxactivereservations)
- [maxAmountPerWallet](ReservationCaps.md#maxamountperwallet)
- [maxSingleAmount](ReservationCaps.md#maxsingleamount)
- [maxThirdPartyReanchorHoldsPerWallet](ReservationCaps.md#maxthirdpartyreanchorholdsperwallet)

## Properties

### maxActiveReservations

• **maxActiveReservations**: `number`

Global cap on the number of active reservations. Zero blocks all
acceptances.

#### Defined in

[src/lib/contracts/reservations.ts:147](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L147)

___

### maxAmountPerWallet

• **maxAmountPerWallet**: `BigNumber`

Per-wallet cap on the total anchored amount in satoshi. Zero means
unlimited.

#### Defined in

[src/lib/contracts/reservations.ts:137](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L137)

___

### maxSingleAmount

• **maxSingleAmount**: `BigNumber`

Cap on the amount of a single reservation in satoshi. Zero means
unlimited.

#### Defined in

[src/lib/contracts/reservations.ts:142](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L142)

___

### maxThirdPartyReanchorHoldsPerWallet

• **maxThirdPartyReanchorHoldsPerWallet**: `number`

Per-target-wallet cap on the number of pending third-party re-anchor
holds.

#### Defined in

[src/lib/contracts/reservations.ts:152](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L152)
