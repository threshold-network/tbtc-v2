# Interface: DepositRequest

Represents a deposit request revealed to the on-chain bridge.

## Table of contents

### Properties

- [amount](DepositRequest.md#amount)
- [depositor](DepositRequest.md#depositor)
- [extraData](DepositRequest.md#extradata)
- [revealedAt](DepositRequest.md#revealedat)
- [sweptAt](DepositRequest.md#sweptat)
- [treasuryFee](DepositRequest.md#treasuryfee)
- [vault](DepositRequest.md#vault)

## Properties

### amount

• **amount**: `BigNumber`

Deposit amount in satoshis.

#### Defined in

[src/lib/contracts/bridge.ts:396](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L396)

___

### depositor

• **depositor**: [`ChainIdentifier`](ChainIdentifier.md)

Depositor's chain identifier.

#### Defined in

[src/lib/contracts/bridge.ts:391](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L391)

___

### extraData

• `Optional` **extraData**: [`Hex`](../classes/Hex.md)

Optional 32-byte extra data committed by the deposit script.

#### Defined in

[src/lib/contracts/bridge.ts:421](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L421)

___

### revealedAt

• **revealedAt**: `number`

UNIX timestamp the deposit was revealed at.

#### Defined in

[src/lib/contracts/bridge.ts:406](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L406)

___

### sweptAt

• **sweptAt**: `number`

UNIX timestamp the request was swept at. If not swept yet, this parameter
should have zero as value.

#### Defined in

[src/lib/contracts/bridge.ts:411](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L411)

___

### treasuryFee

• **treasuryFee**: `BigNumber`

Value of the treasury fee calculated for this revealed deposit.
Denominated in satoshi.

#### Defined in

[src/lib/contracts/bridge.ts:416](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L416)

___

### vault

• `Optional` **vault**: [`ChainIdentifier`](ChainIdentifier.md)

Optional identifier of the vault the deposit should be routed in.

#### Defined in

[src/lib/contracts/bridge.ts:401](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L401)
