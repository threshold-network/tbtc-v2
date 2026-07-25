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

[src/services/maintenance/p2tr-signature-fraud.ts:688](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L688)

___

### signerIdentity

• `Readonly` **signerIdentity**: `string`

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:689](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L689)

___

### transactionSender

• `Readonly` **transactionSender**: `string`

Sender whose nonce lane is serialized by the durable outbox store.

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:691](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L691)

## Methods

### prepareSignatureFraudChallengeReplacementTransaction

▸ **prepareSignatureFraudChallengeReplacementTransaction**(`intent`, `reservation`, `previous`, `feePolicy`): `Promise`\<[`P2TRSignatureFraudPreparedChallengeTransaction`](../README.md#p2trsignaturefraudpreparedchallengetransaction)\>

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

#### Returns

`Promise`\<[`P2TRSignatureFraudPreparedChallengeTransaction`](../README.md#p2trsignaturefraudpreparedchallengetransaction)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:730](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L730)

___

### prepareSignatureFraudChallengeTransaction

▸ **prepareSignatureFraudChallengeTransaction**(`intent`, `reservation`, `feePolicy`): `Promise`\<[`P2TRSignatureFraudPreparedChallengeTransaction`](../README.md#p2trsignaturefraudpreparedchallengetransaction)\>

Prepares and signs, but MUST NOT broadcast, an Ethereum transaction for
the supplied intent and already-persisted reservation. Implementations
MUST reject a reservation whose binding, sender, or nonce is not exact.

#### Parameters

| Name | Type |
| :------ | :------ |
| `intent` | [`P2TRSignatureFraudSubmissionIntent`](../README.md#p2trsignaturefraudsubmissionintent) |
| `reservation` | [`P2TRSignatureFraudBoundNonceReservation`](../README.md#p2trsignaturefraudboundnoncereservation) |
| `feePolicy` | [`P2TRSignatureFraudChallengeTransactionFeePolicy`](../README.md#p2trsignaturefraudchallengetransactionfeepolicy) |

#### Returns

`Promise`\<[`P2TRSignatureFraudPreparedChallengeTransaction`](../README.md#p2trsignaturefraudpreparedchallengetransaction)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:719](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L719)

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

[src/services/maintenance/p2tr-signature-fraud.ts:709](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L709)

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

[src/services/maintenance/p2tr-signature-fraud.ts:697](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L697)
