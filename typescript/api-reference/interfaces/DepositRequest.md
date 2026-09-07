# Interface: DepositRequest

Represents a deposit request revealed to the on-chain bridge.

## Table of contents

### Properties

- [amount](DepositRequest.md#amount)
- [depositor](DepositRequest.md#depositor)
- [revealedAt](DepositRequest.md#revealedat)
- [sweptAt](DepositRequest.md#sweptat)
- [treasuryFee](DepositRequest.md#treasuryfee)
- [vault](DepositRequest.md#vault)

## Properties

### amount

• **amount**: `BigNumber`

Deposit amount in satoshis.

#### Defined in

[src/lib/contracts/bridge.ts:296](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L296)

___

### depositor

• **depositor**: [`ChainIdentifier`](ChainIdentifier.md)

Depositor's chain identifier.

#### Defined in

[src/lib/contracts/bridge.ts:291](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L291)

___

### revealedAt

• **revealedAt**: `number`

UNIX timestamp the deposit was revealed at.

#### Defined in

[src/lib/contracts/bridge.ts:306](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L306)

___

### sweptAt

• **sweptAt**: `number`

UNIX timestamp the request was swept at. If not swept yet, this parameter
should have zero as value.

#### Defined in

[src/lib/contracts/bridge.ts:311](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L311)

___

### treasuryFee

• **treasuryFee**: `BigNumber`

Value of the treasury fee calculated for this revealed deposit.
Denominated in satoshi.

#### Defined in

[src/lib/contracts/bridge.ts:316](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L316)

___

### vault

• `Optional` **vault**: [`ChainIdentifier`](ChainIdentifier.md)

Optional identifier of the vault the deposit should be routed in.

#### Defined in

[src/lib/contracts/bridge.ts:301](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L301)
