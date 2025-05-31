# Class: DepositRefund

Component allowing to craft and submit the Bitcoin refund transaction using
the given tBTC v2 deposit script.

 THIS IS EXPERIMENTAL CODE THAT CAN BE CHANGED OR REMOVED
              IN FUTURE RELEASES. IT SHOULD BE USED ONLY FOR INTERNAL
              PURPOSES AND EXTERNAL APPLICATIONS SHOULD NOT DEPEND ON IT.

## Table of contents

### Constructors

- [constructor](DepositRefund.md#constructor)

### Properties

- [script](DepositRefund.md#script)

### Methods

- [assembleTransaction](DepositRefund.md#assembletransaction)
- [prepareDepositScript](DepositRefund.md#preparedepositscript)
- [signP2SHDepositInput](DepositRefund.md#signp2shdepositinput)
- [signP2WSHDepositInput](DepositRefund.md#signp2wshdepositinput)
- [submitTransaction](DepositRefund.md#submittransaction)
- [fromScript](DepositRefund.md#fromscript)

## Constructors

### constructor

• **new DepositRefund**(`script`): [`DepositRefund`](DepositRefund.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `script` | [`DepositScript`](DepositScript.md) |

#### Returns

[`DepositRefund`](DepositRefund.md)

#### Defined in

[services/deposits/refund.ts:37](https://github.com/keep-network/tbtc-v2/blob/main/typescript/src/services/deposits/refund.ts#L37)

## Properties

### script

• `Readonly` **script**: [`DepositScript`](DepositScript.md)

#### Defined in

[services/deposits/refund.ts:35](https://github.com/keep-network/tbtc-v2/blob/main/typescript/src/services/deposits/refund.ts#L35)

## Methods

### assembleTransaction

▸ **assembleTransaction**(`bitcoinNetwork`, `fee`, `utxo`, `refunderAddress`, `refunderPrivateKey`): `Promise`\<\{ `rawTransaction`: [`BitcoinRawTx`](../interfaces/BitcoinRawTx.md) ; `transactionHash`: [`BitcoinTxHash`](BitcoinTxHash.md)  }\>

Assembles a Bitcoin P2(W)PKH deposit refund transaction.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `bitcoinNetwork` | [`BitcoinNetwork`](../enums/BitcoinNetwork-1.md) | The target Bitcoin network. |
| `fee` | `BigNumber` | the value that will be subtracted from the deposit UTXO being refunded and used as the transaction fee. |
| `utxo` | [`BitcoinTxOutpoint`](../interfaces/BitcoinTxOutpoint.md) & \{ `value`: `BigNumber`  } & [`BitcoinRawTx`](../interfaces/BitcoinRawTx.md) | UTXO that was created during depositing that needs be refunded. |
| `refunderAddress` | `string` | Recipient Bitcoin wallet address of the refunded deposit. |
| `refunderPrivateKey` | `string` | Bitcoin wallet private key of the refunder. It must correspond to the `refundPublicKeyHash` of the deposit script. |

#### Returns

`Promise`\<\{ `rawTransaction`: [`BitcoinRawTx`](../interfaces/BitcoinRawTx.md) ; `transactionHash`: [`BitcoinTxHash`](BitcoinTxHash.md)  }\>

The outcome consisting of:
         - the deposit refund transaction hash,
         - the refund transaction in the raw format.

#### Defined in

[services/deposits/refund.ts:111](https://github.com/keep-network/tbtc-v2/blob/main/typescript/src/services/deposits/refund.ts#L111)

___

### prepareDepositScript

▸ **prepareDepositScript**(`refunderKeyPair`): `Promise`\<`Buffer`\<`ArrayBufferLike`\>\>

Assembles the deposit script based on the given deposit details. Performs
validations on values and key formats.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `refunderKeyPair` | `Signer` | Signer object containing the refunder's key pair. |

#### Returns

`Promise`\<`Buffer`\<`ArrayBufferLike`\>\>

A Promise resolving to the assembled deposit script as a Buffer.

**`Throws`**

Error if there are discrepancies in values or key formats.

#### Defined in

[services/deposits/refund.ts:191](https://github.com/keep-network/tbtc-v2/blob/main/typescript/src/services/deposits/refund.ts#L191)

___

### signP2SHDepositInput

▸ **signP2SHDepositInput**(`transaction`, `inputIndex`, `refunderKeyPair`): `Promise`\<`void`\>

Signs a P2SH deposit transaction input and sets the `scriptSig`.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `transaction` | `Transaction` | The transaction containing the input to be signed. |
| `inputIndex` | `number` | Index pointing to the input within the transaction. |
| `refunderKeyPair` | `Signer` | A Signer object with the refunder's public and private key pair. |

#### Returns

`Promise`\<`void`\>

An empty promise upon successful signing.

#### Defined in

[services/deposits/refund.ts:219](https://github.com/keep-network/tbtc-v2/blob/main/typescript/src/services/deposits/refund.ts#L219)

___

### signP2WSHDepositInput

▸ **signP2WSHDepositInput**(`transaction`, `inputIndex`, `previousOutputValue`, `refunderKeyPair`): `Promise`\<`void`\>

Signs a P2WSH deposit transaction input and sets the witness script.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `transaction` | `Transaction` | The transaction containing the input to be signed. |
| `inputIndex` | `number` | Index pointing to the input within the transaction. |
| `previousOutputValue` | `number` | The value from the previous transaction output. |
| `refunderKeyPair` | `Signer` | A Signer object with the refunder's public and private key pair. |

#### Returns

`Promise`\<`void`\>

An empty promise upon successful signing.

#### Defined in

[services/deposits/refund.ts:256](https://github.com/keep-network/tbtc-v2/blob/main/typescript/src/services/deposits/refund.ts#L256)

___

### submitTransaction

▸ **submitTransaction**(`bitcoinClient`, `fee`, `utxo`, `refunderAddress`, `refunderPrivateKey`): `Promise`\<\{ `transactionHash`: [`BitcoinTxHash`](BitcoinTxHash.md)  }\>

Submits a deposit refund by creating and broadcasting a Bitcoin P2(W)PKH
deposit refund transaction.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `bitcoinClient` | [`BitcoinClient`](../interfaces/BitcoinClient.md) | Bitcoin client used to interact with the network. |
| `fee` | `BigNumber` | the value that will be subtracted from the deposit UTXO being refunded and used as the transaction fee. |
| `utxo` | [`BitcoinUtxo`](../README.md#bitcoinutxo) | UTXO that was created during depositing that needs be refunded. |
| `refunderAddress` | `string` | Recipient Bitcoin wallet address of the refunded deposit. |
| `refunderPrivateKey` | `string` | Bitcoin wallet private key of the refunder. It must correspond to the `refundPublicKeyHash` of the deposit script. |

#### Returns

`Promise`\<\{ `transactionHash`: [`BitcoinTxHash`](BitcoinTxHash.md)  }\>

The outcome is the deposit refund transaction hash.

**`Dev`**

This function should be called by the refunder after `refundLocktime`
     passes plus 1 hour. The additional hour of waiting is the result of
     adopting BIP113 which compares the transaction's locktime against the
     median timestamp of the last 11 blocks. This median time lags
     the current unix time by about 1 hour.

#### Defined in

[services/deposits/refund.ts:63](https://github.com/keep-network/tbtc-v2/blob/main/typescript/src/services/deposits/refund.ts#L63)

___

### fromScript

▸ **fromScript**(`script`): [`DepositRefund`](DepositRefund.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `script` | [`DepositScript`](DepositScript.md) |

#### Returns

[`DepositRefund`](DepositRefund.md)

#### Defined in

[services/deposits/refund.ts:41](https://github.com/keep-network/tbtc-v2/blob/main/typescript/src/services/deposits/refund.ts#L41)
