# Class: P2TRSignatureFraudWatchtowerRunner

## Table of contents

### Constructors

- [constructor](P2TRSignatureFraudWatchtowerRunner.md#constructor)

### Properties

- [bitcoinClient](P2TRSignatureFraudWatchtowerRunner.md#bitcoinclient)
- [maxSubmissionAttempts](P2TRSignatureFraudWatchtowerRunner.md#maxsubmissionattempts)
- [submissionAttemptLimitAlert](P2TRSignatureFraudWatchtowerRunner.md#submissionattemptlimitalert)
- [submissionPolicy](P2TRSignatureFraudWatchtowerRunner.md#submissionpolicy)
- [submitChallenges](P2TRSignatureFraudWatchtowerRunner.md#submitchallenges)
- [submitter](P2TRSignatureFraudWatchtowerRunner.md#submitter)
- [watchtower](P2TRSignatureFraudWatchtowerRunner.md#watchtower)

### Methods

- [hasReachedSubmissionAttemptLimit](P2TRSignatureFraudWatchtowerRunner.md#hasreachedsubmissionattemptlimit)
- [processBridgeLifecycleEvent](P2TRSignatureFraudWatchtowerRunner.md#processbridgelifecycleevent)
- [processBridgeLifecycleEventSourceSettled](P2TRSignatureFraudWatchtowerRunner.md#processbridgelifecycleeventsourcesettled)
- [processBridgeLifecycleEventsSettled](P2TRSignatureFraudWatchtowerRunner.md#processbridgelifecycleeventssettled)
- [processBridgeLifecycleSourceResult](P2TRSignatureFraudWatchtowerRunner.md#processbridgelifecyclesourceresult)
- [processConfirmedTransaction](P2TRSignatureFraudWatchtowerRunner.md#processconfirmedtransaction)
- [processConfirmedTransactions](P2TRSignatureFraudWatchtowerRunner.md#processconfirmedtransactions)
- [processConfirmedTransactionsSettled](P2TRSignatureFraudWatchtowerRunner.md#processconfirmedtransactionssettled)
- [processMempoolTransaction](P2TRSignatureFraudWatchtowerRunner.md#processmempooltransaction)
- [processMempoolTransactions](P2TRSignatureFraudWatchtowerRunner.md#processmempooltransactions)
- [processMempoolTransactionsSettled](P2TRSignatureFraudWatchtowerRunner.md#processmempooltransactionssettled)
- [processTransactionSourceResult](P2TRSignatureFraudWatchtowerRunner.md#processtransactionsourceresult)
- [processTransactionSourceSettled](P2TRSignatureFraudWatchtowerRunner.md#processtransactionsourcesettled)
- [processTransactionsSettled](P2TRSignatureFraudWatchtowerRunner.md#processtransactionssettled)
- [processWatchtowerSourcesSettled](P2TRSignatureFraudWatchtowerRunner.md#processwatchtowersourcessettled)
- [replayStoredChallengeRecords](P2TRSignatureFraudWatchtowerRunner.md#replaystoredchallengerecords)
- [replayStoredChallenges](P2TRSignatureFraudWatchtowerRunner.md#replaystoredchallenges)
- [shouldSubmitChallenge](P2TRSignatureFraudWatchtowerRunner.md#shouldsubmitchallenge)
- [submitObservationResults](P2TRSignatureFraudWatchtowerRunner.md#submitobservationresults)
- [withSubmissionAttemptLimitAlert](P2TRSignatureFraudWatchtowerRunner.md#withsubmissionattemptlimitalert)

## Constructors

### constructor

• **new P2TRSignatureFraudWatchtowerRunner**(`watchtower`, `bitcoinClient`, `submitter`, `options?`): [`P2TRSignatureFraudWatchtowerRunner`](P2TRSignatureFraudWatchtowerRunner.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `watchtower` | [`P2TRSignatureFraudWatchtower`](P2TRSignatureFraudWatchtower.md) |
| `bitcoinClient` | [`BitcoinClient`](../interfaces/BitcoinClient.md) |
| `submitter` | [`P2TRSignatureFraudChallengeSubmitter`](../interfaces/P2TRSignatureFraudChallengeSubmitter.md) |
| `options` | [`P2TRSignatureFraudWatchtowerRunnerOptions`](../README.md#p2trsignaturefraudwatchtowerrunneroptions) |

#### Returns

[`P2TRSignatureFraudWatchtowerRunner`](P2TRSignatureFraudWatchtowerRunner.md)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3624](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3624)

## Properties

### bitcoinClient

• `Private` `Readonly` **bitcoinClient**: [`BitcoinClient`](../interfaces/BitcoinClient.md)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3626](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3626)

___

### maxSubmissionAttempts

• `Private` `Optional` `Readonly` **maxSubmissionAttempts**: `number`

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3620](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3620)

___

### submissionAttemptLimitAlert

• `Private` `Optional` `Readonly` **submissionAttemptLimitAlert**: [`P2TRWatchtowerOperatorAlert`](../README.md#p2trwatchtoweroperatoralert)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3621](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3621)

___

### submissionPolicy

• `Private` `Readonly` **submissionPolicy**: [`P2TRSignatureFraudChallengeSubmissionPolicy`](../README.md#p2trsignaturefraudchallengesubmissionpolicy)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3622](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3622)

___

### submitChallenges

• `Private` `Readonly` **submitChallenges**: `boolean`

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3619](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3619)

___

### submitter

• `Private` `Readonly` **submitter**: [`P2TRSignatureFraudChallengeSubmitter`](../interfaces/P2TRSignatureFraudChallengeSubmitter.md)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3627](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3627)

___

### watchtower

• `Private` `Readonly` **watchtower**: [`P2TRSignatureFraudWatchtower`](P2TRSignatureFraudWatchtower.md)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3625](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3625)

## Methods

### hasReachedSubmissionAttemptLimit

▸ **hasReachedSubmissionAttemptLimit**(`record`): `boolean`

#### Parameters

| Name | Type |
| :------ | :------ |
| `record` | [`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord) |

#### Returns

`boolean`

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3684](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3684)

___

### processBridgeLifecycleEvent

▸ **processBridgeLifecycleEvent**(`event`, `recordSource?`): `Promise`\<`undefined` \| [`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | [`P2TRSignatureFraudWatchtowerBridgeLifecycleEvent`](../README.md#p2trsignaturefraudwatchtowerbridgelifecycleevent) |
| `recordSource?` | [`P2TRWatchtowerChallengeRecordSource`](../interfaces/P2TRWatchtowerChallengeRecordSource.md) |

#### Returns

`Promise`\<`undefined` \| [`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3874](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3874)

___

### processBridgeLifecycleEventSourceSettled

▸ **processBridgeLifecycleEventSourceSettled**(`eventSource`, `recordSource`): `Promise`\<[`P2TRSignatureFraudWatchtowerBridgeLifecycleCycleResult`](../README.md#p2trsignaturefraudwatchtowerbridgelifecyclecycleresult)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `eventSource` | [`P2TRSignatureFraudWatchtowerBridgeLifecycleEventSource`](../interfaces/P2TRSignatureFraudWatchtowerBridgeLifecycleEventSource.md) |
| `recordSource` | [`P2TRWatchtowerChallengeRecordSource`](../interfaces/P2TRWatchtowerChallengeRecordSource.md) |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerBridgeLifecycleCycleResult`](../README.md#p2trsignaturefraudwatchtowerbridgelifecyclecycleresult)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3980](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3980)

___

### processBridgeLifecycleEventsSettled

▸ **processBridgeLifecycleEventsSettled**(`events`, `recordSource?`): `Promise`\<[`P2TRSignatureFraudWatchtowerBridgeLifecycleBatchResult`](../README.md#p2trsignaturefraudwatchtowerbridgelifecyclebatchresult)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `events` | [`P2TRSignatureFraudWatchtowerBridgeLifecycleEvent`](../README.md#p2trsignaturefraudwatchtowerbridgelifecycleevent)[] |
| `recordSource?` | [`P2TRWatchtowerChallengeRecordSource`](../interfaces/P2TRWatchtowerChallengeRecordSource.md) |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerBridgeLifecycleBatchResult`](../README.md#p2trsignaturefraudwatchtowerbridgelifecyclebatchresult)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3917](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3917)

___

### processBridgeLifecycleSourceResult

▸ **processBridgeLifecycleSourceResult**(`sourceResult`, `sourceFailures`, `recordSource`): `Promise`\<[`P2TRSignatureFraudWatchtowerBridgeLifecycleBatchResult`](../README.md#p2trsignaturefraudwatchtowerbridgelifecyclebatchresult)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `sourceResult` | `PromiseSettledResult`\<[`P2TRSignatureFraudWatchtowerBridgeLifecycleEvent`](../README.md#p2trsignaturefraudwatchtowerbridgelifecycleevent)[]\> |
| `sourceFailures` | [`P2TRSignatureFraudWatchtowerBridgeLifecycleSourceFailure`](../README.md#p2trsignaturefraudwatchtowerbridgelifecyclesourcefailure)[] |
| `recordSource` | [`P2TRWatchtowerChallengeRecordSource`](../interfaces/P2TRWatchtowerChallengeRecordSource.md) |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerBridgeLifecycleBatchResult`](../README.md#p2trsignaturefraudwatchtowerbridgelifecyclebatchresult)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:4099](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4099)

___

### processConfirmedTransaction

▸ **processConfirmedTransaction**(`rawTransaction`, `bitcoinTxHash`, `bitcoinBlockHash`, `bitcoinBlockHeight`, `walletInputKeyBindings?`): `Promise`\<[`P2TRSignatureFraudWatchtowerSubmissionResult`](../README.md#p2trsignaturefraudwatchtowersubmissionresult)[]\>

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `rawTransaction` | [`BitcoinRawTx`](../interfaces/BitcoinRawTx.md) | `undefined` |
| `bitcoinTxHash` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> | `undefined` |
| `bitcoinBlockHash` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> | `undefined` |
| `bitcoinBlockHeight` | `number` | `undefined` |
| `walletInputKeyBindings` | [`P2TRWalletInputKeyBinding`](../README.md#p2trwalletinputkeybinding)[] | `[]` |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerSubmissionResult`](../README.md#p2trsignaturefraudwatchtowersubmissionresult)[]\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3750](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3750)

___

### processConfirmedTransactions

▸ **processConfirmedTransactions**(`transactions`): `Promise`\<[`P2TRSignatureFraudWatchtowerSubmissionResult`](../README.md#p2trsignaturefraudwatchtowersubmissionresult)[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `transactions` | [`P2TRWatchtowerConfirmedTransaction`](../README.md#p2trwatchtowerconfirmedtransaction)[] |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerSubmissionResult`](../README.md#p2trsignaturefraudwatchtowersubmissionresult)[]\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3769](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3769)

___

### processConfirmedTransactionsSettled

▸ **processConfirmedTransactionsSettled**(`transactions`): `Promise`\<[`P2TRSignatureFraudWatchtowerBatchResult`](../README.md#p2trsignaturefraudwatchtowerbatchresult)\<[`P2TRWatchtowerConfirmedTransaction`](../README.md#p2trwatchtowerconfirmedtransaction)\>\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `transactions` | [`P2TRWatchtowerConfirmedTransaction`](../README.md#p2trwatchtowerconfirmedtransaction)[] |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerBatchResult`](../README.md#p2trsignaturefraudwatchtowerbatchresult)\<[`P2TRWatchtowerConfirmedTransaction`](../README.md#p2trwatchtowerconfirmedtransaction)\>\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3787](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3787)

___

### processMempoolTransaction

▸ **processMempoolTransaction**(`rawTransaction`, `bitcoinTxHash`, `walletInputKeyBindings?`): `Promise`\<[`P2TRSignatureFraudWatchtowerSubmissionResult`](../README.md#p2trsignaturefraudwatchtowersubmissionresult)[]\>

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `rawTransaction` | [`BitcoinRawTx`](../interfaces/BitcoinRawTx.md) | `undefined` |
| `bitcoinTxHash` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> | `undefined` |
| `walletInputKeyBindings` | [`P2TRWalletInputKeyBinding`](../README.md#p2trwalletinputkeybinding)[] | `[]` |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerSubmissionResult`](../README.md#p2trsignaturefraudwatchtowersubmissionresult)[]\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3705](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3705)

___

### processMempoolTransactions

▸ **processMempoolTransactions**(`transactions`): `Promise`\<[`P2TRSignatureFraudWatchtowerSubmissionResult`](../README.md#p2trsignaturefraudwatchtowersubmissionresult)[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `transactions` | [`P2TRWatchtowerMempoolTransaction`](../README.md#p2trwatchtowermempooltransaction)[] |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerSubmissionResult`](../README.md#p2trsignaturefraudwatchtowersubmissionresult)[]\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3720](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3720)

___

### processMempoolTransactionsSettled

▸ **processMempoolTransactionsSettled**(`transactions`): `Promise`\<[`P2TRSignatureFraudWatchtowerBatchResult`](../README.md#p2trsignaturefraudwatchtowerbatchresult)\<[`P2TRWatchtowerMempoolTransaction`](../README.md#p2trwatchtowermempooltransaction)\>\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `transactions` | [`P2TRWatchtowerMempoolTransaction`](../README.md#p2trwatchtowermempooltransaction)[] |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerBatchResult`](../README.md#p2trsignaturefraudwatchtowerbatchresult)\<[`P2TRWatchtowerMempoolTransaction`](../README.md#p2trwatchtowermempooltransaction)\>\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3736](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3736)

___

### processTransactionSourceResult

▸ **processTransactionSourceResult**\<`T`\>(`source`, `sourceResult`, `sourceFailures`, `processTransactions`): `Promise`\<[`P2TRSignatureFraudWatchtowerBatchResult`](../README.md#p2trsignaturefraudwatchtowerbatchresult)\<`T`\>\>

#### Type parameters

| Name |
| :------ |
| `T` |

#### Parameters

| Name | Type |
| :------ | :------ |
| `source` | [`P2TRSignatureFraudWatchtowerTransactionSourceName`](../README.md#p2trsignaturefraudwatchtowertransactionsourcename) |
| `sourceResult` | `PromiseSettledResult`\<`T`[]\> |
| `sourceFailures` | [`P2TRSignatureFraudWatchtowerSourceFailure`](../README.md#p2trsignaturefraudwatchtowersourcefailure)[] |
| `processTransactions` | (`transactions`: `T`[]) => `Promise`\<[`P2TRSignatureFraudWatchtowerBatchResult`](../README.md#p2trsignaturefraudwatchtowerbatchresult)\<`T`\>\> |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerBatchResult`](../README.md#p2trsignaturefraudwatchtowerbatchresult)\<`T`\>\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:4079](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4079)

___

### processTransactionSourceSettled

▸ **processTransactionSourceSettled**(`transactionSource`, `recordSource`): `Promise`\<[`P2TRSignatureFraudWatchtowerCycleResult`](../README.md#p2trsignaturefraudwatchtowercycleresult)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `transactionSource` | [`P2TRSignatureFraudWatchtowerTransactionSource`](../interfaces/P2TRSignatureFraudWatchtowerTransactionSource.md) |
| `recordSource` | [`P2TRWatchtowerChallengeRecordSource`](../interfaces/P2TRWatchtowerChallengeRecordSource.md) |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerCycleResult`](../README.md#p2trsignaturefraudwatchtowercycleresult)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3838](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3838)

___

### processTransactionsSettled

▸ **processTransactionsSettled**\<`T`\>(`transactions`, `processTransaction`): `Promise`\<[`P2TRSignatureFraudWatchtowerBatchResult`](../README.md#p2trsignaturefraudwatchtowerbatchresult)\<`T`\>\>

#### Type parameters

| Name |
| :------ |
| `T` |

#### Parameters

| Name | Type |
| :------ | :------ |
| `transactions` | `T`[] |
| `processTransaction` | (`transaction`: `T`) => `Promise`\<[`P2TRSignatureFraudWatchtowerSubmissionResult`](../README.md#p2trsignaturefraudwatchtowersubmissionresult)[]\> |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerBatchResult`](../README.md#p2trsignaturefraudwatchtowerbatchresult)\<`T`\>\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:4139](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4139)

___

### processWatchtowerSourcesSettled

▸ **processWatchtowerSourcesSettled**(`transactionSource`, `bridgeLifecycleEventSource`, `recordSource`): `Promise`\<[`P2TRSignatureFraudWatchtowerIntegratedCycleResult`](../README.md#p2trsignaturefraudwatchtowerintegratedcycleresult)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `transactionSource` | [`P2TRSignatureFraudWatchtowerTransactionSource`](../interfaces/P2TRSignatureFraudWatchtowerTransactionSource.md) |
| `bridgeLifecycleEventSource` | [`P2TRSignatureFraudWatchtowerBridgeLifecycleEventSource`](../interfaces/P2TRSignatureFraudWatchtowerBridgeLifecycleEventSource.md) |
| `recordSource` | [`P2TRWatchtowerChallengeRecordSource`](../interfaces/P2TRWatchtowerChallengeRecordSource.md) |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerIntegratedCycleResult`](../README.md#p2trsignaturefraudwatchtowerintegratedcycleresult)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:4010](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4010)

___

### replayStoredChallengeRecords

▸ **replayStoredChallengeRecords**(`recordSource`): `Promise`\<[`P2TRSignatureFraudWatchtowerSubmissionResult`](../README.md#p2trsignaturefraudwatchtowersubmissionresult)[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `recordSource` | [`P2TRWatchtowerChallengeRecordSource`](../interfaces/P2TRWatchtowerChallengeRecordSource.md) |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerSubmissionResult`](../README.md#p2trsignaturefraudwatchtowersubmissionresult)[]\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3830](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3830)

___

### replayStoredChallenges

▸ **replayStoredChallenges**(`records`): `Promise`\<[`P2TRSignatureFraudWatchtowerSubmissionResult`](../README.md#p2trsignaturefraudwatchtowersubmissionresult)[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `records` | [`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)[] |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerSubmissionResult`](../README.md#p2trsignaturefraudwatchtowersubmissionresult)[]\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3803](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3803)

___

### shouldSubmitChallenge

▸ **shouldSubmitChallenge**(`record`): `boolean`

#### Parameters

| Name | Type |
| :------ | :------ |
| `record` | [`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord) |

#### Returns

`boolean`

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3694](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3694)

___

### submitObservationResults

▸ **submitObservationResults**(`observationResults`): `Promise`\<[`P2TRSignatureFraudWatchtowerSubmissionResult`](../README.md#p2trsignaturefraudwatchtowersubmissionresult)[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `observationResults` | [`P2TRSignatureFraudWatchtowerObservationResult`](../README.md#p2trsignaturefraudwatchtowerobservationresult)[] |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerSubmissionResult`](../README.md#p2trsignaturefraudwatchtowersubmissionresult)[]\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:4060](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4060)

___

### withSubmissionAttemptLimitAlert

▸ **withSubmissionAttemptLimitAlert**(`record`): `Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `record` | [`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord) |

#### Returns

`Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:4121](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4121)
