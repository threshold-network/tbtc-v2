# Class: P2TRWatchtowerSerializedChallengeStore

## Implements

- [`P2TRWatchtowerChallengeReplayStore`](../interfaces/P2TRWatchtowerChallengeReplayStore.md)

## Table of contents

### Constructors

- [constructor](P2TRWatchtowerSerializedChallengeStore.md#constructor)

### Properties

- [persistence](P2TRWatchtowerSerializedChallengeStore.md#persistence)
- [records](P2TRWatchtowerSerializedChallengeStore.md#records)
- [saveQueue](P2TRWatchtowerSerializedChallengeStore.md#savequeue)

### Methods

- [getChallengeRecord](P2TRWatchtowerSerializedChallengeStore.md#getchallengerecord)
- [listChallengeRecords](P2TRWatchtowerSerializedChallengeStore.md#listchallengerecords)
- [loadRecords](P2TRWatchtowerSerializedChallengeStore.md#loadrecords)
- [persistRecords](P2TRWatchtowerSerializedChallengeStore.md#persistrecords)
- [saveChallengeRecord](P2TRWatchtowerSerializedChallengeStore.md#savechallengerecord)

## Constructors

### constructor

• **new P2TRWatchtowerSerializedChallengeStore**(`persistence`): [`P2TRWatchtowerSerializedChallengeStore`](P2TRWatchtowerSerializedChallengeStore.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `persistence` | [`P2TRWatchtowerChallengeRecordPersistence`](../interfaces/P2TRWatchtowerChallengeRecordPersistence.md) |

#### Returns

[`P2TRWatchtowerSerializedChallengeStore`](P2TRWatchtowerSerializedChallengeStore.md)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3535](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3535)

## Properties

### persistence

• `Private` `Readonly` **persistence**: [`P2TRWatchtowerChallengeRecordPersistence`](../interfaces/P2TRWatchtowerChallengeRecordPersistence.md)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3536](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3536)

___

### records

• `Private` `Optional` **records**: `Map`\<`string`, [`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3532](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3532)

___

### saveQueue

• `Private` **saveQueue**: `Promise`\<`void`\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3533](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3533)

## Methods

### getChallengeRecord

▸ **getChallengeRecord**(`observationID`): `Promise`\<`undefined` \| [`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `observationID` | [`Hex`](Hex.md) |

#### Returns

`Promise`\<`undefined` \| [`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Implementation of

[P2TRWatchtowerChallengeReplayStore](../interfaces/P2TRWatchtowerChallengeReplayStore.md).[getChallengeRecord](../interfaces/P2TRWatchtowerChallengeReplayStore.md#getchallengerecord)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3539](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3539)

___

### listChallengeRecords

▸ **listChallengeRecords**(): `Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)[]\>

#### Returns

`Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)[]\>

#### Implementation of

[P2TRWatchtowerChallengeReplayStore](../interfaces/P2TRWatchtowerChallengeReplayStore.md).[listChallengeRecords](../interfaces/P2TRWatchtowerChallengeReplayStore.md#listchallengerecords)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3565](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3565)

___

### loadRecords

▸ **loadRecords**(): `Promise`\<`Map`\<`string`, [`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>\>

#### Returns

`Promise`\<`Map`\<`string`, [`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3571](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3571)

___

### persistRecords

▸ **persistRecords**(`records`): `Promise`\<`void`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `records` | `Map`\<`string`, [`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\> |

#### Returns

`Promise`\<`void`\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3597](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3597)

___

### saveChallengeRecord

▸ **saveChallengeRecord**(`record`): `Promise`\<`void`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `record` | [`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord) |

#### Returns

`Promise`\<`void`\>

#### Implementation of

[P2TRWatchtowerChallengeReplayStore](../interfaces/P2TRWatchtowerChallengeReplayStore.md).[saveChallengeRecord](../interfaces/P2TRWatchtowerChallengeReplayStore.md#savechallengerecord)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3549](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3549)
