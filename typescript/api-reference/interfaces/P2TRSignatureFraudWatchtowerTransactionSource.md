# Interface: P2TRSignatureFraudWatchtowerTransactionSource

## Table of contents

### Properties

- [p2trSignatureFraudWatchtowerRequiresAuthenticatedPrevouts](P2TRSignatureFraudWatchtowerTransactionSource.md#p2trsignaturefraudwatchtowerrequiresauthenticatedprevouts)

### Methods

- [abortConfirmedTransactionScan](P2TRSignatureFraudWatchtowerTransactionSource.md#abortconfirmedtransactionscan)
- [commitConfirmedTransactionScan](P2TRSignatureFraudWatchtowerTransactionSource.md#commitconfirmedtransactionscan)
- [listConfirmedTransactions](P2TRSignatureFraudWatchtowerTransactionSource.md#listconfirmedtransactions)
- [listMempoolTransactions](P2TRSignatureFraudWatchtowerTransactionSource.md#listmempooltransactions)

## Properties

### p2trSignatureFraudWatchtowerRequiresAuthenticatedPrevouts

• `Optional` `Readonly` **p2trSignatureFraudWatchtowerRequiresAuthenticatedPrevouts**: ``true``

When true, every returned transaction must carry an authenticated complete
`inputPrevouts` vector. The runner then rejects absence instead of falling
back to its independently configured `BitcoinClient`.

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:286](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L286)

## Methods

### abortConfirmedTransactionScan

▸ **abortConfirmedTransactionScan**(): `void` \| `Promise`\<`void`\>

Discards a staged scan when the enclosing cycle cannot commit safely.

#### Returns

`void` \| `Promise`\<`void`\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:295](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L295)

___

### commitConfirmedTransactionScan

▸ **commitConfirmedTransactionScan**(): `Promise`\<`void`\>

Acknowledges the staged confirmed batch after its observations have been
durably recorded. Sources without a durable cursor may omit this method.

#### Returns

`Promise`\<`void`\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:293](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L293)

___

### listConfirmedTransactions

▸ **listConfirmedTransactions**(): `Promise`\<[`P2TRWatchtowerConfirmedTransactionSourceResult`](../README.md#p2trwatchtowerconfirmedtransactionsourceresult)\>

#### Returns

`Promise`\<[`P2TRWatchtowerConfirmedTransactionSourceResult`](../README.md#p2trwatchtowerconfirmedtransactionsourceresult)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:288](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L288)

___

### listMempoolTransactions

▸ **listMempoolTransactions**(): `Promise`\<[`P2TRWatchtowerMempoolTransaction`](../README.md#p2trwatchtowermempooltransaction)[]\>

#### Returns

`Promise`\<[`P2TRWatchtowerMempoolTransaction`](../README.md#p2trwatchtowermempooltransaction)[]\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:287](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L287)
