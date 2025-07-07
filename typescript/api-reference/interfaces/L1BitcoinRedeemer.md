# Interface: L1BitcoinRedeemer

Interface for communication with the L2BitcoinRedeemer on-chain contract
deployed on the given L2 chain.

## Table of contents

### Methods

- [getChainIdentifier](L1BitcoinRedeemer.md#getchainidentifier)
- [requestRedemption](L1BitcoinRedeemer.md#requestredemption)

## Methods

### getChainIdentifier

▸ **getChainIdentifier**(): [`ChainIdentifier`](ChainIdentifier.md)

Gets the chain-specific identifier of this contract.

#### Returns

[`ChainIdentifier`](ChainIdentifier.md)

#### Defined in

[lib/contracts/cross-chain.ts:209](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L209)

___

### requestRedemption

▸ **requestRedemption**(`walletPublicKey`, `mainUtxo`, `encodedVm`): `Promise`\<[`Hex`](../classes/Hex.md)\>

Requests redemption in one transaction using the `approveAndCall` function
from the tBTC on-chain token contract. Then the tBTC token contract calls
the `receiveApproval` function from the `TBTCVault` contract which burns
tBTC tokens and requests redemption.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `walletPublicKey` | [`Hex`](../classes/Hex.md) | The public key of the wallet that is redeeming the tBTC tokens. |
| `mainUtxo` | [`BitcoinUtxo`](../README.md#bitcoinutxo) | The main UTXO of the wallet that is redeeming the tBTC tokens. |
| `encodedVm` | `BytesLike` | The encoded VM of the redemption. |

#### Returns

`Promise`\<[`Hex`](../classes/Hex.md)\>

Transaction hash of the approve and call transaction.

#### Defined in

[lib/contracts/cross-chain.ts:223](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L223)
