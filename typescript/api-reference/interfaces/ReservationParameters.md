# Interface: ReservationParameters

Values of the on-chain reservation parameters.

## Table of contents

### Properties

- [actionTimeoutSeconds](ReservationParameters.md#actiontimeoutseconds)
- [dissolutionDelaySeconds](ReservationParameters.md#dissolutiondelayseconds)
- [maxReservationsPerWallet](ReservationParameters.md#maxreservationsperwallet)
- [maxTotalAmount](ReservationParameters.md#maxtotalamount)
- [minAmount](ReservationParameters.md#minamount)
- [termSeconds](ReservationParameters.md#termseconds)
- [totalAmount](ReservationParameters.md#totalamount)
- [txMaxFee](ReservationParameters.md#txmaxfee)
- [vault](ReservationParameters.md#vault)

## Properties

### actionTimeoutSeconds

• **actionTimeoutSeconds**: `number`

Timeout in seconds for the reservation actions.

#### Defined in

[src/lib/contracts/reservations.ts:126](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L126)

___

### dissolutionDelaySeconds

• **dissolutionDelaySeconds**: `number`

Delay in seconds after the term expires at which the reservation
becomes dissolvable.

#### Defined in

[src/lib/contracts/reservations.ts:109](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L109)

___

### maxReservationsPerWallet

• **maxReservationsPerWallet**: `number`

Per-wallet cap on the number of reservations. Zero means unlimited.

#### Defined in

[src/lib/contracts/reservations.ts:122](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L122)

___

### maxTotalAmount

• **maxTotalAmount**: `BigNumber`

Global cap on the total reserved amount in satoshi. Zero means
unlimited.

#### Defined in

[src/lib/contracts/reservations.ts:114](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L114)

___

### minAmount

• **minAmount**: `BigNumber`

Minimum reserved deposit amount in satoshi.

#### Defined in

[src/lib/contracts/reservations.ts:95](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L95)

___

### termSeconds

• **termSeconds**: `number`

Reservation custody term in seconds.

#### Defined in

[src/lib/contracts/reservations.ts:104](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L104)

___

### totalAmount

• **totalAmount**: `BigNumber`

Current total reserved amount in satoshi.

#### Defined in

[src/lib/contracts/reservations.ts:118](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L118)

___

### txMaxFee

• **txMaxFee**: `BigNumber`

Maximum Bitcoin miner fee in satoshi reserved for the acceptance
transaction.

#### Defined in

[src/lib/contracts/reservations.ts:100](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L100)

___

### vault

• `Optional` **vault**: [`ChainIdentifier`](ChainIdentifier.md)

Address of the reservation vault. Undefined means reservations
are disabled on the chain.

#### Defined in

[src/lib/contracts/reservations.ts:91](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L91)
