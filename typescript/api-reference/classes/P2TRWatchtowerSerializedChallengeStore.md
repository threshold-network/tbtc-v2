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

[src/services/maintenance/p2tr-signature-fraud.ts:1773](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L1773)

## Properties

### persistence

• `Private` `Readonly` **persistence**: [`P2TRWatchtowerChallengeRecordPersistence`](../interfaces/P2TRWatchtowerChallengeRecordPersistence.md)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:1774](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L1774)

___

### records

• `Private` `Optional` **records**: `Map`\<`string`, [`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:1770](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L1770)

___

### saveQueue

• `Private` **saveQueue**: `Promise`\<`void`\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:1771](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L1771)

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

[src/services/maintenance/p2tr-signature-fraud.ts:1777](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L1777)

___

### listChallengeRecords

▸ **listChallengeRecords**(): `Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)[]\>

#### Returns

`Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)[]\>

#### Implementation of

[P2TRWatchtowerChallengeReplayStore](../interfaces/P2TRWatchtowerChallengeReplayStore.md).[listChallengeRecords](../interfaces/P2TRWatchtowerChallengeReplayStore.md#listchallengerecords)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:1803](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L1803)

___

### loadRecords

▸ **loadRecords**(): `Promise`\<`Map`\<`string`, [`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>\>

#### Returns

`Promise`\<`Map`\<`string`, [`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:1809](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L1809)

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

[src/services/maintenance/p2tr-signature-fraud.ts:1835](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L1835)

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

[src/services/maintenance/p2tr-signature-fraud.ts:1787](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L1787)
