# Interface: ReservedWallet

Represents a registered wallet of the tBTC system with the data relevant
for the reservation wallet selection.

## Table of contents

### Properties

- [publicKeyHash](ReservedWallet.md#publickeyhash)
- [reservationsAmount](ReservedWallet.md#reservationsamount)
- [reservationsCount](ReservedWallet.md#reservationscount)
- [state](ReservedWallet.md#state)

## Properties

### publicKeyHash

• **publicKeyHash**: [`Hex`](../classes/Hex.md)

20-byte public key hash of the wallet.

#### Defined in

[src/lib/contracts/reservations.ts:488](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L488)

___

### reservationsAmount

• **reservationsAmount**: `BigNumber`

Total satoshi amount of reservation anchors custodied by the wallet.

#### Defined in

[src/lib/contracts/reservations.ts:501](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L501)

___

### reservationsCount

• **reservationsCount**: `number`

Number of reservations custodied by the wallet, including reserved
capacity of pending actions.

#### Defined in

[src/lib/contracts/reservations.ts:497](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L497)

___

### state

• **state**: [`WalletState`](../enums/WalletState-1.md)

Current state of the wallet.

#### Defined in

[src/lib/contracts/reservations.ts:492](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L492)
