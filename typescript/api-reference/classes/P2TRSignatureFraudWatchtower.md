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

[tbtc-v2-m993/typescript/src/services/maintenance/p2tr-signature-fraud.ts:3106](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3106)

## Properties

### bridgeChallengeDomain

• `Private` `Optional` `Readonly` **bridgeChallengeDomain**: [`P2TRSignatureFraudBridgeChallengeDomain`](../README.md#p2trsignaturefraudbridgechallengedomain)

#### Defined in

[tbtc-v2-m993/typescript/src/services/maintenance/p2tr-signature-fraud.ts:3112](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3112)

___

### bridgeIdentifier

• `Private` `Optional` `Readonly` **bridgeIdentifier**: `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\>

#### Defined in

[tbtc-v2-m993/typescript/src/services/maintenance/p2tr-signature-fraud.ts:3109](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3109)

___

### payloadBounds

• `Private` `Optional` `Readonly` **payloadBounds**: [`P2TRSignatureFraudPayloadBounds`](../README.md#p2trsignaturefraudpayloadbounds)

#### Defined in

[tbtc-v2-m993/typescript/src/services/maintenance/p2tr-signature-fraud.ts:3111](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3111)

___

### registeredWalletIDs

• `Private` `Readonly` **registeredWalletIDs**: [`Hex`](Hex.md)[]

#### Defined in

[tbtc-v2-m993/typescript/src/services/maintenance/p2tr-signature-fraud.ts:3104](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3104)

___

### spendTypeClassifier

• `Private` `Optional` `Readonly` **spendTypeClassifier**: [`P2TRSignatureFraudSpendTypeClassifier`](../README.md#p2trsignaturefraudspendtypeclassifier)

#### Defined in

[tbtc-v2-m993/typescript/src/services/maintenance/p2tr-signature-fraud.ts:3110](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3110)

___

### store

• `Private` `Readonly` **store**: [`P2TRWatchtowerChallengeStore`](../interfaces/P2TRWatchtowerChallengeStore.md)

#### Defined in

[tbtc-v2-m993/typescript/src/services/maintenance/p2tr-signature-fraud.ts:3107](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3107)

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

[tbtc-v2-m993/typescript/src/services/maintenance/p2tr-signature-fraud.ts:3296](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3296)

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

[tbtc-v2-m993/typescript/src/services/maintenance/p2tr-signature-fraud.ts:3307](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3307)

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

[tbtc-v2-m993/typescript/src/services/maintenance/p2tr-signature-fraud.ts:3225](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3225)

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

[tbtc-v2-m993/typescript/src/services/maintenance/p2tr-signature-fraud.ts:3236](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3236)

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

[tbtc-v2-m993/typescript/src/services/maintenance/p2tr-signature-fraud.ts:3272](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3272)

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

[tbtc-v2-m993/typescript/src/services/maintenance/p2tr-signature-fraud.ts:3261](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3261)

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

[tbtc-v2-m993/typescript/src/services/maintenance/p2tr-signature-fraud.ts:3252](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3252)

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

[tbtc-v2-m993/typescript/src/services/maintenance/p2tr-signature-fraud.ts:3216](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3216)

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

[tbtc-v2-m993/typescript/src/services/maintenance/p2tr-signature-fraud.ts:3207](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3207)

___

### observeConfirmedTransaction

▸ **observeConfirmedTransaction**(`rawTransaction`, `inputPrevouts`, `bitcoinTxHash`, `bitcoinBlockHash`, `bitcoinBlockHeight`): `Promise`\<[`P2TRSignatureFraudWatchtowerObservationResult`](../README.md#p2trsignaturefraudwatchtowerobservationresult)[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `rawTransaction` | [`BitcoinRawTx`](../interfaces/BitcoinRawTx.md) |
| `inputPrevouts` | [`P2TRWalletInputObservationPrevout`](../README.md#p2trwalletinputobservationprevout)[] |
| `bitcoinTxHash` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> |
| `bitcoinBlockHash` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> |
| `bitcoinBlockHeight` | `number` |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerObservationResult`](../README.md#p2trsignaturefraudwatchtowerobservationresult)[]\>

#### Defined in

[tbtc-v2-m993/typescript/src/services/maintenance/p2tr-signature-fraud.ts:3159](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3159)

___

### observeConfirmedTransactionWithResolvedPrevouts

▸ **observeConfirmedTransactionWithResolvedPrevouts**(`rawTransaction`, `bitcoinClient`, `bitcoinTxHash`, `bitcoinBlockHash`, `bitcoinBlockHeight`): `Promise`\<[`P2TRSignatureFraudWatchtowerObservationResult`](../README.md#p2trsignaturefraudwatchtowerobservationresult)[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `rawTransaction` | [`BitcoinRawTx`](../interfaces/BitcoinRawTx.md) |
| `bitcoinClient` | [`BitcoinClient`](../interfaces/BitcoinClient.md) |
| `bitcoinTxHash` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> |
| `bitcoinBlockHash` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> |
| `bitcoinBlockHeight` | `number` |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerObservationResult`](../README.md#p2trsignaturefraudwatchtowerobservationresult)[]\>

#### Defined in

[tbtc-v2-m993/typescript/src/services/maintenance/p2tr-signature-fraud.ts:3191](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3191)

___

### observeMempoolTransaction

▸ **observeMempoolTransaction**(`rawTransaction`, `inputPrevouts`, `bitcoinTxHash`): `Promise`\<[`P2TRSignatureFraudWatchtowerObservationResult`](../README.md#p2trsignaturefraudwatchtowerobservationresult)[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `rawTransaction` | [`BitcoinRawTx`](../interfaces/BitcoinRawTx.md) |
| `inputPrevouts` | [`P2TRWalletInputObservationPrevout`](../README.md#p2trwalletinputobservationprevout)[] |
| `bitcoinTxHash` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerObservationResult`](../README.md#p2trsignaturefraudwatchtowerobservationresult)[]\>

#### Defined in

[tbtc-v2-m993/typescript/src/services/maintenance/p2tr-signature-fraud.ts:3119](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3119)

___

### observeMempoolTransactionWithResolvedPrevouts

▸ **observeMempoolTransactionWithResolvedPrevouts**(`rawTransaction`, `bitcoinClient`, `bitcoinTxHash`): `Promise`\<[`P2TRSignatureFraudWatchtowerObservationResult`](../README.md#p2trsignaturefraudwatchtowerobservationresult)[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `rawTransaction` | [`BitcoinRawTx`](../interfaces/BitcoinRawTx.md) |
| `bitcoinClient` | [`BitcoinClient`](../interfaces/BitcoinClient.md) |
| `bitcoinTxHash` | `string` \| [`Hex`](Hex.md) \| `Buffer`\<`ArrayBufferLike`\> |

#### Returns

`Promise`\<[`P2TRSignatureFraudWatchtowerObservationResult`](../README.md#p2trsignaturefraudwatchtowerobservationresult)[]\>

#### Defined in

[tbtc-v2-m993/typescript/src/services/maintenance/p2tr-signature-fraud.ts:3147](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3147)

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

[tbtc-v2-m993/typescript/src/services/maintenance/p2tr-signature-fraud.ts:3283](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3283)

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

[tbtc-v2-m993/typescript/src/services/maintenance/p2tr-signature-fraud.ts:3316](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L3316)
