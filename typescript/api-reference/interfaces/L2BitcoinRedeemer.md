# Interface: L2BitcoinRedeemer

Interface for communication with the L2BitcoinRedeemer on-chain contract
deployed on the given L2 chain.

## Table of contents

### Methods

- [getChainIdentifier](L2BitcoinRedeemer.md#getchainidentifier)
- [requestRedemption](L2BitcoinRedeemer.md#requestredemption)

## Methods

### getChainIdentifier

▸ **getChainIdentifier**(): [`ChainIdentifier`](ChainIdentifier.md)

Gets the chain-specific identifier of this contract.

#### Returns

[`ChainIdentifier`](ChainIdentifier.md)

#### Defined in

[lib/contracts/cross-chain.ts:127](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L127)

___

### requestRedemption

▸ **requestRedemption**(`amount`, `redeemerOutputScript`, `nonce`): `Promise`\<[`Hex`](../classes/Hex.md)\>

Requests redemption in one transaction using the `approveAndCall` function
from the tBTC on-chain token contract. Then the tBTC token contract calls
the `receiveApproval` function from the `TBTCVault` contract which burns
tBTC tokens and requests redemption.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `amount` | `BigNumber` | The amount to be redeemed with the precision of the tBTC on-chain token contract. |
| `redeemerOutputScript` | [`Hex`](../classes/Hex.md) | The output script that the redeemed funds will be locked to. Must not be prepended with length. |
| `nonce` | `number` | - |

#### Returns

`Promise`\<[`Hex`](../classes/Hex.md)\>

Transaction hash of the approve and call transaction.

#### Defined in

[lib/contracts/cross-chain.ts:140](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L140)
