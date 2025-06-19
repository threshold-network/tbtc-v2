# Class: Spv

## Table of contents

### Constructors

- [constructor](Spv.md#constructor)

### Properties

- [bitcoinClient](Spv.md#bitcoinclient)
- [tbtcContracts](Spv.md#tbtccontracts)

### Methods

- [submitDepositSweepProof](Spv.md#submitdepositsweepproof)
- [submitRedemptionProof](Spv.md#submitredemptionproof)

## Constructors

### constructor

• **new Spv**(`tbtcContracts`, `bitcoinClient`): [`Spv`](Spv.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `tbtcContracts` | [`TBTCContracts`](../README.md#tbtccontracts) |
| `bitcoinClient` | [`BitcoinClient`](../interfaces/BitcoinClient.md) |

#### Returns

[`Spv`](Spv.md)

#### Defined in

[services/maintenance/spv.ts:21](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/spv.ts#L21)

## Properties

### bitcoinClient

• `Private` `Readonly` **bitcoinClient**: [`BitcoinClient`](../interfaces/BitcoinClient.md)

Bitcoin client handle.

#### Defined in

[services/maintenance/spv.ts:19](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/spv.ts#L19)

___

### tbtcContracts

• `Private` `Readonly` **tbtcContracts**: [`TBTCContracts`](../README.md#tbtccontracts)

Handle to tBTC contracts.

#### Defined in

[services/maintenance/spv.ts:15](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/spv.ts#L15)

## Methods

### submitDepositSweepProof

▸ **submitDepositSweepProof**(`transactionHash`, `mainUtxo`, `vault?`): `Promise`\<`void`\>

Prepares the proof of a deposit sweep transaction and submits it to the
Bridge on-chain contract.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `transactionHash` | [`BitcoinTxHash`](BitcoinTxHash.md) | Hash of the transaction being proven. |
| `mainUtxo` | [`BitcoinUtxo`](../README.md#bitcoinutxo) | Recent main UTXO of the wallet as currently known on-chain. |
| `vault?` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) | (Optional) The vault pointed by swept deposits. |

#### Returns

`Promise`\<`void`\>

Empty promise.

#### Defined in

[services/maintenance/spv.ts:34](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/spv.ts#L34)

___

### submitRedemptionProof

▸ **submitRedemptionProof**(`transactionHash`, `mainUtxo`, `walletPublicKey`): `Promise`\<`void`\>

Prepares the proof of a redemption transaction and submits it to the
Bridge on-chain contract.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `transactionHash` | [`BitcoinTxHash`](BitcoinTxHash.md) | Hash of the transaction being proven. |
| `mainUtxo` | [`BitcoinUtxo`](../README.md#bitcoinutxo) | Recent main UTXO of the wallet as currently known on-chain. |
| `walletPublicKey` | [`Hex`](Hex.md) | Bitcoin public key of the wallet. Must be in the compressed form (33 bytes long with 02 or 03 prefix). |

#### Returns

`Promise`\<`void`\>

Empty promise.

#### Defined in

[services/maintenance/spv.ts:67](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/maintenance/spv.ts#L67)
