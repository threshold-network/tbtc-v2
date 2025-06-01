# Interface: RedeemerProxy

Interface defining functions required to route tBTC redemption requests through
the tBTC bridge by custom integrators.

## Table of contents

### Methods

- [redeemerAddress](RedeemerProxy.md#redeemeraddress)
- [requestRedemption](RedeemerProxy.md#requestredemption)

## Methods

### redeemerAddress

▸ **redeemerAddress**(): [`ChainIdentifier`](ChainIdentifier.md)

Chain identifier of the redeemer. This is the address that will be able to
claim the tBTC tokens if anything goes wrong during the redemption process.

#### Returns

[`ChainIdentifier`](ChainIdentifier.md)

#### Defined in

[services/redemptions/redeemer-proxy.ts:13](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redeemer-proxy.ts#L13)

___

### requestRedemption

▸ **requestRedemption**(`redemptionData`): `Promise`\<[`Hex`](../classes/Hex.md)\>

Requests redemption of tBTC token with determined redemption data.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `redemptionData` | [`Hex`](../classes/Hex.md) | Data required to redeem the tBTC tokens. |

#### Returns

`Promise`\<[`Hex`](../classes/Hex.md)\>

Target chain hash of the request redemption transaction
         (for example, Ethereum transaction hash)

#### Defined in

[services/redemptions/redeemer-proxy.ts:21](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redeemer-proxy.ts#L21)
