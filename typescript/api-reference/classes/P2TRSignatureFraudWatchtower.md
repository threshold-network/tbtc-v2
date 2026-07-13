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

[src/services/maintenance/p2tr-signature-fraud.ts:3231](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3231)

## Properties

### bridgeChallengeDomain

• `Private` `Optional` `Readonly` **bridgeChallengeDomain**: [`P2TRSignatureFraudBridgeChallengeDomain`](../README.md#p2trsignaturefraudbridgechallengedomain)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3237](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3237)

___

### bridgeIdentifier

• `Private` `Optional` `Readonly` **bridgeIdentifier**: `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3234](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3234)

___

### payloadBounds

• `Private` `Optional` `Readonly` **payloadBounds**: [`P2TRSignatureFraudPayloadBounds`](../README.md#p2trsignaturefraudpayloadbounds)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3236](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3236)

___

### registeredWalletIDs

• `Private` `Readonly` **registeredWalletIDs**: [`Hex`](Hex.md)[]

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3229](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3229)

___

### spendTypeClassifier

• `Private` `Optional` `Readonly` **spendTypeClassifier**: [`P2TRSignatureFraudSpendTypeClassifier`](../README.md#p2trsignaturefraudspendtypeclassifier)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3235](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3235)

___

### store

• `Private` `Readonly` **store**: [`P2TRWatchtowerChallengeStore`](../interfaces/P2TRWatchtowerChallengeStore.md)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:3232](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3232)

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

[src/services/maintenance/p2tr-signature-fraud.ts:3429](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3429)

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

[src/services/maintenance/p2tr-signature-fraud.ts:3440](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3440)

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

[src/services/maintenance/p2tr-signature-fraud.ts:3358](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3358)

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

[src/services/maintenance/p2tr-signature-fraud.ts:3369](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3369)

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

[src/services/maintenance/p2tr-signature-fraud.ts:3405](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3405)

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

[src/services/maintenance/p2tr-signature-fraud.ts:3394](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3394)

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

[src/services/maintenance/p2tr-signature-fraud.ts:3385](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3385)

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

[src/services/maintenance/p2tr-signature-fraud.ts:3349](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3349)

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

[src/services/maintenance/p2tr-signature-fraud.ts:3340](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3340)

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

[src/services/maintenance/p2tr-signature-fraud.ts:3288](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3288)

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

[src/services/maintenance/p2tr-signature-fraud.ts:3322](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3322)

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

[src/services/maintenance/p2tr-signature-fraud.ts:3244](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3244)

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

[src/services/maintenance/p2tr-signature-fraud.ts:3274](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3274)

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

[src/services/maintenance/p2tr-signature-fraud.ts:3416](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3416)

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

[src/services/maintenance/p2tr-signature-fraud.ts:3449](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3449)
