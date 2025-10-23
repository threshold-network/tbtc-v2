# Interface: TBTCToken

Interface for communication with the TBTC v2 token on-chain contract.

## Implemented by

- [`EthereumTBTCToken`](../classes/EthereumTBTCToken.md)

## Table of contents

### Methods

- [buildRequestRedemptionData](TBTCToken.md#buildrequestredemptiondata)
- [getChainIdentifier](TBTCToken.md#getchainidentifier)
- [requestRedemption](TBTCToken.md#requestredemption)
- [totalSupply](TBTCToken.md#totalsupply)

## Methods

### buildRequestRedemptionData

▸ **buildRequestRedemptionData**(`redeemer`, `walletPublicKey`, `mainUtxo`, `redeemerOutputScript`): [`Hex`](../classes/Hex.md)

Prepare tBTC Redemption Data in the raw bytes format expected by the tBTC
Bridge contract. The data is used to request a redemption of TBTC v2 token
through custom integration with the tBTC Bridge contract.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `redeemer` | [`ChainIdentifier`](ChainIdentifier.md) | Chain identifier of the redeemer. This is the address that will be able to claim the tBTC tokens if anything goes wrong during the redemption process. |
| `walletPublicKey` | [`Hex`](../classes/Hex.md) | The Bitcoin public key of the wallet. Must be in the compressed form (33 bytes long with 02 or 03 prefix). |
| `mainUtxo` | [`BitcoinUtxo`](../README.md#bitcoinutxo) | The main UTXO of the wallet. Must match the main UTXO held by the on-chain Bridge contract. |
| `redeemerOutputScript` | [`Hex`](../classes/Hex.md) | The output script that the redeemed funds will be locked to. Must not be prepended with length. |

#### Returns

[`Hex`](../classes/Hex.md)

#### Defined in

[lib/contracts/tbtc-token.ts:61](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/tbtc-token.ts#L61)

___

### getChainIdentifier

▸ **getChainIdentifier**(): [`ChainIdentifier`](ChainIdentifier.md)

Gets the chain-specific identifier of this contract.

#### Returns

[`ChainIdentifier`](ChainIdentifier.md)

#### Defined in

[lib/contracts/tbtc-token.ts:13](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/tbtc-token.ts#L13)

___

### requestRedemption

▸ **requestRedemption**(`walletPublicKey`, `mainUtxo`, `redeemerOutputScript`, `amount`): `Promise`\<[`Hex`](../classes/Hex.md)\>

Requests redemption in one transaction using the `approveAndCall` function
from the tBTC on-chain token contract. Then the tBTC token contract calls
the `receiveApproval` function from the `TBTCVault` contract which burns
tBTC tokens and requests redemption.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `walletPublicKey` | [`Hex`](../classes/Hex.md) | The Bitcoin public key of the wallet. Must be in the compressed form (33 bytes long with 02 or 03 prefix). |
| `mainUtxo` | [`BitcoinUtxo`](../README.md#bitcoinutxo) | The main UTXO of the wallet. Must match the main UTXO held by the on-chain Bridge contract. |
| `redeemerOutputScript` | [`Hex`](../classes/Hex.md) | The output script that the redeemed funds will be locked to. Must not be prepended with length. |
| `amount` | `BigNumber` | The amount to be redeemed with the precision of the tBTC on-chain token contract. |

#### Returns

`Promise`\<[`Hex`](../classes/Hex.md)\>

Transaction hash of the approve and call transaction.

#### Defined in

[lib/contracts/tbtc-token.ts:40](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/tbtc-token.ts#L40)

___

### totalSupply

▸ **totalSupply**(`blockNumber?`): `Promise`\<`BigNumber`\>

Gets the total supply of the TBTC v2 token. The returned value is in
ERC 1e18 precision, it has to be converted before using as Bitcoin value
with 1e8 precision in satoshi.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `blockNumber?` | `number` | Optional parameter determining the block the total supply should be fetched for. If this parameter is not set, the total supply is taken for the latest block. |

#### Returns

`Promise`\<`BigNumber`\>

#### Defined in

[lib/contracts/tbtc-token.ts:23](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/tbtc-token.ts#L23)
