# Interface: ReservationActionRecord

On-chain record of a single reservation action generation.

## Table of contents

### Properties

- [actionType](ReservationActionRecord.md#actiontype)
- [amount](ReservationActionRecord.md#amount)
- [minAmount](ReservationActionRecord.md#minamount)
- [requestedAt](ReservationActionRecord.md#requestedat)
- [state](ReservationActionRecord.md#state)
- [targetWalletPublicKeyHash](ReservationActionRecord.md#targetwalletpublickeyhash)
- [termSeconds](ReservationActionRecord.md#termseconds)
- [timeoutAt](ReservationActionRecord.md#timeoutat)
- [txMaxFee](ReservationActionRecord.md#txmaxfee)

## Properties

### actionType

• **actionType**: [`ReservationActionType`](../enums/ReservationActionType.md)

Type of the action.

#### Defined in

[src/lib/contracts/reservations.ts:242](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L242)

___

### amount

• **amount**: `BigNumber`

Amount in satoshi associated with the generation.

#### Defined in

[src/lib/contracts/reservations.ts:250](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L250)

___

### minAmount

• **minAmount**: `BigNumber`

Snapshotted minimum reservation amount of the generation, in satoshi.

#### Defined in

[src/lib/contracts/reservations.ts:258](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L258)

___

### requestedAt

• **requestedAt**: `number`

UNIX timestamp the action was requested at.

#### Defined in

[src/lib/contracts/reservations.ts:230](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L230)

___

### state

• **state**: [`ReservationActionState`](../enums/ReservationActionState.md)

Settlement state of the action.

#### Defined in

[src/lib/contracts/reservations.ts:246](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L246)

___

### targetWalletPublicKeyHash

• **targetWalletPublicKeyHash**: [`Hex`](../classes/Hex.md)

20-byte public key hash of the wallet the action's output must pay to.

#### Defined in

[src/lib/contracts/reservations.ts:226](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L226)

___

### termSeconds

• **termSeconds**: `number`

Snapshotted reservation custody term of the generation, in seconds.

#### Defined in

[src/lib/contracts/reservations.ts:254](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L254)

___

### timeoutAt

• **timeoutAt**: `number`

UNIX timestamp after which the action can be reported timed out.

#### Defined in

[src/lib/contracts/reservations.ts:234](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L234)

___

### txMaxFee

• **txMaxFee**: `BigNumber`

Snapshotted maximum Bitcoin miner fee for the action transaction.

#### Defined in

[src/lib/contracts/reservations.ts:238](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L238)
