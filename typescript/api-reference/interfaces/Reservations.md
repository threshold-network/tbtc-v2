# Interface: Reservations

Interface for communication with the on-chain reservation surface of the
Bridge. The reservation functions are not declared in the Bridge contract
itself: the Bridge's fallback routes every unmatched selector to the
reservation router through a delegatecall, so all reservation functions
execute at the Bridge address, on the Bridge storage. This interface is
implemented by a contract handle bound to the Bridge address with the
router ABI.

## Implemented by

- [`EthereumReservations`](../classes/EthereumReservations.md)

## Table of contents

### Properties

- [getNewWalletRegisteredEvents](Reservations.md#getnewwalletregisteredevents)
- [getReservedDepositReleasedToPoolEvents](Reservations.md#getreserveddepositreleasedtopoolevents)

### Methods

- [activeReservationsCount](Reservations.md#activereservationscount)
- [deposit](Reservations.md#deposit)
- [depositParameters](Reservations.md#depositparameters)
- [isReservedDeposit](Reservations.md#isreserveddeposit)
- [isVaultTrusted](Reservations.md#isvaulttrusted)
- [liveWalletsCount](Reservations.md#livewalletscount)
- [pendingReservedDeposits](Reservations.md#pendingreserveddeposits)
- [pendingThirdPartyReanchorHolds](Reservations.md#pendingthirdpartyreanchorholds)
- [releaseReservedDepositToPool](Reservations.md#releasereserveddeposittopool)
- [requestReservationAcceptance](Reservations.md#requestreservationacceptance)
- [reservationActions](Reservations.md#reservationactions)
- [reservationCaps](Reservations.md#reservationcaps)
- [reservationHandoffReserveWallets](Reservations.md#reservationhandoffreservewallets)
- [reservationParameters](Reservations.md#reservationparameters)
- [reservations](Reservations.md#reservations)
- [reservedDepositWallet](Reservations.md#reserveddepositwallet)
- [wallet](Reservations.md#wallet)
- [walletReservationsAmount](Reservations.md#walletreservationsamount)
- [walletReservationsCount](Reservations.md#walletreservationscount)

## Properties

### getNewWalletRegisteredEvents

• **getNewWalletRegisteredEvents**: [`Function`](GetChainEvents.Function.md)\<\{ `ecdsaWalletID`: [`Hex`](../classes/Hex.md) ; `walletPublicKeyHash`: [`Hex`](../classes/Hex.md)  } & [`ChainEvent`](ChainEvent.md)\>

Get emitted NewWalletRegistered events.

**`See`**

GetChainEvents.Function

#### Defined in

[src/lib/contracts/reservations.ts:460](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L460)

___

### getReservedDepositReleasedToPoolEvents

• **getReservedDepositReleasedToPoolEvents**: [`Function`](GetChainEvents.Function.md)\<\{ `depositKey`: `BigNumber` ; `depositor`: [`ChainIdentifier`](ChainIdentifier.md) ; `vault?`: [`ChainIdentifier`](ChainIdentifier.md)  } & [`ChainEvent`](ChainEvent.md)\>

Get emitted ReservedDepositReleasedToPool events.

**`See`**

GetChainEvents.Function

#### Defined in

[src/lib/contracts/reservations.ts:471](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L471)

## Methods

### activeReservationsCount

▸ **activeReservationsCount**(): `Promise`\<[`ReservationOccupancy`](ReservationOccupancy.md)\>

Gets the global reservation occupancy: the count of active
reservations and its governance cap.

#### Returns

`Promise`\<[`ReservationOccupancy`](ReservationOccupancy.md)\>

On-chain global reservation occupancy.

#### Defined in

[src/lib/contracts/reservations.ts:357](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L357)

___

### deposit

▸ **deposit**(`depositKey`): `Promise`\<\{ `amount`: `BigNumber` ; `depositor`: [`ChainIdentifier`](ChainIdentifier.md) ; `revealedAt`: `number` ; `sweptAt`: `number` ; `treasuryFee`: `BigNumber` ; `vault?`: [`ChainIdentifier`](ChainIdentifier.md)  }\>

Gets the deposit with the given key.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositKey` | `BigNumber` | Deposit key of the deposit. |

#### Returns

`Promise`\<\{ `amount`: `BigNumber` ; `depositor`: [`ChainIdentifier`](ChainIdentifier.md) ; `revealedAt`: `number` ; `sweptAt`: `number` ; `treasuryFee`: `BigNumber` ; `vault?`: [`ChainIdentifier`](ChainIdentifier.md)  }\>

On-chain deposit record.

#### Defined in

[src/lib/contracts/reservations.ts:417](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L417)

___

### depositParameters

▸ **depositParameters**(): `Promise`\<\{ `dustThreshold`: `BigNumber` ; `revealAheadPeriodSeconds`: `number` ; `treasuryFeeDivisor`: `BigNumber` ; `txMaxFee`: `BigNumber`  }\>

Gets the Bridge deposit parameters: dust threshold, treasury fee
divisor, maximum sweep fee and the reveal-ahead period, all as
currently configured on-chain.

#### Returns

`Promise`\<\{ `dustThreshold`: `BigNumber` ; `revealAheadPeriodSeconds`: `number` ; `treasuryFeeDivisor`: `BigNumber` ; `txMaxFee`: `BigNumber`  }\>

Deposit parameters.

#### Defined in

[src/lib/contracts/reservations.ts:449](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L449)

___

### isReservedDeposit

▸ **isReservedDeposit**(`depositKey`): `Promise`\<`boolean`\>

Gets whether the deposit with the given key was revealed as reserved
and has not been accepted, swept or marked stale yet.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositKey` | `BigNumber` | Deposit key of the deposit. |

#### Returns

`Promise`\<`boolean`\>

True when the deposit is a pending reserved deposit.

#### Defined in

[src/lib/contracts/reservations.ts:410](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L410)

___

### isVaultTrusted

▸ **isVaultTrusted**(`vault`): `Promise`\<`boolean`\>

Gets whether the given vault is trusted for deposit routing.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `vault` | [`ChainIdentifier`](ChainIdentifier.md) | Chain identifier of the vault. |

#### Returns

`Promise`\<`boolean`\>

True when the vault is trusted.

#### Defined in

[src/lib/contracts/reservations.ts:441](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L441)

___

### liveWalletsCount

▸ **liveWalletsCount**(): `Promise`\<`number`\>

Gets the current count of wallets in the Live state.

#### Returns

`Promise`\<`number`\>

The number of Live wallets.

#### Defined in

[src/lib/contracts/reservations.ts:402](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L402)

___

### pendingReservedDeposits

▸ **pendingReservedDeposits**(): `Promise`\<`number`\>

Gets the number of revealed reserved deposits that were neither
accepted nor marked stale yet.

#### Returns

`Promise`\<`number`\>

Number of pending reserved deposits.

#### Defined in

[src/lib/contracts/reservations.ts:380](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L380)

___

### pendingThirdPartyReanchorHolds

▸ **pendingThirdPartyReanchorHolds**(`walletPublicKeyHash`): `Promise`\<`number`\>

Gets the number of pending third-party re-anchor holds reserved
against the given target wallet.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `walletPublicKeyHash` | [`Hex`](../classes/Hex.md) | 20-byte public key hash of the wallet. |

#### Returns

`Promise`\<`number`\>

Number of pending holds.

#### Defined in

[src/lib/contracts/reservations.ts:396](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L396)

___

### releaseReservedDepositToPool

▸ **releaseReservedDepositToPool**(`depositKey`, `vault`): `Promise`\<[`Hex`](../classes/Hex.md)\>

Releases a reserved deposit that never received an acceptance request
back to the pool: the reserved mark is cleared and the deposit is
re-routed to the given vault so that ordinary sweeps accept it again.
Only the depositor of the deposit may call this.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositKey` | `BigNumber` | Deposit key of the reserved deposit. |
| `vault` | [`ChainIdentifier`](ChainIdentifier.md) | Target vault. Must be the zero address or a trusted vault other than the reservation vault. |

#### Returns

`Promise`\<[`Hex`](../classes/Hex.md)\>

Transaction hash of the release transaction.

#### Defined in

[src/lib/contracts/reservations.ts:307](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L307)

___

### requestReservationAcceptance

▸ **requestReservationAcceptance**(`fundingTx`, `fundingProof`, `fundingOutputIndex`, `walletPublicKeyHash`): `Promise`\<[`Hex`](../classes/Hex.md)\>

Requests the acceptance of a revealed reserved deposit: the
authorization for the designated wallet to perform the anchor spend.
Only the depositor of the deposit may call this.

The Bridge checks the SPV proof of the deposit's funding transaction
and derives the reservation key from the proven transaction hash and
the output index. The funding transaction must therefore be confirmed
with the Bridge's required number of confirmations.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `fundingTx` | [`BitcoinRawTxVectors`](BitcoinRawTxVectors.md) | Raw vectors of the deposit's funding transaction, the same data the deposit was revealed with. |
| `fundingProof` | [`BitcoinSpvProof`](BitcoinSpvProof.md) | SPV proof of the funding transaction. |
| `fundingOutputIndex` | `number` | Index of the deposit output in the funding transaction. |
| `walletPublicKeyHash` | [`Hex`](../classes/Hex.md) | 20-byte public key hash of the wallet that will anchor the deposit. Must be the deposit's designated wallet. |

#### Returns

`Promise`\<[`Hex`](../classes/Hex.md)\>

Transaction hash of the request acceptance transaction.

#### Defined in

[src/lib/contracts/reservations.ts:290](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L290)

___

### reservationActions

▸ **reservationActions**(`depositKey`, `requestNonce`): `Promise`\<[`ReservationActionRecord`](ReservationActionRecord.md)\>

Gets the on-chain record of the given reservation action generation.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositKey` | `BigNumber` | Deposit key of the reservation. |
| `requestNonce` | `number` | The action generation. |

#### Returns

`Promise`\<[`ReservationActionRecord`](ReservationActionRecord.md)\>

On-chain reservation action record.

#### Defined in

[src/lib/contracts/reservations.ts:325](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L325)

___

### reservationCaps

▸ **reservationCaps**(): `Promise`\<[`ReservationCaps`](ReservationCaps.md)\>

Gets the current values of the Bridge reservation caps.

#### Returns

`Promise`\<[`ReservationCaps`](ReservationCaps.md)\>

On-chain reservation caps.

#### Defined in

[src/lib/contracts/reservations.ts:340](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L340)

___

### reservationHandoffReserveWallets

▸ **reservationHandoffReserveWallets**(): `Promise`\<`number`\>

Gets the number of Live wallets held back from acceptance capacity by
the hand-off reserve gate: after every acceptance, this many Live
wallets may retire together and all open positions still fit on the
remaining Live wallets within the per-wallet count cap. Always at
least one.

#### Returns

`Promise`\<`number`\>

The hand-off reserve in Live wallets.

#### Defined in

[src/lib/contracts/reservations.ts:350](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L350)

___

### reservationParameters

▸ **reservationParameters**(): `Promise`\<[`ReservationParameters`](ReservationParameters.md)\>

Gets the current values of the Bridge reservation parameters.

#### Returns

`Promise`\<[`ReservationParameters`](ReservationParameters.md)\>

On-chain reservation parameters.

#### Defined in

[src/lib/contracts/reservations.ts:334](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L334)

___

### reservations

▸ **reservations**(`depositKey`): `Promise`\<[`ReservationRecord`](ReservationRecord.md)\>

Gets the on-chain record of the given reservation.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositKey` | `BigNumber` | Deposit key of the reservation. |

#### Returns

`Promise`\<[`ReservationRecord`](ReservationRecord.md)\>

On-chain reservation record.

#### Defined in

[src/lib/contracts/reservations.ts:317](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L317)

___

### reservedDepositWallet

▸ **reservedDepositWallet**(`depositKey`): `Promise`\<[`Hex`](../classes/Hex.md)\>

Gets the designated wallet of a pending reserved deposit.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositKey` | `BigNumber` | Deposit key of the reserved deposit. |

#### Returns

`Promise`\<[`Hex`](../classes/Hex.md)\>

20-byte public key hash of the designated wallet. Zero when
         the deposit is not pending.

#### Defined in

[src/lib/contracts/reservations.ts:388](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L388)

___

### wallet

▸ **wallet**(`walletPublicKeyHash`): `Promise`\<\{ `ecdsaWalletID`: [`Hex`](../classes/Hex.md) ; `state`: [`WalletState`](../enums/WalletState-1.md)  }\>

Gets the registration and state record of the given wallet.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `walletPublicKeyHash` | [`Hex`](../classes/Hex.md) | 20-byte public key hash of the wallet. |

#### Returns

`Promise`\<\{ `ecdsaWalletID`: [`Hex`](../classes/Hex.md) ; `state`: [`WalletState`](../enums/WalletState-1.md)  }\>

On-chain wallet record.

#### Defined in

[src/lib/contracts/reservations.ts:431](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L431)

___

### walletReservationsAmount

▸ **walletReservationsAmount**(`walletPublicKeyHash`): `Promise`\<`BigNumber`\>

Gets the total satoshi amount of reservation anchors custodied by the
given wallet, including the reserved capacity of pending actions.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `walletPublicKeyHash` | [`Hex`](../classes/Hex.md) | 20-byte public key hash of the wallet. |

#### Returns

`Promise`\<`BigNumber`\>

Total reserved amount of the wallet in satoshi.

#### Defined in

[src/lib/contracts/reservations.ts:365](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L365)

___

### walletReservationsCount

▸ **walletReservationsCount**(`walletPublicKeyHash`): `Promise`\<`number`\>

Gets the number of reservations custodied by the given wallet,
including reserved capacity of pending actions.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `walletPublicKeyHash` | [`Hex`](../classes/Hex.md) | 20-byte public key hash of the wallet. |

#### Returns

`Promise`\<`number`\>

Number of reservations custodied by the wallet.

#### Defined in

[src/lib/contracts/reservations.ts:373](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/reservations.ts#L373)
