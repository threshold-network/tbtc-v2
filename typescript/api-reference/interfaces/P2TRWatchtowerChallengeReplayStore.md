# Interface: P2TRWatchtowerChallengeReplayStore

## Hierarchy

- [`P2TRWatchtowerChallengeStore`](P2TRWatchtowerChallengeStore.md)

- [`P2TRWatchtowerChallengeRecordSource`](P2TRWatchtowerChallengeRecordSource.md)

  ↳ **`P2TRWatchtowerChallengeReplayStore`**

## Implemented by

- [`P2TRWatchtowerSerializedChallengeStore`](../classes/P2TRWatchtowerSerializedChallengeStore.md)

## Table of contents

### Methods

- [getChallengeRecord](P2TRWatchtowerChallengeReplayStore.md#getchallengerecord)
- [listChallengeRecords](P2TRWatchtowerChallengeReplayStore.md#listchallengerecords)
- [saveChallengeRecord](P2TRWatchtowerChallengeReplayStore.md#savechallengerecord)

## Methods

### getChallengeRecord

▸ **getChallengeRecord**(`observationID`): `Promise`\<`undefined` \| [`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `observationID` | [`Hex`](../classes/Hex.md) |

#### Returns

`Promise`\<`undefined` \| [`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Inherited from

[P2TRWatchtowerChallengeStore](P2TRWatchtowerChallengeStore.md).[getChallengeRecord](P2TRWatchtowerChallengeStore.md#getchallengerecord)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:2176](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L2176)

___

### listChallengeRecords

▸ **listChallengeRecords**(): `Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)[]\>

#### Returns

`Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)[]\>

#### Inherited from

[P2TRWatchtowerChallengeRecordSource](P2TRWatchtowerChallengeRecordSource.md).[listChallengeRecords](P2TRWatchtowerChallengeRecordSource.md#listchallengerecords)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:2183](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L2183)

___

### saveChallengeRecord

▸ **saveChallengeRecord**(`record`): `Promise`\<`void`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `record` | [`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord) |

#### Returns

`Promise`\<`void`\>

#### Inherited from

[P2TRWatchtowerChallengeStore](P2TRWatchtowerChallengeStore.md).[saveChallengeRecord](P2TRWatchtowerChallengeStore.md#savechallengerecord)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:2179](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L2179)
