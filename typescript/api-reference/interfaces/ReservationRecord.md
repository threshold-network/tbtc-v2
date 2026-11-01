# Interface: ReservationRecord

On-chain record of a reservation position.

## Table of contents

### Properties

- [acceptedAt](ReservationRecord.md#acceptedat)
- [anchorAmount](ReservationRecord.md#anchoramount)
- [anchorTxHash](ReservationRecord.md#anchortxhash)
- [anchorTxOutputIndex](ReservationRecord.md#anchortxoutputindex)
- [expiresAt](ReservationRecord.md#expiresat)
- [mintedAmount](ReservationRecord.md#mintedamount)
- [owner](ReservationRecord.md#owner)
- [requestNonce](ReservationRecord.md#requestnonce)
- [state](ReservationRecord.md#state)
- [walletPublicKeyHash](ReservationRecord.md#walletpublickeyhash)

## Properties

### acceptedAt

• **acceptedAt**: `number`

UNIX timestamp the reservation was accepted at.

#### Defined in

[src/lib/contracts/reservations.ts:187](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L187)

___

### anchorAmount

• **anchorAmount**: `BigNumber`

Value in satoshi of the current anchor outpoint.

#### Defined in

[src/lib/contracts/reservations.ts:195](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L195)

___

### anchorTxHash

• **anchorTxHash**: [`Hex`](../classes/Hex.md)

Hash of the Bitcoin transaction holding the current anchor output,
in Bitcoin internal byte order.

#### Defined in

[src/lib/contracts/reservations.ts:204](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L204)

___

### anchorTxOutputIndex

• **anchorTxOutputIndex**: `number`

Output index of the current anchor output.

#### Defined in

[src/lib/contracts/reservations.ts:208](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L208)

___

### expiresAt

• **expiresAt**: `number`

UNIX timestamp the custody term expires at.

#### Defined in

[src/lib/contracts/reservations.ts:199](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L199)

___

### mintedAmount

• **mintedAmount**: `BigNumber`

Gross amount in satoshi credited to the owner at acceptance time.

#### Defined in

[src/lib/contracts/reservations.ts:183](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L183)

___

### owner

• `Optional` **owner**: [`ChainIdentifier`](ChainIdentifier.md)

The reservation owner holding the in-kind redemption right. Zero on
chain before the reservation is accepted, hence undefined in the SDK.

#### Defined in

[src/lib/contracts/reservations.ts:179](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L179)

___

### requestNonce

• **requestNonce**: `number`

Monotonic generation counter. Incremented by every action request.

#### Defined in

[src/lib/contracts/reservations.ts:216](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L216)

___

### state

• **state**: [`ReservationState`](../enums/ReservationState.md)

Current state of the reservation position.

#### Defined in

[src/lib/contracts/reservations.ts:212](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L212)

___

### walletPublicKeyHash

• **walletPublicKeyHash**: [`Hex`](../classes/Hex.md)

20-byte public key hash of the wallet custodising the current anchor.

#### Defined in

[src/lib/contracts/reservations.ts:191](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L191)
