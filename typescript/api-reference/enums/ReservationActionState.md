# Enumeration: ReservationActionState

Settlement state of a reservation action generation, as returned by the
on-chain `reservationActions` view.

## Table of contents

### Enumeration Members

- [Pending](ReservationActionState.md#pending)
- [Settled](ReservationActionState.md#settled)
- [Superseded](ReservationActionState.md#superseded)
- [TimedOut](ReservationActionState.md#timedout)
- [Unknown](ReservationActionState.md#unknown)
- [Vetoed](ReservationActionState.md#vetoed)

## Enumeration Members

### Pending

• **Pending** = ``1``

The action is requested and awaiting its SPV proof.

#### Defined in

[src/lib/contracts/reservations.ts:20](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L20)

___

### Settled

• **Settled** = ``2``

The action was proven and settled.

#### Defined in

[src/lib/contracts/reservations.ts:24](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L24)

___

### Superseded

• **Superseded** = ``5``

The action's anchor was consumed by a late settlement of an older
timed-out generation.

#### Defined in

[src/lib/contracts/reservations.ts:38](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L38)

___

### TimedOut

• **TimedOut** = ``3``

The action timed out. A late proof of an already confirmed Bitcoin
transaction is still accepted against this record.

#### Defined in

[src/lib/contracts/reservations.ts:29](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L29)

___

### Unknown

• **Unknown** = ``0``

No action was ever requested under this key.

#### Defined in

[src/lib/contracts/reservations.ts:16](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L16)

___

### Vetoed

• **Vetoed** = ``4``

The action was vetoed by the redemption watchtower.

#### Defined in

[src/lib/contracts/reservations.ts:33](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L33)
