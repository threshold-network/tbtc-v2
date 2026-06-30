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

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:545](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L545)

___

### createdAt

• **createdAt**: `number`

UNIX timestamp the wallet was created at.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:536](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L536)

___

### ecdsaWalletID

• **ecdsaWalletID**: [`Hex`](../classes/Hex.md)

Identifier of a ECDSA Wallet registered in the ECDSA Wallet Registry.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:518](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L518)

___

### mainUtxoHash

• **mainUtxoHash**: [`Hex`](../classes/Hex.md)

Latest wallet's main UTXO hash.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:528](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L528)

___

### movingFundsRequestedAt

• **movingFundsRequestedAt**: `number`

UNIX timestamp indicating the moment the wallet was requested to move their
funds.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:541](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L541)

___

### movingFundsTargetWalletsCommitmentHash

• **movingFundsTargetWalletsCommitmentHash**: [`Hex`](../classes/Hex.md)

Moving funds target wallet commitment submitted by the wallet.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:557](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L557)

___

### pendingMovedFundsSweepRequestsCount

• **pendingMovedFundsSweepRequestsCount**: `number`

Total count of pending moved funds sweep requests targeting this wallet.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:549](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L549)

___

### pendingRedemptionsValue

• **pendingRedemptionsValue**: `BigNumber`

The total redeemable value of pending redemption requests targeting that wallet.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:532](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L532)

___

### state

• **state**: [`WalletState`](../enums/WalletState-1.md)

Current state of the wallet.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:553](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L553)

___

### walletID

• `Optional` **walletID**: [`Hex`](../classes/Hex.md)

Canonical wallet identifier.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:514](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L514)

___

### walletPublicKey

• `Optional` **walletPublicKey**: [`Hex`](../classes/Hex.md)

Compressed public key of the ECDSA Wallet. If the wallet is Closed
or Terminated, this field is empty as the public key is removed from the
WalletRegistry.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:524](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L524)
