# Class: P2TRSignatureFraudWatchtower

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

[src/services/maintenance/p2tr-signature-fraud.ts:3286](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3286)

## Properties

### bridgeChallengeDomain

• `Private` `Optional` `Readonly` **bridgeChallengeDomain**: [`P2TRSignatureFraudBridgeChallengeDomain`](../README.md#p2trsignaturefraudbridgechallengedomain)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3292](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3292)

___

### bridgeIdentifier

• `Private` `Optional` `Readonly` **bridgeIdentifier**: `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3289](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3289)

___

### payloadBounds

• `Private` `Optional` `Readonly` **payloadBounds**: [`P2TRSignatureFraudPayloadBounds`](../README.md#p2trsignaturefraudpayloadbounds)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3291](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3291)

___

### registeredWalletIDs

• `Private` `Readonly` **registeredWalletIDs**: [`Hex`](Hex.md)[]

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3284](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3284)

___

### spendTypeClassifier

• `Private` `Optional` `Readonly` **spendTypeClassifier**: [`P2TRSignatureFraudSpendTypeClassifier`](../README.md#p2trsignaturefraudspendtypeclassifier)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3290](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3290)

___

### store

• `Private` `Readonly` **store**: [`P2TRWatchtowerChallengeStore`](../interfaces/P2TRWatchtowerChallengeStore.md)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3287](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3287)

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

[src/services/maintenance/p2tr-signature-fraud.ts:3484](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3484)

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

[src/services/maintenance/p2tr-signature-fraud.ts:3495](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3495)

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

[src/services/maintenance/p2tr-signature-fraud.ts:3413](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3413)

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

[src/services/maintenance/p2tr-signature-fraud.ts:3424](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3424)

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

[src/services/maintenance/p2tr-signature-fraud.ts:3460](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3460)

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

[src/services/maintenance/p2tr-signature-fraud.ts:3449](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3449)

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

[src/services/maintenance/p2tr-signature-fraud.ts:3440](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3440)

___

### markConfirmedTransactionReorged

▸ **markConfirmedTransactionReorged**(`observationID`): `Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `observationID` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> |

#### Returns

`Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3404](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3404)

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

[src/services/maintenance/p2tr-signature-fraud.ts:3395](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3395)

___

### observeConfirmedTransaction

▸ **observeConfirmedTransaction**(`rawTransaction`, `inputPrevouts`, `bitcoinTxHash`, `bitcoinBlockHash`, `bitcoinBlockHeight`, `walletInputKeyBindings?`): `Promise`\<[`P2TRSignatureFraudWatchtowerObservationResult`](../README.md#p2trsignaturefraudwatchtowerobservationresult)[]\>

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `rawTransaction` | [`BitcoinRawTx`](../interfaces/BitcoinRawTx.md) | `undefined` |
| `inputPrevouts` | [`P2TRWalletInputObservationPrevout`](../README.md#p2trwalletinputobservationprevout)[] | `undefined` |
| `bitcoinTxHash` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> | `undefined` |
| `bitcoinBlockHash` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> | `undefined` |
| `bitcoinBlockHeight` | `number` | `undefined` |
| `walletInputKeyBindings` | [`P2TRWalletInputKeyBinding`](../README.md#p2trwalletinputkeybinding)[] | `[]` |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerObservationResult`](../README.md#p2trsignaturefraudwatchtowerobservationresult)[]\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3343](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3343)

___

### observeConfirmedTransactionWithResolvedPrevouts

▸ **observeConfirmedTransactionWithResolvedPrevouts**(`rawTransaction`, `bitcoinClient`, `bitcoinTxHash`, `bitcoinBlockHash`, `bitcoinBlockHeight`, `walletInputKeyBindings?`): `Promise`\<[`P2TRSignatureFraudWatchtowerObservationResult`](../README.md#p2trsignaturefraudwatchtowerobservationresult)[]\>

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `rawTransaction` | [`BitcoinRawTx`](../interfaces/BitcoinRawTx.md) | `undefined` |
| `bitcoinClient` | [`BitcoinClient`](../interfaces/BitcoinClient.md) | `undefined` |
| `bitcoinTxHash` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> | `undefined` |
| `bitcoinBlockHash` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> | `undefined` |
| `bitcoinBlockHeight` | `number` | `undefined` |
| `walletInputKeyBindings` | [`P2TRWalletInputKeyBinding`](../README.md#p2trwalletinputkeybinding)[] | `[]` |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerObservationResult`](../README.md#p2trsignaturefraudwatchtowerobservationresult)[]\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3377](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3377)

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

[src/services/maintenance/p2tr-signature-fraud.ts:3299](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3299)

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

[src/services/maintenance/p2tr-signature-fraud.ts:3329](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3329)

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

[src/services/maintenance/p2tr-signature-fraud.ts:3471](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3471)

___

### submitChallenge

▸ **submitChallenge**(`observation`, `submitter`, `submissionPolicy?`): `Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `observation` | [`P2TRSignatureFraudWitnessObservation`](../README.md#p2trsignaturefraudwitnessobservation) |
| `submitter` | [`P2TRSignatureFraudChallengeSubmitter`](../interfaces/P2TRSignatureFraudChallengeSubmitter.md) |
| `submissionPolicy` | [`P2TRSignatureFraudChallengeSubmissionPolicy`](../README.md#p2trsignaturefraudchallengesubmissionpolicy) |

#### Returns

`Promise`\<[`P2TRWatchtowerChallengeRecord`](../README.md#p2trwatchtowerchallengerecord)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3504](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3504)
