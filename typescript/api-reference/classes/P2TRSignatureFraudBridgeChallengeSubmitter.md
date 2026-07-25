# Class: P2TRSignatureFraudBridgeChallengeSubmitter

Manual low-level Router adapter for explicitly submitted fraud challenges.

This class is not an automatic production watchtower path and does not
activate the bounded/no-go FROST fraud layer. Callers remain responsible for
a separately reviewed `COMPLETE_V2` protocol and operational controls.

## Implements

- [`P2TRSignatureFraudChallengeSubmitter`](../interfaces/P2TRSignatureFraudChallengeSubmitter.md)

## Table of contents

### Constructors

- [constructor](P2TRSignatureFraudBridgeChallengeSubmitter.md#constructor)

### Properties

- [bridge](P2TRSignatureFraudBridgeChallengeSubmitter.md#bridge)
- [confirmations](P2TRSignatureFraudBridgeChallengeSubmitter.md#confirmations)
- [options](P2TRSignatureFraudBridgeChallengeSubmitter.md#options)

### Methods

- [challengeDepositAmount](P2TRSignatureFraudBridgeChallengeSubmitter.md#challengedepositamount)
- [submitSignatureFraudChallenge](P2TRSignatureFraudBridgeChallengeSubmitter.md#submitsignaturefraudchallenge)

## Constructors

### constructor

• **new P2TRSignatureFraudBridgeChallengeSubmitter**(`bridge`, `options?`): [`P2TRSignatureFraudBridgeChallengeSubmitter`](P2TRSignatureFraudBridgeChallengeSubmitter.md)

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `bridge` | [`P2TRSignatureFraudBridgeChallengeContract`](../interfaces/P2TRSignatureFraudBridgeChallengeContract.md) | The P2TR signature-fraud entry-point contract. Post-extraction this is the `P2TRSignatureFraudRouter` sidecar (NOT the Bridge contract). See `P2TRSignatureFraudBridgeChallengeContract` doc for the full naming-vs-semantics caveat. |
| `options` | [`P2TRSignatureFraudBridgeChallengeSubmitterOptions`](../README.md#p2trsignaturefraudbridgechallengesubmitteroptions) | Submitter options. If `challengeDepositAmount` is omitted the submitter will call `contract.fraudParameters()` to look it up; consumers should ensure the supplied contract exposes that view or supply the deposit amount explicitly. |

#### Returns

[`P2TRSignatureFraudBridgeChallengeSubmitter`](P2TRSignatureFraudBridgeChallengeSubmitter.md)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:5163](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L5163)

## Properties

### bridge

• `Private` `Readonly` **bridge**: [`P2TRSignatureFraudBridgeChallengeContract`](../interfaces/P2TRSignatureFraudBridgeChallengeContract.md)

The P2TR signature-fraud entry-point contract.
       Post-extraction this is the `P2TRSignatureFraudRouter`
       sidecar (NOT the Bridge contract). See
       `P2TRSignatureFraudBridgeChallengeContract` doc for the
       full naming-vs-semantics caveat.

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:5164](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L5164)

___

### confirmations

• `Private` `Readonly` **confirmations**: `number`

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:5149](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L5149)

___

### options

• `Private` `Readonly` **options**: [`P2TRSignatureFraudBridgeChallengeSubmitterOptions`](../README.md#p2trsignaturefraudbridgechallengesubmitteroptions) = `{}`

Submitter options. If `challengeDepositAmount` is
       omitted the submitter will call `contract.fraudParameters()`
       to look it up; consumers should ensure the supplied
       contract exposes that view or supply the deposit
       amount explicitly.

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:5165](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L5165)

## Methods

### challengeDepositAmount

▸ **challengeDepositAmount**(): `Promise`\<`BigNumberish`\>

#### Returns

`Promise`\<`BigNumberish`\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:5225](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L5225)

___

### submitSignatureFraudChallenge

▸ **submitSignatureFraudChallenge**(`observation`, `options?`): `Promise`\<`string`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `observation` | [`P2TRSignatureFraudWitnessObservation`](../README.md#p2trsignaturefraudwitnessobservation) |
| `options?` | [`P2TRSignatureFraudChallengeSubmissionOptions`](../interfaces/P2TRSignatureFraudChallengeSubmissionOptions.md) |

#### Returns

`Promise`\<`string`\>

#### Implementation of

[P2TRSignatureFraudChallengeSubmitter](../interfaces/P2TRSignatureFraudChallengeSubmitter.md).[submitSignatureFraudChallenge](../interfaces/P2TRSignatureFraudChallengeSubmitter.md#submitsignaturefraudchallenge)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:5180](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L5180)
