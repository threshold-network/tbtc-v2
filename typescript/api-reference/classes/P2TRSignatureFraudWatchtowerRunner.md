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
- [reconcileCanonicalSourceOrphans](P2TRSignatureFraudWatchtowerRunner.md#reconcilecanonicalsourceorphans)
- [registerCanonicalSourceWalletIDs](P2TRSignatureFraudWatchtowerRunner.md#registercanonicalsourcewalletids)
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

[src/services/maintenance/p2tr-signature-fraud.ts:5693](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L5693)

## Properties

### bitcoinClient

• `Private` `Readonly` **bitcoinClient**: [`BitcoinClient`](../interfaces/BitcoinClient.md)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:5695](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L5695)

___

### broadcastReconciler

• `Private` `Optional` `Readonly` **broadcastReconciler**: [`P2TRSignatureFraudChallengeBroadcastReconciler`](../interfaces/P2TRSignatureFraudChallengeBroadcastReconciler.md)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:5691](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L5691)

___

### maxSubmissionAttempts

• `Private` `Optional` `Readonly` **maxSubmissionAttempts**: `number`

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:5689](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L5689)

___

### submissionAttemptLimitAlert

• `Private` `Optional` `Readonly` **submissionAttemptLimitAlert**: [`P2TRWatchtowerOperatorAlert`](../README.md#p2trwatchtoweroperatoralert)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:5690](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L5690)

___

### watchtower

• `Private` `Readonly` **watchtower**: [`P2TRSignatureFraudWatchtower`](P2TRSignatureFraudWatchtower.md)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:5694](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L5694)

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

[src/services/maintenance/p2tr-signature-fraud.ts:5750](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L5750)

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

[src/services/maintenance/p2tr-signature-fraud.ts:6549](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6549)

___

### observeConfirmedTransactionsSettled

