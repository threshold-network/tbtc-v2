# Interface: P2TRSignatureFraudWatchtowerTransactionSource

## Table of contents

### Methods

- [commitConfirmedTransactionScan](P2TRSignatureFraudWatchtowerTransactionSource.md#commitconfirmedtransactionscan)
- [listConfirmedTransactions](P2TRSignatureFraudWatchtowerTransactionSource.md#listconfirmedtransactions)
- [listMempoolTransactions](P2TRSignatureFraudWatchtowerTransactionSource.md#listmempooltransactions)

## Methods

### commitConfirmedTransactionScan

▸ **commitConfirmedTransactionScan**(): `Promise`\<`void`\>

Acknowledges the staged confirmed batch after its observations have been
durably recorded. Sources without a durable cursor may omit this method.

#### Returns

`Promise`\<`void`\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:278](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L278)

___

### listConfirmedTransactions

▸ **listConfirmedTransactions**(): `Promise`\<[`P2TRWatchtowerConfirmedTransactionSourceResult`](../README.md#p2trwatchtowerconfirmedtransactionsourceresult)\>

#### Returns

`Promise`\<[`P2TRWatchtowerConfirmedTransactionSourceResult`](../README.md#p2trwatchtowerconfirmedtransactionsourceresult)\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:273](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L273)

___

### listMempoolTransactions

▸ **listMempoolTransactions**(): `Promise`\<[`P2TRWatchtowerMempoolTransaction`](../README.md#p2trwatchtowermempooltransaction)[]\>

#### Returns

`Promise`\<[`P2TRWatchtowerMempoolTransaction`](../README.md#p2trwatchtowermempooltransaction)[]\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:272](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L272)
