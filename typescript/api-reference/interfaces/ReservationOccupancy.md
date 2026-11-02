# Interface: ReservationOccupancy

Global reservation occupancy as reported by the on-chain view: the
current count and its governance cap.

## Table of contents

### Properties

- [count](ReservationOccupancy.md#count)
- [maxActive](ReservationOccupancy.md#maxactive)

## Properties

### count

• **count**: `number`

Number of active reservations, including capacity reserved by pending
acceptance authorizations.

#### Defined in

[src/lib/contracts/reservations.ts:164](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L164)

___

### maxActive

• **maxActive**: `number`

Global cap on active reservations.

#### Defined in

[src/lib/contracts/reservations.ts:168](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L168)
