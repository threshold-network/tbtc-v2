# Interface: Wallet

Represents a deposit.

## Table of contents

### Properties

- [closingStartedAt](Wallet.md#closingstartedat)
- [createdAt](Wallet.md#createdat)
- [ecdsaWalletID](Wallet.md#ecdsawalletid)
- [mainUtxoHash](Wallet.md#mainutxohash)
- [movingFundsRequestedAt](Wallet.md#movingfundsrequestedat)
- [movingFundsTargetWalletsCommitmentHash](Wallet.md#movingfundstargetwalletscommitmenthash)
- [pendingMovedFundsSweepRequestsCount](Wallet.md#pendingmovedfundssweeprequestscount)
- [pendingRedemptionsValue](Wallet.md#pendingredemptionsvalue)
- [state](Wallet.md#state)
- [walletID](Wallet.md#walletid)
- [walletPublicKey](Wallet.md#walletpublickey)

## Properties

### closingStartedAt

• **closingStartedAt**: `number`

UNIX timestamp indicating the moment the wallet's closing period started.

#### Defined in

[src/lib/contracts/bridge.ts:491](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L491)

___

### createdAt

• **createdAt**: `number`

UNIX timestamp the wallet was created at.

#### Defined in

[src/lib/contracts/bridge.ts:482](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L482)

___

### ecdsaWalletID

• **ecdsaWalletID**: [`Hex`](../classes/Hex.md)

Identifier of a ECDSA Wallet registered in the ECDSA Wallet Registry.

#### Defined in

[src/lib/contracts/bridge.ts:464](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L464)

___

### mainUtxoHash

• **mainUtxoHash**: [`Hex`](../classes/Hex.md)

Latest wallet's main UTXO hash.

#### Defined in

[src/lib/contracts/bridge.ts:474](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L474)

___

### movingFundsRequestedAt

• **movingFundsRequestedAt**: `number`

UNIX timestamp indicating the moment the wallet was requested to move their
funds.

#### Defined in

[src/lib/contracts/bridge.ts:487](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L487)

___

### movingFundsTargetWalletsCommitmentHash

• **movingFundsTargetWalletsCommitmentHash**: [`Hex`](../classes/Hex.md)

Moving funds target wallet commitment submitted by the wallet.

#### Defined in

[src/lib/contracts/bridge.ts:503](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L503)

___

### pendingMovedFundsSweepRequestsCount

• **pendingMovedFundsSweepRequestsCount**: `number`

Total count of pending moved funds sweep requests targeting this wallet.

#### Defined in

[src/lib/contracts/bridge.ts:495](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L495)

___

### pendingRedemptionsValue

• **pendingRedemptionsValue**: `BigNumber`

The total redeemable value of pending redemption requests targeting that wallet.

#### Defined in

[src/lib/contracts/bridge.ts:478](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L478)

___

### state

• **state**: [`WalletState`](../enums/WalletState-1.md)

Current state of the wallet.

#### Defined in

[src/lib/contracts/bridge.ts:499](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L499)

___

### walletID

• `Optional` **walletID**: [`Hex`](../classes/Hex.md)

Canonical wallet identifier.

#### Defined in

[src/lib/contracts/bridge.ts:460](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L460)

___

### walletPublicKey

• `Optional` **walletPublicKey**: [`Hex`](../classes/Hex.md)

Compressed public key of the ECDSA Wallet. If the wallet is Closed
or Terminated, this field is empty as the public key is removed from the
WalletRegistry.

#### Defined in

[src/lib/contracts/bridge.ts:470](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L470)
