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
- [walletPublicKey](Wallet.md#walletpublickey)

## Properties

### closingStartedAt

• **closingStartedAt**: `number`

UNIX timestamp indicating the moment the wallet's closing period started.

#### Defined in

[lib/contracts/bridge.ts:453](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L453)

___

### createdAt

• **createdAt**: `number`

UNIX timestamp the wallet was created at.

#### Defined in

[lib/contracts/bridge.ts:444](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L444)

___

### ecdsaWalletID

• **ecdsaWalletID**: [`Hex`](../classes/Hex.md)

Identifier of a ECDSA Wallet registered in the ECDSA Wallet Registry.

#### Defined in

[lib/contracts/bridge.ts:426](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L426)

___

### mainUtxoHash

• **mainUtxoHash**: [`Hex`](../classes/Hex.md)

Latest wallet's main UTXO hash.

#### Defined in

[lib/contracts/bridge.ts:436](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L436)

___

### movingFundsRequestedAt

• **movingFundsRequestedAt**: `number`

UNIX timestamp indicating the moment the wallet was requested to move their
funds.

#### Defined in

[lib/contracts/bridge.ts:449](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L449)

___

### movingFundsTargetWalletsCommitmentHash

• **movingFundsTargetWalletsCommitmentHash**: [`Hex`](../classes/Hex.md)

Moving funds target wallet commitment submitted by the wallet.

#### Defined in

[lib/contracts/bridge.ts:465](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L465)

___

### pendingMovedFundsSweepRequestsCount

• **pendingMovedFundsSweepRequestsCount**: `number`

Total count of pending moved funds sweep requests targeting this wallet.

#### Defined in

[lib/contracts/bridge.ts:457](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L457)

___

### pendingRedemptionsValue

• **pendingRedemptionsValue**: `BigNumber`

The total redeemable value of pending redemption requests targeting that wallet.

#### Defined in

[lib/contracts/bridge.ts:440](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L440)

___

### state

• **state**: [`WalletState`](../enums/WalletState-1.md)

Current state of the wallet.

#### Defined in

[lib/contracts/bridge.ts:461](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L461)

___

### walletPublicKey

• `Optional` **walletPublicKey**: [`Hex`](../classes/Hex.md)

Compressed public key of the ECDSA Wallet. If the wallet is Closed
or Terminated, this field is empty as the public key is removed from the
WalletRegistry.

#### Defined in

[lib/contracts/bridge.ts:432](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L432)
