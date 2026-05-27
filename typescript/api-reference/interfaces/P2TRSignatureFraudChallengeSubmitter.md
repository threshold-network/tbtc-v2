# Interface: P2TRSignatureFraudChallengeSubmitter

## Implemented by

- [`P2TRSignatureFraudBridgeChallengeSubmitter`](../classes/P2TRSignatureFraudBridgeChallengeSubmitter.md)

## Table of contents

### Methods

- [submitSignatureFraudChallenge](P2TRSignatureFraudChallengeSubmitter.md#submitsignaturefraudchallenge)

## Methods

### submitSignatureFraudChallenge

▸ **submitSignatureFraudChallenge**(`observation`): `Promise`\<`string` \| [`Hex`](../classes/Hex.md) \| `Buffer`\<`ArrayBufferLike`\>\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `observation` | [`P2TRSignatureFraudWitnessObservation`](../README.md#p2trsignaturefraudwitnessobservation) |

#### Returns

`Promise`\<`string` \| [`Hex`](../classes/Hex.md) \| `Buffer`\<`ArrayBufferLike`\>\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:370](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L370)
