# Class: EthereumReservations

Implementation of the Reservations handle: the reservation surface of
the Bridge, reached through the Bridge address with the combined
Bridge + reservation router ABI.

## Hierarchy

- `EthersContractHandle`\<`EthersContract`\>

  ↳ **`EthereumReservations`**

## Implements

- [`Reservations`](../interfaces/Reservations.md)

## Table of contents

### Constructors

- [constructor](EthereumReservations.md#constructor)

### Properties

- [\_deployedAtBlockNumber](EthereumReservations.md#_deployedatblocknumber)
- [\_instance](EthereumReservations.md#_instance)
- [\_totalRetryAttempts](EthereumReservations.md#_totalretryattempts)

### Methods

- [activeReservationsCount](EthereumReservations.md#activereservationscount)
- [deposit](EthereumReservations.md#deposit)
- [depositParameters](EthereumReservations.md#depositparameters)
- [getAddress](EthereumReservations.md#getaddress)
- [getEvents](EthereumReservations.md#getevents)
- [getNewWalletRegisteredEvents](EthereumReservations.md#getnewwalletregisteredevents)
- [getReservedDepositReleasedToPoolEvents](EthereumReservations.md#getreserveddepositreleasedtopoolevents)
- [isReservedDeposit](EthereumReservations.md#isreserveddeposit)
- [isVaultTrusted](EthereumReservations.md#isvaulttrusted)
- [liveWalletsCount](EthereumReservations.md#livewalletscount)
- [pendingReservedDeposits](EthereumReservations.md#pendingreserveddeposits)
- [pendingThirdPartyReanchorHolds](EthereumReservations.md#pendingthirdpartyreanchorholds)
- [releaseReservedDepositToPool](EthereumReservations.md#releasereserveddeposittopool)
- [requestReservationAcceptance](EthereumReservations.md#requestreservationacceptance)
- [reservationActions](EthereumReservations.md#reservationactions)
- [reservationCaps](EthereumReservations.md#reservationcaps)
- [reservationHandoffReserveWallets](EthereumReservations.md#reservationhandoffreservewallets)
- [reservationParameters](EthereumReservations.md#reservationparameters)
- [reservations](EthereumReservations.md#reservations)
- [reservedDepositWallet](EthereumReservations.md#reserveddepositwallet)
- [wallet](EthereumReservations.md#wallet)
- [walletReservationsAmount](EthereumReservations.md#walletreservationsamount)
- [walletReservationsCount](EthereumReservations.md#walletreservationscount)

## Constructors

### constructor

• **new EthereumReservations**(`config`, `chainId?`): [`EthereumReservations`](EthereumReservations.md)

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `config` | [`EthereumContractConfig`](../interfaces/EthereumContractConfig.md) | `undefined` |
| `chainId` | [`Ethereum`](../enums/Chains.Ethereum.md) | `Chains.Ethereum.Local` |

#### Returns

[`EthereumReservations`](EthereumReservations.md)

#### Overrides

EthersContractHandle\&lt;EthersContract\&gt;.constructor

#### Defined in

[src/lib/ethereum/reservations.ts:170](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/reservations.ts#L170)

## Properties

### \_deployedAtBlockNumber

• `Protected` `Readonly` **\_deployedAtBlockNumber**: `number`

Number of a block within which the contract was deployed. Value is read from
the contract deployment artifact. It can be overwritten by setting a
[EthersContractConfig.deployedAtBlockNumber](../interfaces/EthereumContractConfig.md#deployedatblocknumber) property.

#### Inherited from

EthersContractHandle.\_deployedAtBlockNumber

#### Defined in

[src/lib/ethereum/adapter.ts:78](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L78)

___

### \_instance

• `Protected` `Readonly` **\_instance**: `Contract`

Ethers instance of the deployed contract.

#### Inherited from

EthersContractHandle.\_instance

#### Defined in

[src/lib/ethereum/adapter.ts:72](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L72)

___

### \_totalRetryAttempts

• `Protected` `Readonly` **\_totalRetryAttempts**: `number`

Number of retries for ethereum requests.

#### Inherited from

EthersContractHandle.\_totalRetryAttempts

#### Defined in

[src/lib/ethereum/adapter.ts:82](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L82)

## Methods

### activeReservationsCount

▸ **activeReservationsCount**(): `Promise`\<[`ReservationOccupancy`](../interfaces/ReservationOccupancy.md)\>

#### Returns

`Promise`\<[`ReservationOccupancy`](../interfaces/ReservationOccupancy.md)\>

**`See`**

#### Implementation of

[Reservations](../interfaces/Reservations.md).[activeReservationsCount](../interfaces/Reservations.md#activereservationscount)

#### Defined in

[src/lib/ethereum/reservations.ts:365](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/reservations.ts#L365)

___

### deposit

▸ **deposit**(`depositKey`): `Promise`\<\{ `amount`: `BigNumber` ; `depositor`: [`ChainIdentifier`](../interfaces/ChainIdentifier.md) ; `revealedAt`: `number` ; `sweptAt`: `number` ; `treasuryFee`: `BigNumber` ; `vault?`: [`ChainIdentifier`](../interfaces/ChainIdentifier.md)  }\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `depositKey` | `BigNumber` |

#### Returns

`Promise`\<\{ `amount`: `BigNumber` ; `depositor`: [`ChainIdentifier`](../interfaces/ChainIdentifier.md) ; `revealedAt`: `number` ; `sweptAt`: `number` ; `treasuryFee`: `BigNumber` ; `vault?`: [`ChainIdentifier`](../interfaces/ChainIdentifier.md)  }\>

**`See`**

#### Implementation of

[Reservations](../interfaces/Reservations.md).[deposit](../interfaces/Reservations.md#deposit)

#### Defined in

[src/lib/ethereum/reservations.ts:474](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/reservations.ts#L474)

___

### depositParameters

▸ **depositParameters**(): `Promise`\<\{ `dustThreshold`: `BigNumber` ; `revealAheadPeriodSeconds`: `number` ; `treasuryFeeDivisor`: `BigNumber` ; `txMaxFee`: `BigNumber`  }\>

#### Returns

`Promise`\<\{ `dustThreshold`: `BigNumber` ; `revealAheadPeriodSeconds`: `number` ; `treasuryFeeDivisor`: `BigNumber` ; `txMaxFee`: `BigNumber`  }\>

**`See`**

#### Implementation of

[Reservations](../interfaces/Reservations.md).[depositParameters](../interfaces/Reservations.md#depositparameters)

#### Defined in

[src/lib/ethereum/reservations.ts:537](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/reservations.ts#L537)

___

### getAddress

▸ **getAddress**(): [`EthereumAddress`](EthereumAddress.md)

Get address of the contract instance.

#### Returns

[`EthereumAddress`](EthereumAddress.md)

Address of this contract instance.

#### Inherited from

EthersContractHandle.getAddress

#### Defined in

[src/lib/ethereum/adapter.ts:110](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L110)

___

### getEvents

▸ **getEvents**(`eventName`, `options?`, `...filterArgs`): `Promise`\<`Event`[]\>

Get events emitted by the Ethereum contract.
It starts searching from provided block number. If the GetEvents.Options#fromBlock
option is missing it looks for a contract's defined property
[_deployedAtBlockNumber](BaseBitcoinDepositor.md#_deployedatblocknumber). If the property is missing starts searching
from block `0`.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `eventName` | `string` | Name of the event. |
| `options?` | [`Options`](../interfaces/GetChainEvents.Options.md) | Options for events fetching. |
| `...filterArgs` | `unknown`[] | Arguments for events filtering. |

#### Returns

`Promise`\<`Event`[]\>

Array of found events.

#### Inherited from

EthersContractHandle.getEvents

#### Defined in

[src/lib/ethereum/adapter.ts:125](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L125)

___

### getNewWalletRegisteredEvents

▸ **getNewWalletRegisteredEvents**(`options?`, `...filterArgs`): `Promise`\<[`NewWalletRegisteredEvent`](../README.md#newwalletregisteredevent)[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `options?` | [`Options`](../interfaces/GetChainEvents.Options.md) |
| `...filterArgs` | `unknown`[] |

#### Returns

`Promise`\<[`NewWalletRegisteredEvent`](../README.md#newwalletregisteredevent)[]\>

**`See`**

#### Implementation of

Reservations.getNewWalletRegisteredEvents

#### Defined in

[src/lib/ethereum/reservations.ts:562](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/reservations.ts#L562)

___

### getReservedDepositReleasedToPoolEvents

▸ **getReservedDepositReleasedToPoolEvents**(`options?`): `Promise`\<\{ `depositKey`: `BigNumber` ; `depositor`: [`ChainIdentifier`](../interfaces/ChainIdentifier.md) ; `vault?`: [`ChainIdentifier`](../interfaces/ChainIdentifier.md)  } & [`ChainEvent`](../interfaces/ChainEvent.md)[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `options?` | [`Options`](../interfaces/GetChainEvents.Options.md) |

#### Returns

`Promise`\<\{ `depositKey`: `BigNumber` ; `depositor`: [`ChainIdentifier`](../interfaces/ChainIdentifier.md) ; `vault?`: [`ChainIdentifier`](../interfaces/ChainIdentifier.md)  } & [`ChainEvent`](../interfaces/ChainEvent.md)[]\>

**`See`**

#### Implementation of

Reservations.getReservedDepositReleasedToPoolEvents

#### Defined in

[src/lib/ethereum/reservations.ts:589](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/reservations.ts#L589)

___

### isReservedDeposit

▸ **isReservedDeposit**(`depositKey`): `Promise`\<`boolean`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `depositKey` | `BigNumber` |

#### Returns

`Promise`\<`boolean`\>

**`See`**

#### Implementation of

[Reservations](../interfaces/Reservations.md).[isReservedDeposit](../interfaces/Reservations.md#isreserveddeposit)

#### Defined in

[src/lib/ethereum/reservations.ts:464](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/reservations.ts#L464)

___

### isVaultTrusted

▸ **isVaultTrusted**(`vault`): `Promise`\<`boolean`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `vault` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) |

#### Returns

`Promise`\<`boolean`\>

**`See`**

#### Implementation of

[Reservations](../interfaces/Reservations.md).[isVaultTrusted](../interfaces/Reservations.md#isvaulttrusted)

#### Defined in

[src/lib/ethereum/reservations.ts:525](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/reservations.ts#L525)

___

### liveWalletsCount

▸ **liveWalletsCount**(): `Promise`\<`number`\>

#### Returns

`Promise`\<`number`\>

**`See`**

#### Implementation of

[Reservations](../interfaces/Reservations.md).[liveWalletsCount](../interfaces/Reservations.md#livewalletscount)

#### Defined in

[src/lib/ethereum/reservations.ts:382](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/reservations.ts#L382)

___

### pendingReservedDeposits

▸ **pendingReservedDeposits**(): `Promise`\<`number`\>

#### Returns

`Promise`\<`number`\>

**`See`**

#### Implementation of

[Reservations](../interfaces/Reservations.md).[pendingReservedDeposits](../interfaces/Reservations.md#pendingreserveddeposits)

#### Defined in

[src/lib/ethereum/reservations.ts:422](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/reservations.ts#L422)

___

### pendingThirdPartyReanchorHolds

▸ **pendingThirdPartyReanchorHolds**(`walletPublicKeyHash`): `Promise`\<`number`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `walletPublicKeyHash` | [`Hex`](Hex.md) |

#### Returns

`Promise`\<`number`\>

**`See`**

#### Implementation of

[Reservations](../interfaces/Reservations.md).[pendingThirdPartyReanchorHolds](../interfaces/Reservations.md#pendingthirdpartyreanchorholds)

#### Defined in

[src/lib/ethereum/reservations.ts:448](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/reservations.ts#L448)

___

### releaseReservedDepositToPool

▸ **releaseReservedDepositToPool**(`depositKey`, `vault`): `Promise`\<[`Hex`](Hex.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `depositKey` | `BigNumber` |
| `vault` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) |

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

**`See`**

#### Implementation of

[Reservations](../interfaces/Reservations.md).[releaseReservedDepositToPool](../interfaces/Reservations.md#releasereserveddeposittopool)

#### Defined in

[src/lib/ethereum/reservations.ts:232](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/reservations.ts#L232)

___

### requestReservationAcceptance

▸ **requestReservationAcceptance**(`fundingTx`, `fundingProof`, `fundingOutputIndex`, `walletPublicKeyHash`): `Promise`\<[`Hex`](Hex.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `fundingTx` | [`BitcoinRawTxVectors`](../interfaces/BitcoinRawTxVectors.md) |
| `fundingProof` | [`BitcoinSpvProof`](../interfaces/BitcoinSpvProof.md) |
| `fundingOutputIndex` | `number` |
| `walletPublicKeyHash` | [`Hex`](Hex.md) |

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

**`See`**

#### Implementation of

[Reservations](../interfaces/Reservations.md).[requestReservationAcceptance](../interfaces/Reservations.md#requestreservationacceptance)

#### Defined in

[src/lib/ethereum/reservations.ts:197](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/reservations.ts#L197)

___

### reservationActions

▸ **reservationActions**(`depositKey`, `requestNonce`): `Promise`\<[`ReservationActionRecord`](../interfaces/ReservationActionRecord.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `depositKey` | `BigNumber` |
| `requestNonce` | `number` |

#### Returns

`Promise`\<[`ReservationActionRecord`](../interfaces/ReservationActionRecord.md)\>

**`See`**

#### Implementation of

[Reservations](../interfaces/Reservations.md).[reservationActions](../interfaces/Reservations.md#reservationactions)

#### Defined in

[src/lib/ethereum/reservations.ts:276](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/reservations.ts#L276)

___

### reservationCaps

▸ **reservationCaps**(): `Promise`\<[`ReservationCaps`](../interfaces/ReservationCaps.md)\>

#### Returns

`Promise`\<[`ReservationCaps`](../interfaces/ReservationCaps.md)\>

**`See`**

#### Implementation of

[Reservations](../interfaces/Reservations.md).[reservationCaps](../interfaces/Reservations.md#reservationcaps)

#### Defined in

[src/lib/ethereum/reservations.ts:333](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/reservations.ts#L333)

___

### reservationHandoffReserveWallets

▸ **reservationHandoffReserveWallets**(): `Promise`\<`number`\>

#### Returns

`Promise`\<`number`\>

**`See`**

#### Implementation of

[Reservations](../interfaces/Reservations.md).[reservationHandoffReserveWallets](../interfaces/Reservations.md#reservationhandoffreservewallets)

#### Defined in

[src/lib/ethereum/reservations.ts:353](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/reservations.ts#L353)

___

### reservationParameters

▸ **reservationParameters**(): `Promise`\<[`ReservationParameters`](../interfaces/ReservationParameters.md)\>

#### Returns

`Promise`\<[`ReservationParameters`](../interfaces/ReservationParameters.md)\>

**`See`**

#### Implementation of

[Reservations](../interfaces/Reservations.md).[reservationParameters](../interfaces/Reservations.md#reservationparameters)

#### Defined in

[src/lib/ethereum/reservations.ts:307](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/reservations.ts#L307)

___

### reservations

▸ **reservations**(`depositKey`): `Promise`\<[`ReservationRecord`](../interfaces/ReservationRecord.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `depositKey` | `BigNumber` |

#### Returns

`Promise`\<[`ReservationRecord`](../interfaces/ReservationRecord.md)\>

**`See`**

#### Implementation of

[Reservations](../interfaces/Reservations.md).[reservations](../interfaces/Reservations.md#reservations)

#### Defined in

[src/lib/ethereum/reservations.ts:248](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/reservations.ts#L248)

___

### reservedDepositWallet

▸ **reservedDepositWallet**(`depositKey`): `Promise`\<[`Hex`](Hex.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `depositKey` | `BigNumber` |

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

**`See`**

#### Implementation of

[Reservations](../interfaces/Reservations.md).[reservedDepositWallet](../interfaces/Reservations.md#reserveddepositwallet)

#### Defined in

[src/lib/ethereum/reservations.ts:434](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/reservations.ts#L434)

___

### wallet

▸ **wallet**(`walletPublicKeyHash`): `Promise`\<\{ `ecdsaWalletID`: [`Hex`](Hex.md) ; `state`: [`WalletState`](../enums/WalletState-1.md)  }\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `walletPublicKeyHash` | [`Hex`](Hex.md) |

#### Returns

`Promise`\<\{ `ecdsaWalletID`: [`Hex`](Hex.md) ; `state`: [`WalletState`](../enums/WalletState-1.md)  }\>

**`See`**

#### Implementation of

[Reservations](../interfaces/Reservations.md).[wallet](../interfaces/Reservations.md#wallet)

#### Defined in

[src/lib/ethereum/reservations.ts:503](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/reservations.ts#L503)

___

### walletReservationsAmount

▸ **walletReservationsAmount**(`walletPublicKeyHash`): `Promise`\<`BigNumber`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `walletPublicKeyHash` | [`Hex`](Hex.md) |

#### Returns

`Promise`\<`BigNumber`\>

**`See`**

#### Implementation of

[Reservations](../interfaces/Reservations.md).[walletReservationsAmount](../interfaces/Reservations.md#walletreservationsamount)

#### Defined in

[src/lib/ethereum/reservations.ts:394](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/reservations.ts#L394)

___

### walletReservationsCount

▸ **walletReservationsCount**(`walletPublicKeyHash`): `Promise`\<`number`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `walletPublicKeyHash` | [`Hex`](Hex.md) |

#### Returns

`Promise`\<`number`\>

**`See`**

#### Implementation of

[Reservations](../interfaces/Reservations.md).[walletReservationsCount](../interfaces/Reservations.md#walletreservationscount)

#### Defined in

[src/lib/ethereum/reservations.ts:408](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/reservations.ts#L408)
