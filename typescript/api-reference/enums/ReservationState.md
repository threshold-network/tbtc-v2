# Enumeration: ReservationState

State of a reservation position, as returned by the on-chain
`reservations` view.

## Table of contents

### Enumeration Members

- [ActionPending](ReservationState.md#actionpending)
- [Active](ReservationState.md#active)
- [Closed](ReservationState.md#closed)
- [Stranded](ReservationState.md#stranded)
- [Unknown](ReservationState.md#unknown)

## Enumeration Members

### ActionPending

• **ActionPending** = ``2``

An action has been requested for the position and is not yet settled.

#### Defined in

[src/lib/contracts/reservations.ts:71](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L71)

___

### Active

• **Active** = ``1``

The reservation was accepted and its anchor outpoint is under wallet
custody, with no action in flight.

#### Defined in

[src/lib/contracts/reservations.ts:67](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L67)

___

### Closed

• **Closed** = ``3``

The reservation was closed: redeemed in-kind or dissolved.

#### Defined in

[src/lib/contracts/reservations.ts:75](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L75)

___

### Stranded

• **Stranded** = ``4``

The custodying wallet was terminated while the anchor was outstanding.

#### Defined in

[src/lib/contracts/reservations.ts:79](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L79)

___

### Unknown

• **Unknown** = ``0``

The reservation is unknown to the Bridge. Acceptance requests are made
against positions in this state.

#### Defined in

[src/lib/contracts/reservations.ts:62](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L62)
