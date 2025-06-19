# Class: DepositFunding

Component allowing to craft and submit the Bitcoin funding transaction using
the given tBTC v2 deposit script.

 THIS IS EXPERIMENTAL CODE THAT CAN BE CHANGED OR REMOVED
              IN FUTURE RELEASES. IT SHOULD BE USED ONLY FOR INTERNAL
              PURPOSES AND EXTERNAL APPLICATIONS SHOULD NOT DEPEND ON IT.

## Table of contents

### Constructors

- [constructor](DepositFunding.md#constructor)

### Properties

- [script](DepositFunding.md#script)

### Methods

- [assembleTransaction](DepositFunding.md#assembletransaction)
- [submitTransaction](DepositFunding.md#submittransaction)
- [fromScript](DepositFunding.md#fromscript)

## Constructors

### constructor

• **new DepositFunding**(`script`): [`DepositFunding`](DepositFunding.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `script` | [`DepositScript`](DepositScript.md) |

#### Returns

[`DepositFunding`](DepositFunding.md)

#### Defined in

[services/deposits/funding.ts:30](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/funding.ts#L30)

## Properties

### script

• `Readonly` **script**: [`DepositScript`](DepositScript.md)

#### Defined in

[services/deposits/funding.ts:28](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/funding.ts#L28)

## Methods

### assembleTransaction

▸ **assembleTransaction**(`bitcoinNetwork`, `amount`, `inputUtxos`, `fee`, `depositorPrivateKey`): `Promise`\<\{ `depositUtxo`: [`BitcoinUtxo`](../README.md#bitcoinutxo) ; `rawTransaction`: [`BitcoinRawTx`](../interfaces/BitcoinRawTx.md) ; `transactionHash`: [`BitcoinTxHash`](BitcoinTxHash.md)  }\>

Assembles and signs the Bitcoin P2(W)SH funding transaction using
the underlying deposit script.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `bitcoinNetwork` | [`BitcoinNetwork`](../enums/BitcoinNetwork-1.md) | The target Bitcoin network. |
| `amount` | `BigNumber` | Deposit amount in satoshis. |
| `inputUtxos` | [`BitcoinTxOutpoint`](../interfaces/BitcoinTxOutpoint.md) & \{ `value`: `BigNumber`  } & [`BitcoinRawTx`](../interfaces/BitcoinRawTx.md)[] | UTXOs to be used for funding the deposit transaction. So far only P2WPKH UTXO inputs are supported. |
| `fee` | `BigNumber` | Transaction fee to be subtracted from the sum of the UTXOs' values. |
| `depositorPrivateKey` | `string` | Bitcoin private key of the depositor. Must be able to unlock input UTXOs. |

#### Returns

`Promise`\<\{ `depositUtxo`: [`BitcoinUtxo`](../README.md#bitcoinutxo) ; `rawTransaction`: [`BitcoinRawTx`](../interfaces/BitcoinRawTx.md) ; `transactionHash`: [`BitcoinTxHash`](BitcoinTxHash.md)  }\>

The outcome consisting of:
         - the deposit transaction hash,
         - the deposit UTXO produced by this transaction.
         - the deposit transaction in the raw format

**`Dev`**

It is up to the caller to ensure that input UTXOs are valid and
     can be unlocked using the depositor's private key. It is also
     caller's responsibility to ensure the given deposit is funded exactly
     once.

**`Dev`**

UTXOs are selected for transaction funding based on their types. UTXOs
    with unsupported types are skipped. The selection process stops once
    the sum of the chosen UTXOs meets the required funding amount.

**`Throws`**

When the sum of the selected UTXOs is insufficient to cover
       the deposit amount and transaction fee.

#### Defined in

[services/deposits/funding.ts:62](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/funding.ts#L62)

___

### submitTransaction

▸ **submitTransaction**(`amount`, `inputUtxos`, `fee`, `depositorPrivateKey`, `bitcoinClient`): `Promise`\<\{ `depositUtxo`: [`BitcoinUtxo`](../README.md#bitcoinutxo) ; `transactionHash`: [`BitcoinTxHash`](BitcoinTxHash.md)  }\>

Assembles, signs and submits the Bitcoin P2(W)SH funding transaction
using the underlying deposit script.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `amount` | `BigNumber` | Deposit amount in satoshis. |
| `inputUtxos` | [`BitcoinUtxo`](../README.md#bitcoinutxo)[] | UTXOs to be used for funding the deposit transaction. So far only P2WPKH UTXO inputs are supported. |
| `fee` | `BigNumber` | The value that should be subtracted from the sum of the UTXOs values and used as the transaction fee. |
| `depositorPrivateKey` | `string` | Bitcoin private key of the depositor. |
| `bitcoinClient` | [`BitcoinClient`](../interfaces/BitcoinClient.md) | Bitcoin client used to interact with the network. |

#### Returns

`Promise`\<\{ `depositUtxo`: [`BitcoinUtxo`](../README.md#bitcoinutxo) ; `transactionHash`: [`BitcoinTxHash`](BitcoinTxHash.md)  }\>

The outcome consisting of:
         - the deposit transaction hash,
         - the deposit UTXO produced by this transaction.

**`Dev`**

It is up to the caller to ensure that depositor's private key controls
     some UTXOs that can be used as input. It is also caller's responsibility
     to ensure the given deposit is funded exactly once.

**`Dev`**

UTXOs are selected for transaction funding based on their types. UTXOs
      with unsupported types are skipped. The selection process stops once
      the sum of the chosen UTXOs meets the required funding amount.
      Be aware that the function will attempt to broadcast the transaction,
      although successful broadcast is not guaranteed.

**`Throws`**

When the sum of the selected UTXOs is insufficient to cover
       the deposit amount and transaction fee.

#### Defined in

[services/deposits/funding.ts:181](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/funding.ts#L181)

___

### fromScript

▸ **fromScript**(`script`): [`DepositFunding`](DepositFunding.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `script` | [`DepositScript`](DepositScript.md) |

#### Returns

[`DepositFunding`](DepositFunding.md)

#### Defined in

[services/deposits/funding.ts:34](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/funding.ts#L34)
