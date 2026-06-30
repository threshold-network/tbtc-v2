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

[src/services/maintenance/p2tr-signature-fraud.ts:1722](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L1722)

## Properties

### persistence

• `Private` `Readonly` **persistence**: [`P2TRWatchtowerChallengeRecordPersistence`](../interfaces/P2TRWatchtowerChallengeRecordPersistence.md)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:1723](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L1723)

___

### records

• `Private` `Optional` **records**: `Map`\<`string`, [`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:1719](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L1719)

___

### saveQueue

• `Private` **saveQueue**: `Promise`\<`void`\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:1720](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L1720)

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

[src/services/maintenance/p2tr-signature-fraud.ts:1726](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L1726)

___

### listChallengeRecords

▸ **listChallengeRecords**(): `Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)[]\>

#### Returns

`Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)[]\>

#### Implementation of

[P2TRWatchtowerChallengeReplayStore](../interfaces/P2TRWatchtowerChallengeReplayStore.md).[listChallengeRecords](../interfaces/P2TRWatchtowerChallengeReplayStore.md#listchallengerecords)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:1752](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L1752)

___

### loadRecords

▸ **loadRecords**(): `Promise`\<`Map`\<`string`, [`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>\>

#### Returns

`Promise`\<`Map`\<`string`, [`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:1758](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L1758)

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

[src/services/maintenance/p2tr-signature-fraud.ts:1784](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L1784)

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

[src/services/maintenance/p2tr-signature-fraud.ts:1736](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L1736)