▸ **observeConfirmedTransactionsSettled**(`transactions`, `requireAuthenticatedPrevouts?`): `Promise`\<[`P2TRSignatureFraudWatchtowerBatchResult`](../README.md#p2trsignaturefraudwatchtowerbatchresult)\<[`P2TRWatchtowerConfirmedTransaction`](../README.md#p2trwatchtowerconfirmedtransaction)\>\>

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `transactions` | [`P2TRWatchtowerConfirmedTransaction`](../README.md#p2trwatchtowerconfirmedtransaction)[] | `undefined` |
| `requireAuthenticatedPrevouts` | `boolean` | `false` |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerBatchResult`](../README.md#p2trsignaturefraudwatchtowerbatchresult)\<[`P2TRWatchtowerConfirmedTransaction`](../README.md#p2trwatchtowerconfirmedtransaction)\>\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:5926](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L5926)

___

### observeMempoolTransactionsSettled

▸ **observeMempoolTransactionsSettled**(`transactions`, `requireAuthenticatedPrevouts?`): `Promise`\<[`P2TRSignatureFraudWatchtowerBatchResult`](../README.md#p2trsignaturefraudwatchtowerbatchresult)\<[`P2TRWatchtowerMempoolTransaction`](../README.md#p2trwatchtowermempooltransaction)\>\>

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `transactions` | [`P2TRWatchtowerMempoolTransaction`](../README.md#p2trwatchtowermempooltransaction)[] | `undefined` |
| `requireAuthenticatedPrevouts` | `boolean` | `false` |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerBatchResult`](../README.md#p2trsignaturefraudwatchtowerbatchresult)\<[`P2TRWatchtowerMempoolTransaction`](../README.md#p2trwatchtowermempooltransaction)\>\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:5891](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L5891)

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

[src/services/maintenance/p2tr-signature-fraud.ts:6263](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6263)

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

[src/services/maintenance/p2tr-signature-fraud.ts:6369](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6369)

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

[src/services/maintenance/p2tr-signature-fraud.ts:6306](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6306)

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

[src/services/maintenance/p2tr-signature-fraud.ts:6611](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6611)

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

[src/services/maintenance/p2tr-signature-fraud.ts:6578](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6578)

___

### processConfirmedTransaction

▸ **processConfirmedTransaction**(`rawTransaction`, `bitcoinTxHash`, `bitcoinBlockHash`, `bitcoinBlockHeight`, `walletInputKeyBindings?`, `inputPrevouts?`, `canonicalBitcoinCandidateIdentity?`): `Promise`\<[`P2TRSignatureFraudWatchtowerSubmissionResult`](../README.md#p2trsignaturefraudwatchtowersubmissionresult)[]\>

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `rawTransaction` | [`BitcoinRawTx`](../interfaces/BitcoinRawTx.md) | `undefined` |
| `bitcoinTxHash` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> | `undefined` |
| `bitcoinBlockHash` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> | `undefined` |
| `bitcoinBlockHeight` | `number` | `undefined` |
| `walletInputKeyBindings` | [`P2TRWalletInputKeyBinding`](../README.md#p2trwalletinputkeybinding)[] | `[]` |
| `inputPrevouts?` | [`P2TRWalletInputObservationPrevout`](../README.md#p2trwalletinputobservationprevout)[] | `undefined` |
| `canonicalBitcoinCandidateIdentity?` | [`P2TRWatchtowerCanonicalBitcoinCandidateIdentity`](../README.md#p2trwatchtowercanonicalbitcoincandidateidentity) | `undefined` |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerSubmissionResult`](../README.md#p2trsignaturefraudwatchtowersubmissionresult)[]\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:5815](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L5815)

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

[src/services/maintenance/p2tr-signature-fraud.ts:5853](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L5853)

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

[src/services/maintenance/p2tr-signature-fraud.ts:5873](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L5873)

___

### processMempoolTransaction

▸ **processMempoolTransaction**(`rawTransaction`, `bitcoinTxHash`, `walletInputKeyBindings?`, `inputPrevouts?`): `Promise`\<[`P2TRSignatureFraudWatchtowerSubmissionResult`](../README.md#p2trsignaturefraudwatchtowersubmissionresult)[]\>

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `rawTransaction` | [`BitcoinRawTx`](../interfaces/BitcoinRawTx.md) | `undefined` |
| `bitcoinTxHash` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> | `undefined` |
| `walletInputKeyBindings` | [`P2TRWalletInputKeyBinding`](../README.md#p2trwalletinputkeybinding)[] | `[]` |
| `inputPrevouts?` | [`P2TRWalletInputObservationPrevout`](../README.md#p2trwalletinputobservationprevout)[] | `undefined` |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerSubmissionResult`](../README.md#p2trsignaturefraudwatchtowersubmissionresult)[]\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:5760](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L5760)

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

[src/services/maintenance/p2tr-signature-fraud.ts:5783](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L5783)

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

[src/services/maintenance/p2tr-signature-fraud.ts:5800](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L5800)

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

[src/services/maintenance/p2tr-signature-fraud.ts:6558](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6558)

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

[src/services/maintenance/p2tr-signature-fraud.ts:6192](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6192)

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

[src/services/maintenance/p2tr-signature-fraud.ts:6651](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6651)

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

[src/services/maintenance/p2tr-signature-fraud.ts:6399](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6399)

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

[src/services/maintenance/p2tr-signature-fraud.ts:6020](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6020)

___

### reconcileCanonicalSourceOrphans

▸ **reconcileCanonicalSourceOrphans**(`transactionSource`, `result`, `records`): `Promise`\<`PromiseSettledResult`\<[`P2TRWatchtowerConfirmedTransactionSourceResult`](../README.md#p2trwatchtowerconfirmedtransactionsourceresult)\>\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `transactionSource` | [`P2TRSignatureFraudWatchtowerTransactionSource`](../interfaces/P2TRSignatureFraudWatchtowerTransactionSource.md) |
| `result` | `PromiseSettledResult`\<[`P2TRWatchtowerConfirmedTransactionSourceResult`](../README.md#p2trwatchtowerconfirmedtransactionsourceresult)\> |
| `records` | [`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)[] |

#### Returns

`Promise`\<`PromiseSettledResult`\<[`P2TRWatchtowerConfirmedTransactionSourceResult`](../README.md#p2trwatchtowerconfirmedtransactionsourceresult)\>\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:6121](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6121)

___

### registerCanonicalSourceWalletIDs

▸ **registerCanonicalSourceWalletIDs**(`transactionSource`, `result`): `PromiseSettledResult`\<[`P2TRWatchtowerConfirmedTransactionSourceResult`](../README.md#p2trwatchtowerconfirmedtransactionsourceresult)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `transactionSource` | [`P2TRSignatureFraudWatchtowerTransactionSource`](../interfaces/P2TRSignatureFraudWatchtowerTransactionSource.md) |
| `result` | `PromiseSettledResult`\<[`P2TRWatchtowerConfirmedTransactionSourceResult`](../README.md#p2trwatchtowerconfirmedtransactionsourceresult)\> |

#### Returns

`PromiseSettledResult`\<[`P2TRWatchtowerConfirmedTransactionSourceResult`](../README.md#p2trwatchtowerconfirmedtransactionsourceresult)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:6087](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6087)

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

[src/services/maintenance/p2tr-signature-fraud.ts:6011](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6011)

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

[src/services/maintenance/p2tr-signature-fraud.ts:5979](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L5979)

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

[src/services/maintenance/p2tr-signature-fraud.ts:5985](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L5985)

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

[src/services/maintenance/p2tr-signature-fraud.ts:6507](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6507)

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

[src/services/maintenance/p2tr-signature-fraud.ts:6633](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6633)
