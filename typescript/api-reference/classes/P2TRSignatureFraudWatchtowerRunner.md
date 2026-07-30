# Class: P2TRSignatureFraudWatchtowerRunner

Observation-only transaction and Bridge-lifecycle processing runner.

The submission constructor surface is retained for API compatibility, but
`submitChallenges: true` always rejects and no automatic broadcast occurs.

## Table of contents

### Constructors

- [constructor](P2TRSignatureFraudWatchtowerRunner.md#constructor)

### Properties

- [bitcoinClient](P2TRSignatureFraudWatchtowerRunner.md#bitcoinclient)
- [broadcastReconciler](P2TRSignatureFraudWatchtowerRunner.md#broadcastreconciler)
- [maxSubmissionAttempts](P2TRSignatureFraudWatchtowerRunner.md#maxsubmissionattempts)
- [submissionAttemptLimitAlert](P2TRSignatureFraudWatchtowerRunner.md#submissionattemptlimitalert)
- [watchtower](P2TRSignatureFraudWatchtowerRunner.md#watchtower)

### Methods

- [hasReachedSubmissionAttemptLimit](P2TRSignatureFraudWatchtowerRunner.md#hasreachedsubmissionattemptlimit)
- [observationResultsWithoutSubmission](P2TRSignatureFraudWatchtowerRunner.md#observationresultswithoutsubmission)
- [observeConfirmedTransactionsSettled](P2TRSignatureFraudWatchtowerRunner.md#observeconfirmedtransactionssettled)
- [observeMempoolTransactionsSettled](P2TRSignatureFraudWatchtowerRunner.md#observemempooltransactionssettled)
- [processBridgeLifecycleEvent](P2TRSignatureFraudWatchtowerRunner.md#processbridgelifecycleevent)
- [processBridgeLifecycleEventSourceSettled](P2TRSignatureFraudWatchtowerRunner.md#processbridgelifecycleeventsourcesettled)
- [processBridgeLifecycleEventsSettled](P2TRSignatureFraudWatchtowerRunner.md#processbridgelifecycleeventssettled)
- [processBridgeLifecycleSourceResult](P2TRSignatureFraudWatchtowerRunner.md#processbridgelifecyclesourceresult)
- [processConfirmedSourceResult](P2TRSignatureFraudWatchtowerRunner.md#processconfirmedsourceresult)
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
- [reconcileAmbiguousBroadcastRecord](P2TRSignatureFraudWatchtowerRunner.md#reconcileambiguousbroadcastrecord)
- [replayStoredChallengeRecords](P2TRSignatureFraudWatchtowerRunner.md#replaystoredchallengerecords)
- [replayStoredChallenges](P2TRSignatureFraudWatchtowerRunner.md#replaystoredchallenges)
- [replayStoredChallengesAfterLifecycle](P2TRSignatureFraudWatchtowerRunner.md#replaystoredchallengesafterlifecycle)
- [submitPersistedObservationBatch](P2TRSignatureFraudWatchtowerRunner.md#submitpersistedobservationbatch)
- [withSubmissionAttemptLimitAlert](P2TRSignatureFraudWatchtowerRunner.md#withsubmissionattemptlimitalert)

## Constructors

### constructor

• **new P2TRSignatureFraudWatchtowerRunner**(`watchtower`, `bitcoinClient`, `_submitter`, `options?`, `broadcastReconciler?`): [`P2TRSignatureFraudWatchtowerRunner`](P2TRSignatureFraudWatchtowerRunner.md)

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `watchtower` | [`P2TRSignatureFraudWatchtower`](P2TRSignatureFraudWatchtower.md) | - |
| `bitcoinClient` | [`BitcoinClient`](../interfaces/BitcoinClient.md) | - |
| `_submitter` | [`P2TRSignatureFraudChallengeSubmitter`](../interfaces/P2TRSignatureFraudChallengeSubmitter.md) | Compatibility-only low-level submitter; this runner never invokes it. |
| `options` | [`P2TRSignatureFraudWatchtowerRunnerOptions`](../README.md#p2trsignaturefraudwatchtowerrunneroptions) | Observation-only options; `submitChallenges: true` always rejects. |
| `broadcastReconciler?` | [`P2TRSignatureFraudChallengeBroadcastReconciler`](../interfaces/P2TRSignatureFraudChallengeBroadcastReconciler.md) | Future `COMPLETE_V2` scaffolding; it cannot enable submission. |

#### Returns

[`P2TRSignatureFraudWatchtowerRunner`](P2TRSignatureFraudWatchtowerRunner.md)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:4259](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4259)

## Properties

### bitcoinClient

• `Private` `Readonly` **bitcoinClient**: [`BitcoinClient`](../interfaces/BitcoinClient.md)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:4261](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4261)

___

### broadcastReconciler

• `Private` `Optional` `Readonly` **broadcastReconciler**: [`P2TRSignatureFraudChallengeBroadcastReconciler`](../interfaces/P2TRSignatureFraudChallengeBroadcastReconciler.md)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:4257](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4257)

___

### maxSubmissionAttempts

• `Private` `Optional` `Readonly` **maxSubmissionAttempts**: `number`

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:4255](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4255)

___

### submissionAttemptLimitAlert

• `Private` `Optional` `Readonly` **submissionAttemptLimitAlert**: [`P2TRWatchtowerOperatorAlert`](../README.md#p2trwatchtoweroperatoralert)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:4256](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4256)

___

### watchtower

• `Private` `Readonly` **watchtower**: [`P2TRSignatureFraudWatchtower`](P2TRSignatureFraudWatchtower.md)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:4260](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4260)

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

[src/services/maintenance/p2tr-signature-fraud.ts:4316](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4316)

___

### observationResultsWithoutSubmission

▸ **observationResultsWithoutSubmission**(`observationResults`): [`P2TRSignatureFraudWatchtowerSubmissionResult`](../README.md#p2trsignaturefraudwatchtowersubmissionresult)[]

#### Parameters

| Name | Type |
| :------ | :------ |
| `observationResults` | [`P2TRSignatureFraudWatchtowerObservationResult`](../README.md#p2trsignaturefraudwatchtowerobservationresult)[] |

#### Returns

[`P2TRSignatureFraudWatchtowerSubmissionResult`](../README.md#p2trsignaturefraudwatchtowersubmissionresult)[]

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:4876](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4876)

___

### observeConfirmedTransactionsSettled

▸ **observeConfirmedTransactionsSettled**(`transactions`): `Promise`\<[`P2TRSignatureFraudWatchtowerBatchResult`](../README.md#p2trsignaturefraudwatchtowerbatchresult)\<[`P2TRWatchtowerConfirmedTransaction`](../README.md#p2trwatchtowerconfirmedtransaction)\>\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `transactions` | [`P2TRWatchtowerConfirmedTransaction`](../README.md#p2trwatchtowerconfirmedtransaction)[] |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerBatchResult`](../README.md#p2trsignaturefraudwatchtowerbatchresult)\<[`P2TRWatchtowerConfirmedTransaction`](../README.md#p2trwatchtowerconfirmedtransaction)\>\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:4441](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4441)

___

### observeMempoolTransactionsSettled

▸ **observeMempoolTransactionsSettled**(`transactions`): `Promise`\<[`P2TRSignatureFraudWatchtowerBatchResult`](../README.md#p2trsignaturefraudwatchtowerbatchresult)\<[`P2TRWatchtowerMempoolTransaction`](../README.md#p2trwatchtowermempooltransaction)\>\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `transactions` | [`P2TRWatchtowerMempoolTransaction`](../README.md#p2trwatchtowermempooltransaction)[] |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerBatchResult`](../README.md#p2trsignaturefraudwatchtowerbatchresult)\<[`P2TRWatchtowerMempoolTransaction`](../README.md#p2trwatchtowermempooltransaction)\>\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:4424](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4424)

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

[src/services/maintenance/p2tr-signature-fraud.ts:4610](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4610)

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

[src/services/maintenance/p2tr-signature-fraud.ts:4716](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4716)

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

[src/services/maintenance/p2tr-signature-fraud.ts:4653](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4653)

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

[src/services/maintenance/p2tr-signature-fraud.ts:4938](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4938)

___

### processConfirmedSourceResult

▸ **processConfirmedSourceResult**(`source`, `sourceResult`, `sourceFailures`, `processTransactions`): `Promise`\<[`P2TRSignatureFraudWatchtowerBatchResult`](../README.md#p2trsignaturefraudwatchtowerbatchresult)\<[`P2TRWatchtowerConfirmedTransaction`](../README.md#p2trwatchtowerconfirmedtransaction)\>\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `source` | ``"confirmed"`` |
| `sourceResult` | `PromiseSettledResult`\<[`P2TRWatchtowerConfirmedTransactionSourceResult`](../README.md#p2trwatchtowerconfirmedtransactionsourceresult)\> |
| `sourceFailures` | [`P2TRSignatureFraudWatchtowerSourceFailure`](../README.md#p2trsignaturefraudwatchtowersourcefailure)[] |
| `processTransactions` | (`transactions`: [`P2TRWatchtowerConfirmedTransaction`](../README.md#p2trwatchtowerconfirmedtransaction)[]) => `Promise`\<[`P2TRSignatureFraudWatchtowerBatchResult`](../README.md#p2trsignaturefraudwatchtowerbatchresult)\<[`P2TRWatchtowerConfirmedTransaction`](../README.md#p2trwatchtowerconfirmedtransaction)\>\> |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerBatchResult`](../README.md#p2trsignaturefraudwatchtowerbatchresult)\<[`P2TRWatchtowerConfirmedTransaction`](../README.md#p2trwatchtowerconfirmedtransaction)\>\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:4905](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4905)

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

[src/services/maintenance/p2tr-signature-fraud.ts:4371](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4371)

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

[src/services/maintenance/p2tr-signature-fraud.ts:4390](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4390)

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

[src/services/maintenance/p2tr-signature-fraud.ts:4408](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4408)

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

[src/services/maintenance/p2tr-signature-fraud.ts:4326](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4326)

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

[src/services/maintenance/p2tr-signature-fraud.ts:4341](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4341)

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

[src/services/maintenance/p2tr-signature-fraud.ts:4357](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4357)

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

[src/services/maintenance/p2tr-signature-fraud.ts:4885](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4885)

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

[src/services/maintenance/p2tr-signature-fraud.ts:4566](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4566)

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

[src/services/maintenance/p2tr-signature-fraud.ts:4978](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4978)

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

[src/services/maintenance/p2tr-signature-fraud.ts:4746](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4746)

___

### reconcileAmbiguousBroadcastRecord

▸ **reconcileAmbiguousBroadcastRecord**(`record`): `Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `record` | [`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord) |

#### Returns

`Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:4499](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4499)

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

[src/services/maintenance/p2tr-signature-fraud.ts:4490](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4490)

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

[src/services/maintenance/p2tr-signature-fraud.ts:4460](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4460)

___

### replayStoredChallengesAfterLifecycle

▸ **replayStoredChallengesAfterLifecycle**(`records`, `allowSubmissions`): `Promise`\<[`P2TRSignatureFraudWatchtowerSubmissionResult`](../README.md#p2trsignaturefraudwatchtowersubmissionresult)[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `records` | [`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)[] |
| `allowSubmissions` | `boolean` |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerSubmissionResult`](../README.md#p2trsignaturefraudwatchtowersubmissionresult)[]\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:4466](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4466)

___

### submitPersistedObservationBatch

▸ **submitPersistedObservationBatch**\<`T`\>(`batch`, `recordSource`, `allowSubmissions`): `Promise`\<[`P2TRSignatureFraudWatchtowerBatchResult`](../README.md#p2trsignaturefraudwatchtowerbatchresult)\<`T`\>\>

#### Type parameters

| Name |
| :------ |
| `T` |

#### Parameters

| Name | Type |
| :------ | :------ |
| `batch` | [`P2TRSignatureFraudWatchtowerBatchResult`](../README.md#p2trsignaturefraudwatchtowerbatchresult)\<`T`\> |
| `recordSource` | [`P2TRWatchtowerChallengeRecordSource`](../interfaces/P2TRWatchtowerChallengeRecordSource.md) |
| `allowSubmissions` | `boolean` |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerBatchResult`](../README.md#p2trsignaturefraudwatchtowerbatchresult)\<`T`\>\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:4834](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4834)

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

[src/services/maintenance/p2tr-signature-fraud.ts:4960](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L4960)
