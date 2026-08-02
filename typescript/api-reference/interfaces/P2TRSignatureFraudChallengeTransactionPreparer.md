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
- [tombstoneSignatureFraudSignerInvocation](P2TRSignatureFraudChallengeTransactionPreparer.md#tombstonesignaturefraudsignerinvocation)

## Properties

### laneID

• `Readonly` **laneID**: `string`

Stable identities used for durable lane and signer quarantine records.

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:736](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L736)

___

### signerIdentity

• `Readonly` **signerIdentity**: `string`

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:737](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L737)

___

### transactionSender

• `Readonly` **transactionSender**: `string`

Sender whose nonce lane is serialized by the durable outbox store.

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:739](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L739)

## Methods

### prepareSignatureFraudChallengeReplacementTransaction

▸ **prepareSignatureFraudChallengeReplacementTransaction**(`intent`, `reservation`, `previous`, `feePolicy`, `signerInvocationID`, `signingRequestDigest`): `Promise`\<[`P2TRSignatureFraudPreparedChallengeTransactionResponse`](../README.md#p2trsignaturefraudpreparedchallengetransactionresponse)\>

Signs an EIP-1559 replacement for the same durable intent, sender, and
nonce. The outbox persists the signer-invocation boundary before calling
this method and appends the returned raw bytes before any broadcast.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `intent` | [`P2TRSignatureFraudSubmissionIntent`](../README.md#p2trsignaturefraudsubmissionintent) | - |
| `reservation` | [`P2TRSignatureFraudBoundNonceReservation`](../README.md#p2trsignaturefraudboundnoncereservation) | - |
| `previous` | [`P2TRSignatureFraudPreparedChallengeTransaction`](../README.md#p2trsignaturefraudpreparedchallengetransaction) | - |
| `feePolicy` | [`P2TRSignatureFraudChallengeTransactionFeePolicy`](../README.md#p2trsignaturefraudchallengetransactionfeepolicy) | - |
| `signerInvocationID` | [`Hex`](../classes/Hex.md) | Deterministic idempotency key; tombstoned IDs MUST be rejected. |
| `signingRequestDigest` | [`Hex`](../classes/Hex.md) | Digest of every exact signer input, independently authorized upstream. |

#### Returns

`Promise`\<[`P2TRSignatureFraudPreparedChallengeTransactionResponse`](../README.md#p2trsignaturefraudpreparedchallengetransactionresponse)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:782](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L782)

___

### prepareSignatureFraudChallengeTransaction

▸ **prepareSignatureFraudChallengeTransaction**(`intent`, `reservation`, `feePolicy`, `signerInvocationID`, `signingRequestDigest`): `Promise`\<[`P2TRSignatureFraudPreparedChallengeTransactionResponse`](../README.md#p2trsignaturefraudpreparedchallengetransactionresponse)\>

Prepares and signs, but MUST NOT broadcast, an Ethereum transaction for
the supplied intent and already-persisted reservation. Implementations
MUST reject a reservation whose binding, sender, or nonce is not exact.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `intent` | [`P2TRSignatureFraudSubmissionIntent`](../README.md#p2trsignaturefraudsubmissionintent) | - |
| `reservation` | [`P2TRSignatureFraudBoundNonceReservation`](../README.md#p2trsignaturefraudboundnoncereservation) | - |
| `feePolicy` | [`P2TRSignatureFraudChallengeTransactionFeePolicy`](../README.md#p2trsignaturefraudchallengetransactionfeepolicy) | - |
| `signerInvocationID` | [`Hex`](../classes/Hex.md) | Deterministic idempotency key; tombstoned IDs MUST be rejected. |
| `signingRequestDigest` | [`Hex`](../classes/Hex.md) | Digest of every exact signer input, independently authorized upstream. |

#### Returns

`Promise`\<[`P2TRSignatureFraudPreparedChallengeTransactionResponse`](../README.md#p2trsignaturefraudpreparedchallengetransactionresponse)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:767](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L767)

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

[src/services/maintenance/p2tr-signature-fraud.ts:757](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L757)

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

[src/services/maintenance/p2tr-signature-fraud.ts:745](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L745)

___

### tombstoneSignatureFraudSignerInvocation

▸ **tombstoneSignatureFraudSignerInvocation**(`signerInvocationID`): `Promise`\<[`P2TRSignatureFraudSignerInvocationTombstone`](../README.md#p2trsignaturefraudsignerinvocationtombstone)\>

Durably prevents a delayed or retried signer request from ever executing.
The operation MUST be idempotent by `signerInvocationID`, and the receipt
must be provider-authenticated so orphan recovery can verify it locally.

#### Parameters

| Name | Type |
| :------ | :------ |
| `signerInvocationID` | [`Hex`](../classes/Hex.md) |

#### Returns

`Promise`\<[`P2TRSignatureFraudSignerInvocationTombstone`](../README.md#p2trsignaturefraudsignerinvocationtombstone)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:798](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L798)
