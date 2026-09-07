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

[src/lib/contracts/bridge.ts:517](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L517)

___

### createdAt

• **createdAt**: `number`

UNIX timestamp the wallet was created at.

#### Defined in

[src/lib/contracts/bridge.ts:508](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L508)

___

### ecdsaWalletID

• **ecdsaWalletID**: [`Hex`](../classes/Hex.md)

Identifier of a ECDSA Wallet registered in the ECDSA Wallet Registry.

#### Defined in

[src/lib/contracts/bridge.ts:490](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L490)

___

### mainUtxoHash

• **mainUtxoHash**: [`Hex`](../classes/Hex.md)

Latest wallet's main UTXO hash.

#### Defined in

[src/lib/contracts/bridge.ts:500](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L500)

___

### movingFundsRequestedAt

• **movingFundsRequestedAt**: `number`

UNIX timestamp indicating the moment the wallet was requested to move their
funds.

#### Defined in

[src/lib/contracts/bridge.ts:513](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L513)

___

### movingFundsTargetWalletsCommitmentHash

• **movingFundsTargetWalletsCommitmentHash**: [`Hex`](../classes/Hex.md)

Moving funds target wallet commitment submitted by the wallet.

#### Defined in

[src/lib/contracts/bridge.ts:529](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L529)

___

### pendingMovedFundsSweepRequestsCount

• **pendingMovedFundsSweepRequestsCount**: `number`

Total count of pending moved funds sweep requests targeting this wallet.

#### Defined in

[src/lib/contracts/bridge.ts:521](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L521)

___

### pendingRedemptionsValue

• **pendingRedemptionsValue**: `BigNumber`

The total redeemable value of pending redemption requests targeting that wallet.

#### Defined in

[src/lib/contracts/bridge.ts:504](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L504)

___

### state

• **state**: [`WalletState`](../enums/WalletState-1.md)

Current state of the wallet.

#### Defined in

[src/lib/contracts/bridge.ts:525](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L525)

___

### walletPublicKey

• `Optional` **walletPublicKey**: [`Hex`](../classes/Hex.md)

Compressed public key of the ECDSA Wallet. If the wallet is Closed
or Terminated, this field is empty as the public key is removed from the
WalletRegistry.

#### Defined in

[src/lib/contracts/bridge.ts:496](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L496)
