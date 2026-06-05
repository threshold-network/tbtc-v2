# Interface: RedemptionRequest

Represents a redemption request.

## Table of contents

### Properties

- [redeemer](RedemptionRequest.md#redeemer)
- [redeemerOutputScript](RedemptionRequest.md#redeemeroutputscript)
- [requestedAmount](RedemptionRequest.md#requestedamount)
- [requestedAt](RedemptionRequest.md#requestedat)
- [treasuryFee](RedemptionRequest.md#treasuryfee)
- [txMaxFee](RedemptionRequest.md#txmaxfee)

## Properties

### redeemer

• **redeemer**: [`ChainIdentifier`](ChainIdentifier.md)

On-chain identifier of the redeemer.

#### Defined in

[src/lib/contracts/bridge.ts:354](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L354)

___

### redeemerOutputScript

• **redeemerOutputScript**: [`Hex`](../classes/Hex.md)

The output script the redeemed Bitcoin funds are locked to. It is not
prepended with length.

#### Defined in

[src/lib/contracts/bridge.ts:360](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L360)

___

### requestedAmount

• **requestedAmount**: `BigNumber`

The amount of Bitcoins in satoshis that is requested to be redeemed.
The actual value of the output in the Bitcoin transaction will be decreased
by the sum of the fee share and the treasury fee for this particular output.

#### Defined in

[src/lib/contracts/bridge.ts:367](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L367)

___

### requestedAt

• **requestedAt**: `number`

UNIX timestamp the request was created at.

#### Defined in

[src/lib/contracts/bridge.ts:386](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L386)

___

### treasuryFee

• **treasuryFee**: `BigNumber`

The amount of Bitcoins in satoshis that is subtracted from the amount of
the redemption request and used to pay the treasury fee.
The value should be exactly equal to the value of treasury fee in the Bridge
on-chain contract at the time the redemption request was made.

#### Defined in

[src/lib/contracts/bridge.ts:375](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L375)

___

### txMaxFee

• **txMaxFee**: `BigNumber`

The maximum amount of Bitcoins in satoshis that can be subtracted from the
redemption's `requestedAmount` to pay the transaction network fee.

#### Defined in

[src/lib/contracts/bridge.ts:381](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L381)
