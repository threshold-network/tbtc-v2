# Interface: P2TRSignatureFraudChallengeBroadcastReconciler

Future `COMPLETE_V2` activation scaffolding for resolving an ambiguous
challenge broadcast against canonical chain state.

The current watchtower is observation-only and this interface does not
enable automatic submission. Any separately reviewed production activation
must use a trust domain independent from the provider that broadcast the
transaction. It may return `absent-after-finality` only after a bounded
finality policy proves both the transaction hash and the Router challenge
key are absent.

## Table of contents

### Properties

- [finalityConfirmationBlocks](P2TRSignatureFraudChallengeBroadcastReconciler.md#finalityconfirmationblocks)
- [reconciliationTrustDomainID](P2TRSignatureFraudChallengeBroadcastReconciler.md#reconciliationtrustdomainid)

### Methods

- [reconcileSignatureFraudChallengeBroadcast](P2TRSignatureFraudChallengeBroadcastReconciler.md#reconcilesignaturefraudchallengebroadcast)

## Properties

### finalityConfirmationBlocks

• `Readonly` **finalityConfirmationBlocks**: `number`

Positive canonical confirmation depth required before proving absence.

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:255](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L255)

___

### reconciliationTrustDomainID

• `Readonly` **reconciliationTrustDomainID**: `string`

Independent provider/trust-domain identity used for reconciliation.

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:253](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L253)

## Methods

### reconcileSignatureFraudChallengeBroadcast

▸ **reconcileSignatureFraudChallengeBroadcast**(`context`): `Promise`\<[`P2TRSignatureFraudChallengeBroadcastResolution`](../README.md#p2trsignaturefraudchallengebroadcastresolution)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `context` | [`P2TRSignatureFraudChallengeBroadcastReconciliationContext`](../README.md#p2trsignaturefraudchallengebroadcastreconciliationcontext) |

#### Returns

`Promise`\<[`P2TRSignatureFraudChallengeBroadcastResolution`](../README.md#p2trsignaturefraudchallengebroadcastresolution)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:256](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L256)
