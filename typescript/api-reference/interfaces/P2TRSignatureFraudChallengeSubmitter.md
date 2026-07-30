# Interface: P2TRSignatureFraudChallengeSubmitter

Manual low-level challenge submission boundary. The automatic watchtower
runner does not invoke this interface while the FROST fraud layer remains
bounded/no-go.

## Implemented by

- [`P2TRSignatureFraudBridgeChallengeSubmitter`](../classes/P2TRSignatureFraudBridgeChallengeSubmitter.md)

## Table of contents

### Properties

- [submissionTrustDomainID](P2TRSignatureFraudChallengeSubmitter.md#submissiontrustdomainid)

### Methods

- [submitSignatureFraudChallenge](P2TRSignatureFraudChallengeSubmitter.md#submitsignaturefraudchallenge)

## Properties

### submissionTrustDomainID

• `Optional` `Readonly` **submissionTrustDomainID**: `string`

Provider/trust-domain identity used to broadcast, when declared.

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:507](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L507)

## Methods

### submitSignatureFraudChallenge

▸ **submitSignatureFraudChallenge**(`observation`, `options?`): `Promise`\<`string` \| [`Hex`](../classes/Hex.md) \| `Buffer`\<`ArrayBufferLike`\>\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `observation` | [`P2TRSignatureFraudWitnessObservation`](../README.md#p2trsignaturefraudwitnessobservation) |
| `options?` | [`P2TRSignatureFraudChallengeSubmissionOptions`](P2TRSignatureFraudChallengeSubmissionOptions.md) |

#### Returns

`Promise`\<`string` \| [`Hex`](../classes/Hex.md) \| `Buffer`\<`ArrayBufferLike`\>\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:508](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L508)
