# Interface: P2TRSignatureFraudChallengeSubmissionOptions

Options for the manual low-level challenge submission API. They do not
enable the observation-only watchtower automatic submission path.

## Table of contents

### Properties

- [onBroadcast](P2TRSignatureFraudChallengeSubmissionOptions.md#onbroadcast)

## Properties

### onBroadcast

• `Optional` **onBroadcast**: (`challengeTxHash`: `string` \| [`Hex`](../classes/Hex.md) \| `Buffer`\<`ArrayBufferLike`\>) => `void` \| `Promise`\<`void`\>

Invoked immediately after the challenge transaction has been broadcast (its
hash is known) and before any confirmation wait. Lets callers durably record
the irreversible broadcast before the submission is fully resolved, so the
challenge is never re-broadcast on replay after a later failure.

#### Type declaration

▸ (`challengeTxHash`): `void` \| `Promise`\<`void`\>

##### Parameters

| Name | Type |
| :------ | :------ |
| `challengeTxHash` | `string` \| [`Hex`](../classes/Hex.md) \| `Buffer`\<`ArrayBufferLike`\> |

##### Returns

`void` \| `Promise`\<`void`\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:497](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L497)
