# Class: P2TRSignatureFraudBridgeChallengeSubmitter

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
| `bridge` | [`P2TRSignatureFraudBridgeChallengeContract`](../interfaces/P2TRSignatureFraudBridgeChallengeContract.md) | - |
| `options` | [`P2TRSignatureFraudBridgeChallengeSubmitterOptions`](../README.md#p2trsignaturefraudbridgechallengesubmitteroptions) | Submitter options. If `challengeDepositAmount` is omitted the submitter will call `contract.fraudParameters()` to look it up; consumers should ensure the supplied contract exposes that view or supply the deposit amount explicitly. |

#### Returns

[`P2TRSignatureFraudBridgeChallengeSubmitter`](P2TRSignatureFraudBridgeChallengeSubmitter.md)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:2802](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L2802)

## Properties

### bridge

• `Private` `Readonly` **bridge**: [`P2TRSignatureFraudBridgeChallengeContract`](../interfaces/P2TRSignatureFraudBridgeChallengeContract.md)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:2803](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L2803)

___

### confirmations

• `Private` `Readonly` **confirmations**: `number`

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:2788](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L2788)

___

### options

• `Private` `Readonly` **options**: [`P2TRSignatureFraudBridgeChallengeSubmitterOptions`](../README.md#p2trsignaturefraudbridgechallengesubmitteroptions) = `{}`

Submitter options. If `challengeDepositAmount` is
       omitted the submitter will call `contract.fraudParameters()`
       to look it up; consumers should ensure the supplied
       contract exposes that view or supply the deposit
       amount explicitly.

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:2804](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L2804)

## Methods

### challengeDepositAmount

▸ **challengeDepositAmount**(): `Promise`\<`BigNumberish`\>

#### Returns

`Promise`\<`BigNumberish`\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:2855](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L2855)

___

### submitSignatureFraudChallenge

▸ **submitSignatureFraudChallenge**(`observation`): `Promise`\<`string`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `observation` | [`P2TRSignatureFraudWitnessObservation`](../README.md#p2trsignaturefraudwitnessobservation) |

#### Returns

`Promise`\<`string`\>

#### Implementation of

[P2TRSignatureFraudChallengeSubmitter](../interfaces/P2TRSignatureFraudChallengeSubmitter.md).[submitSignatureFraudChallenge](../interfaces/P2TRSignatureFraudChallengeSubmitter.md#submitsignaturefraudchallenge)

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:2819](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L2819)
