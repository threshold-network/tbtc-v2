# Class: P2TRSignatureFraudWatchtower

Observation-only P2TR fraud evidence index and lifecycle store.

Automatic challenge submission is hard-disabled while the FROST fraud layer
is bounded/no-go. Observation and manual lifecycle reconciliation remain
available without activating the incomplete fraud protocol.

## Table of contents

### Constructors

- [constructor](P2TRSignatureFraudWatchtower.md#constructor)

### Properties

- [bridgeChallengeDomain](P2TRSignatureFraudWatchtower.md#bridgechallengedomain)
- [bridgeIdentifier](P2TRSignatureFraudWatchtower.md#bridgeidentifier)
- [payloadBounds](P2TRSignatureFraudWatchtower.md#payloadbounds)
- [registeredWalletIDs](P2TRSignatureFraudWatchtower.md#registeredwalletids)
- [spendTypeClassifier](P2TRSignatureFraudWatchtower.md#spendtypeclassifier)
- [store](P2TRSignatureFraudWatchtower.md#store)

### Methods

- [acknowledgeChallengeOperatorAlert](P2TRSignatureFraudWatchtower.md#acknowledgechallengeoperatoralert)
- [clearChallengeOperatorAlert](P2TRSignatureFraudWatchtower.md#clearchallengeoperatoralert)
- [markChallengeDefeated](P2TRSignatureFraudWatchtower.md#markchallengedefeated)
- [markChallengeHonestSpendProven](P2TRSignatureFraudWatchtower.md#markchallengehonestspendproven)
- [markChallengeRewarded](P2TRSignatureFraudWatchtower.md#markchallengerewarded)
- [markChallengeSlashed](P2TRSignatureFraudWatchtower.md#markchallengeslashed)
- [markChallengeTimeoutEligible](P2TRSignatureFraudWatchtower.md#markchallengetimeouteligible)
- [markConfirmedTransactionReorged](P2TRSignatureFraudWatchtower.md#markconfirmedtransactionreorged)
- [markMempoolTransactionEvicted](P2TRSignatureFraudWatchtower.md#markmempooltransactionevicted)
- [observeConfirmedTransaction](P2TRSignatureFraudWatchtower.md#observeconfirmedtransaction)
- [observeConfirmedTransactionWithResolvedPrevouts](P2TRSignatureFraudWatchtower.md#observeconfirmedtransactionwithresolvedprevouts)
- [observeMempoolTransaction](P2TRSignatureFraudWatchtower.md#observemempooltransaction)
- [observeMempoolTransactionWithResolvedPrevouts](P2TRSignatureFraudWatchtower.md#observemempooltransactionwithresolvedprevouts)
- [raiseChallengeOperatorAlert](P2TRSignatureFraudWatchtower.md#raisechallengeoperatoralert)
- [reconcileChallengeBroadcast](P2TRSignatureFraudWatchtower.md#reconcilechallengebroadcast)
- [replaceRegisteredWalletIDs](P2TRSignatureFraudWatchtower.md#replaceregisteredwalletids)
- [submitChallenge](P2TRSignatureFraudWatchtower.md#submitchallenge)

## Constructors

### constructor

• **new P2TRSignatureFraudWatchtower**(`store`, `registeredWalletIDs`, `bridgeIdentifier?`, `spendTypeClassifier?`, `payloadBounds?`, `bridgeChallengeDomain?`): [`P2TRSignatureFraudWatchtower`](P2TRSignatureFraudWatchtower.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `store` | [`P2TRWatchtowerChallengeStore`](../interfaces/P2TRWatchtowerChallengeStore.md) |
| `registeredWalletIDs` | (`string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\>)[] |
| `bridgeIdentifier?` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> |
| `spendTypeClassifier?` | [`P2TRSignatureFraudSpendTypeClassifier`](../README.md#p2trsignaturefraudspendtypeclassifier) |
| `payloadBounds?` | [`P2TRSignatureFraudPayloadBounds`](../README.md#p2trsignaturefraudpayloadbounds) |
| `bridgeChallengeDomain?` | [`P2TRSignatureFraudBridgeChallengeDomain`](../README.md#p2trsignaturefraudbridgechallengedomain) |

#### Returns

[`P2TRSignatureFraudWatchtower`](P2TRSignatureFraudWatchtower.md)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:6190](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6190)

## Properties

### bridgeChallengeDomain

• `Private` `Optional` `Readonly` **bridgeChallengeDomain**: [`P2TRSignatureFraudBridgeChallengeDomain`](../README.md#p2trsignaturefraudbridgechallengedomain)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:6196](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6196)

___

### bridgeIdentifier

• `Private` `Optional` `Readonly` **bridgeIdentifier**: `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:6193](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6193)

___

### payloadBounds

• `Private` `Optional` `Readonly` **payloadBounds**: [`P2TRSignatureFraudPayloadBounds`](../README.md#p2trsignaturefraudpayloadbounds)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:6195](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6195)

___

### registeredWalletIDs

• `Private` **registeredWalletIDs**: `Set`\<`string`\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:6188](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6188)

___

### spendTypeClassifier

• `Private` `Optional` `Readonly` **spendTypeClassifier**: [`P2TRSignatureFraudSpendTypeClassifier`](../README.md#p2trsignaturefraudspendtypeclassifier)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:6194](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6194)

___

### store

• `Private` `Readonly` **store**: [`P2TRWatchtowerChallengeStore`](../interfaces/P2TRWatchtowerChallengeStore.md)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:6191](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6191)

## Methods

### acknowledgeChallengeOperatorAlert

▸ **acknowledgeChallengeOperatorAlert**(`observationID`, `acknowledgedBy`): `Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `observationID` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> |
| `acknowledgedBy` | `string` |

#### Returns

`Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:6416](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6416)

___

### clearChallengeOperatorAlert

▸ **clearChallengeOperatorAlert**(`observationID`): `Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `observationID` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> |

#### Returns

`Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:6427](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6427)

___

### markChallengeDefeated

▸ **markChallengeDefeated**(`observationID`, `defeatTxHash`): `Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `observationID` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> |
| `defeatTxHash` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> |

#### Returns

`Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:6333](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6333)

___

### markChallengeHonestSpendProven

▸ **markChallengeHonestSpendProven**(`observationID`, `bitcoinTxHash?`): `Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `observationID` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> |
| `bitcoinTxHash?` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> |

#### Returns

`Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:6344](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6344)

___

### markChallengeRewarded

▸ **markChallengeRewarded**(`observationID`, `rewardTxHash`): `Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `observationID` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> |
| `rewardTxHash` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> |

#### Returns

`Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:6380](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6380)

___

### markChallengeSlashed

▸ **markChallengeSlashed**(`observationID`, `slashingTxHash`): `Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `observationID` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> |
| `slashingTxHash` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> |

#### Returns

`Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:6369](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6369)

___

### markChallengeTimeoutEligible

▸ **markChallengeTimeoutEligible**(`observationID`): `Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `observationID` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> |

#### Returns

`Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:6360](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6360)

___

### markConfirmedTransactionReorged

▸ **markConfirmedTransactionReorged**(`observationID`, `expectedCanonicalIdentity?`): `Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `observationID` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> |
| `expectedCanonicalIdentity?` | [`P2TRWatchtowerCanonicalBitcoinCandidateIdentity`](../README.md#p2trwatchtowercanonicalbitcoincandidateidentity) |

#### Returns

`Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:6322](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6322)

___

### markMempoolTransactionEvicted

▸ **markMempoolTransactionEvicted**(`observationID`): `Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `observationID` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> |

#### Returns

`Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:6313](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6313)

___

### observeConfirmedTransaction

▸ **observeConfirmedTransaction**(`rawTransaction`, `inputPrevouts`, `bitcoinTxHash`, `bitcoinBlockHash`, `bitcoinBlockHeight`, `walletInputKeyBindings?`, `bitcoinWtxid?`): `Promise`\<[`P2TRSignatureFraudWatchtowerObservationResult`](../README.md#p2trsignaturefraudwatchtowerobservationresult)[]\>

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `rawTransaction` | [`BitcoinRawTx`](../interfaces/BitcoinRawTx.md) | `undefined` |
| `inputPrevouts` | [`P2TRWalletInputObservationPrevout`](../README.md#p2trwalletinputobservationprevout)[] | `undefined` |
| `bitcoinTxHash` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> | `undefined` |
| `bitcoinBlockHash` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> | `undefined` |
| `bitcoinBlockHeight` | `number` | `undefined` |
| `walletInputKeyBindings` | [`P2TRWalletInputKeyBinding`](../README.md#p2trwalletinputkeybinding)[] | `[]` |
| `bitcoinWtxid?` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> | `undefined` |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerObservationResult`](../README.md#p2trsignaturefraudwatchtowerobservationresult)[]\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:6257](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6257)

___

### observeConfirmedTransactionWithResolvedPrevouts

▸ **observeConfirmedTransactionWithResolvedPrevouts**(`rawTransaction`, `bitcoinClient`, `bitcoinTxHash`, `bitcoinBlockHash`, `bitcoinBlockHeight`, `walletInputKeyBindings?`, `bitcoinWtxid?`): `Promise`\<[`P2TRSignatureFraudWatchtowerObservationResult`](../README.md#p2trsignaturefraudwatchtowerobservationresult)[]\>

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `rawTransaction` | [`BitcoinRawTx`](../interfaces/BitcoinRawTx.md) | `undefined` |
| `bitcoinClient` | [`BitcoinClient`](../interfaces/BitcoinClient.md) | `undefined` |
| `bitcoinTxHash` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> | `undefined` |
| `bitcoinBlockHash` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> | `undefined` |
| `bitcoinBlockHeight` | `number` | `undefined` |
| `walletInputKeyBindings` | [`P2TRWalletInputKeyBinding`](../README.md#p2trwalletinputkeybinding)[] | `[]` |
| `bitcoinWtxid?` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> | `undefined` |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerObservationResult`](../README.md#p2trsignaturefraudwatchtowerobservationresult)[]\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:6293](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6293)

___

### observeMempoolTransaction

▸ **observeMempoolTransaction**(`rawTransaction`, `inputPrevouts`, `bitcoinTxHash`, `walletInputKeyBindings?`): `Promise`\<[`P2TRSignatureFraudWatchtowerObservationResult`](../README.md#p2trsignaturefraudwatchtowerobservationresult)[]\>

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `rawTransaction` | [`BitcoinRawTx`](../interfaces/BitcoinRawTx.md) | `undefined` |
| `inputPrevouts` | [`P2TRWalletInputObservationPrevout`](../README.md#p2trwalletinputobservationprevout)[] | `undefined` |
| `bitcoinTxHash` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> | `undefined` |
| `walletInputKeyBindings` | [`P2TRWalletInputKeyBinding`](../README.md#p2trwalletinputkeybinding)[] | `[]` |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerObservationResult`](../README.md#p2trsignaturefraudwatchtowerobservationresult)[]\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:6213](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6213)

___

### observeMempoolTransactionWithResolvedPrevouts

▸ **observeMempoolTransactionWithResolvedPrevouts**(`rawTransaction`, `bitcoinClient`, `bitcoinTxHash`, `walletInputKeyBindings?`): `Promise`\<[`P2TRSignatureFraudWatchtowerObservationResult`](../README.md#p2trsignaturefraudwatchtowerobservationresult)[]\>

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `rawTransaction` | [`BitcoinRawTx`](../interfaces/BitcoinRawTx.md) | `undefined` |
| `bitcoinClient` | [`BitcoinClient`](../interfaces/BitcoinClient.md) | `undefined` |
| `bitcoinTxHash` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> | `undefined` |
| `walletInputKeyBindings` | [`P2TRWalletInputKeyBinding`](../README.md#p2trwalletinputkeybinding)[] | `[]` |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerObservationResult`](../README.md#p2trsignaturefraudwatchtowerobservationresult)[]\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:6243](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6243)

___

### raiseChallengeOperatorAlert

▸ **raiseChallengeOperatorAlert**(`observationID`, `code`, `message`): `Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `observationID` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> |
| `code` | `string` |
| `message` | `string` |

#### Returns

`Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:6403](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6403)

___

### reconcileChallengeBroadcast

▸ **reconcileChallengeBroadcast**(`observationID`, `resolution`): `Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `observationID` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> |
| `resolution` | [`P2TRSignatureFraudChallengeBroadcastResolution`](../README.md#p2trsignaturefraudchallengebroadcastresolution) |

#### Returns

`Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:6391](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6391)

___

### replaceRegisteredWalletIDs

▸ **replaceRegisteredWalletIDs**(`walletIDs`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `walletIDs` | (`string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\>)[] |

#### Returns

`void`

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:6205](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6205)

___

### submitChallenge

▸ **submitChallenge**(`observation`, `submitter`, `submissionPolicy?`): `Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

Always rejects while automatic P2TR fraud submission is disabled.

A future activation requires a separately reviewed `COMPLETE_V2` evidence
protocol, durable broadcast outbox, and canonical independent
reconciliation design.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `observation` | [`P2TRSignatureFraudWitnessObservation`](../README.md#p2trsignaturefraudwitnessobservation) | Compatibility-only observed evidence; it is never submitted by this method. |
| `submitter` | [`P2TRSignatureFraudChallengeSubmitter`](../interfaces/P2TRSignatureFraudChallengeSubmitter.md) | Compatibility-only low-level submitter; it is never invoked by this method. |
| `submissionPolicy` | [`P2TRSignatureFraudChallengeSubmissionPolicy`](../README.md#p2trsignaturefraudchallengesubmissionpolicy) | Compatibility-only policy; it cannot enable submission. |

#### Returns

`Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

A rejected promise while the fraud layer remains bounded/no-go.

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:6450](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L6450)
