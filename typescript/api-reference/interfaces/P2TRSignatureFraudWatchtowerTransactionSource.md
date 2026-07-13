# Interface: P2TRSignatureFraudWatchtowerTransactionSource

## Table of contents

### Methods

- [listConfirmedTransactions](P2TRSignatureFraudWatchtowerTransactionSource.md#listconfirmedtransactions)
- [listMempoolTransactions](P2TRSignatureFraudWatchtowerTransactionSource.md#listmempooltransactions)

## Methods

### listConfirmedTransactions

▸ **listConfirmedTransactions**(): `Promise`\<[`P2TRWatchtowerConfirmedTransaction`](../README.md#p2trwatchtowerconfirmedtransaction)[]\>

#### Returns

`Promise`\<[`P2TRWatchtowerConfirmedTransaction`](../README.md#p2trwatchtowerconfirmedtransaction)[]\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:240](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L240)

___

### listMempoolTransactions

▸ **listMempoolTransactions**(): `Promise`\<[`P2TRWatchtowerMempoolTransaction`](../README.md#p2trwatchtowermempooltransaction)[]\>

#### Returns

`Promise`\<[`P2TRWatchtowerMempoolTransaction`](../README.md#p2trwatchtowermempooltransaction)[]\>

#### Defined in

[src/services/maintenance/p2tr-signature-fraud.ts:239](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/p2tr-signature-fraud.ts#L239)
