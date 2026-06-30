# Interface: DepositReceipt

Represents a deposit receipt. The receipt holds all information required
to build a unique deposit address on Bitcoin chain.

## Table of contents

### Properties

- [blindingFactor](DepositReceipt.md#blindingfactor)
- [depositor](DepositReceipt.md#depositor)
- [extraData](DepositReceipt.md#extradata)
- [refundLocktime](DepositReceipt.md#refundlocktime)
- [refundPublicKeyHash](DepositReceipt.md#refundpublickeyhash)
- [refundXOnlyPublicKey](DepositReceipt.md#refundxonlypublickey)
- [walletPublicKeyHash](DepositReceipt.md#walletpublickeyhash)
- [walletXOnlyPublicKey](DepositReceipt.md#walletxonlypublickey)

## Properties

### blindingFactor

• **blindingFactor**: [`Hex`](../classes/Hex.md)

An 8-byte blinding factor. Must be unique for the given depositor, wallet
public key and refund public key.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:252](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L252)

___

### depositor

• **depositor**: [`ChainIdentifier`](ChainIdentifier.md)

Depositor's chain identifier.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:246](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L246)

___

### extraData

• `Optional` **extraData**: [`Hex`](../classes/Hex.md)

Optional 32-byte extra data.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:289](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L289)

___

### refundLocktime

• **refundLocktime**: [`Hex`](../classes/Hex.md)

A 4-byte little-endian refund locktime.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:284](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L284)

___

### refundPublicKeyHash

• **refundPublicKeyHash**: [`Hex`](../classes/Hex.md)

Public key hash that is meant to be used during deposit refund after the
locktime passes.

You can use `computeHash160` function to get the hash from a public key.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:267](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L267)

___

### refundXOnlyPublicKey

• `Optional` **refundXOnlyPublicKey**: [`Hex`](../classes/Hex.md)

Optional 32-byte x-only refund key embedded in the tapscript refund leaf
for Taproot-native deposits. Present only for P2TR deposit receipts.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:279](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L279)

___

### walletPublicKeyHash

• **walletPublicKeyHash**: [`Hex`](../classes/Hex.md)

Public key hash of the wallet that is meant to receive the deposit.

You can use `computeHash160` function to get the hash from a public key.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:259](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L259)

___

### walletXOnlyPublicKey

• `Optional` **walletXOnlyPublicKey**: [`Hex`](../classes/Hex.md)

Optional 32-byte x-only wallet key used as the Taproot internal key for
Taproot-native deposits. Present only for P2TR deposit receipts.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:273](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L273)
