# Interface: P2TRSignatureFraudChallengeTransactionPreparer

## Table of contents

### Properties

- [laneID](P2TRSignatureFraudChallengeTransactionPreparer.md#laneid)
- [signerIdentity](P2TRSignatureFraudChallengeTransactionPreparer.md#signeridentity)
- [transactionSender](P2TRSignatureFraudChallengeTransactionPreparer.md#transactionsender)

### Methods

- [prepareSignatureFraudChallengeReplacementTransaction](P2TRSignatureFraudChallengeTransactionPreparer.md#preparesignaturefraudchallengereplacementtransaction)
- [prepareSignatureFraudChallengeTransaction](P2TRSignatureFraudChallengeTransactionPreparer.md#preparesignaturefraudchallengetransaction)
- [releaseSignatureFraudChallengeNonce](P2TRSignatureFraudChallengeTransactionPreparer.md#releasesignaturefraudchallengenonce)
- [reserveSignatureFraudChallengeNonce](P2TRSignatureFraudChallengeTransactionPreparer.md#reservesignaturefraudchallengenonce)

## Properties

### laneID

• `Readonly` **laneID**: `string`

Stable identities used for durable lane and signer quarantine records.

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:723](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L723)

___

### signerIdentity

• `Readonly` **signerIdentity**: `string`

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:724](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L724)

___

### transactionSender

• `Readonly` **transactionSender**: `string`

Sender whose nonce lane is serialized by the durable outbox store.

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:726](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L726)

## Methods

### prepareSignatureFraudChallengeReplacementTransaction

▸ **prepareSignatureFraudChallengeReplacementTransaction**(`intent`, `reservation`, `previous`, `feePolicy`, `invocation`): `Promise`\<[`P2TRSignatureFraudPreparedChallengeTransaction`](../README.md#p2trsignaturefraudpreparedchallengetransaction)\>

Signs an EIP-1559 replacement for the same durable intent, sender, and
nonce. The outbox persists the signer-invocation boundary before calling
this method and appends the returned raw bytes before any broadcast.

#### Parameters

| Name | Type |
| :------ | :------ |
| `intent` | [`P2TRSignatureFraudSubmissionIntent`](../README.md#p2trsignaturefraudsubmissionintent) |
| `reservation` | [`P2TRSignatureFraudBoundNonceReservation`](../README.md#p2trsignaturefraudboundnoncereservation) |
| `previous` | [`P2TRSignatureFraudPreparedChallengeTransaction`](../README.md#p2trsignaturefraudpreparedchallengetransaction) |
| `feePolicy` | [`P2TRSignatureFraudChallengeTransactionFeePolicy`](../README.md#p2trsignaturefraudchallengetransactionfeepolicy) |
| `invocation` | [`P2TRSignatureFraudSignerInvocationRequest`](../README.md#p2trsignaturefraudsignerinvocationrequest) |

#### Returns

`Promise`\<[`P2TRSignatureFraudPreparedChallengeTransaction`](../README.md#p2trsignaturefraudpreparedchallengetransaction)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:766](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L766)

___

### prepareSignatureFraudChallengeTransaction

▸ **prepareSignatureFraudChallengeTransaction**(`intent`, `reservation`, `feePolicy`, `invocation`): `Promise`\<[`P2TRSignatureFraudPreparedChallengeTransaction`](../README.md#p2trsignaturefraudpreparedchallengetransaction)\>

Prepares and signs, but MUST NOT broadcast, an Ethereum transaction for
the supplied intent and already-persisted reservation. Implementations
MUST reject a reservation whose binding, sender, or nonce is not exact.

#### Parameters

| Name | Type |
| :------ | :------ |
| `intent` | [`P2TRSignatureFraudSubmissionIntent`](../README.md#p2trsignaturefraudsubmissionintent) |
| `reservation` | [`P2TRSignatureFraudBoundNonceReservation`](../README.md#p2trsignaturefraudboundnoncereservation) |
| `feePolicy` | [`P2TRSignatureFraudChallengeTransactionFeePolicy`](../README.md#p2trsignaturefraudchallengetransactionfeepolicy) |
| `invocation` | [`P2TRSignatureFraudSignerInvocationRequest`](../README.md#p2trsignaturefraudsignerinvocationrequest) |

#### Returns

`Promise`\<[`P2TRSignatureFraudPreparedChallengeTransaction`](../README.md#p2trsignaturefraudpreparedchallengetransaction)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:754](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L754)

___

### releaseSignatureFraudChallengeNonce

▸ **releaseSignatureFraudChallengeNonce**(`reservation`, `releaseRequestID`): `Promise`\<[`P2TRSignatureFraudNonceReleaseAcknowledgement`](../README.md#p2trsignaturefraudnoncereleaseacknowledgement)\>

Releases a reservation only when no transaction signer was invoked.
The operation MUST be idempotent by `releaseRequestID`: a retry after an
ambiguous response returns `already-released` for the same reservation.

#### Parameters

| Name | Type |
| :------ | :------ |
| `reservation` | [`P2TRSignatureFraudBoundNonceReservation`](../README.md#p2trsignaturefraudboundnoncereservation) |
| `releaseRequestID` | [`Hex`](../classes/Hex.md) |

#### Returns

`Promise`\<[`P2TRSignatureFraudNonceReleaseAcknowledgement`](../README.md#p2trsignaturefraudnoncereleaseacknowledgement)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:744](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L744)

___

### reserveSignatureFraudChallengeNonce

▸ **reserveSignatureFraudChallengeNonce**(`intent`, `outboxRecordID`, `generation`, `reservationEpoch`): `Promise`\<[`P2TRSignatureFraudBoundNonceReservation`](../README.md#p2trsignaturefraudboundnoncereservation)\>

Allocates an idempotent nonce reservation without signing transaction
bytes. Its EIP-712 binding must recover to `transactionSender`.

#### Parameters

| Name | Type |
| :------ | :------ |
| `intent` | [`P2TRSignatureFraudSubmissionIntent`](../README.md#p2trsignaturefraudsubmissionintent) |
| `outboxRecordID` | [`Hex`](../classes/Hex.md) |
| `generation` | `number` |
| `reservationEpoch` | `number` |

#### Returns

`Promise`\<[`P2TRSignatureFraudBoundNonceReservation`](../README.md#p2trsignaturefraudboundnoncereservation)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:732](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L732)
