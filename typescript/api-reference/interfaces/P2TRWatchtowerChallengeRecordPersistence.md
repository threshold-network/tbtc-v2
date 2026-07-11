# Interface: P2TRWatchtowerChallengeRecordPersistence

## Table of contents

### Methods

- [loadChallengeRecords](P2TRWatchtowerChallengeRecordPersistence.md#loadchallengerecords)
- [saveChallengeRecords](P2TRWatchtowerChallengeRecordPersistence.md#savechallengerecords)

## Methods

### loadChallengeRecords

▸ **loadChallengeRecords**(): `Promise`\<[`P2TRWatchtowerChallengeRecordJSON`](../README.md#p2trwatchtowerchallengerecordjson)[]\>

#### Returns

`Promise`\<[`P2TRWatchtowerChallengeRecordJSON`](../README.md#p2trwatchtowerchallengerecordjson)[]\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:629](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L629)

___

### saveChallengeRecords

▸ **saveChallengeRecords**(`records`): `Promise`\<`void`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `records` | [`P2TRWatchtowerChallengeRecordJSON`](../README.md#p2trwatchtowerchallengerecordjson)[] |

#### Returns

`Promise`\<`void`\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:630](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L630)
