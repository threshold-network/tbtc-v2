# Class: RedemptionsService

Service exposing features related to tBTC v2 redemptions.

## Table of contents

### Constructors

- [constructor](RedemptionsService.md#constructor)

### Properties

- [#crossChainContracts](RedemptionsService.md##crosschaincontracts)
- [bitcoinClient](RedemptionsService.md#bitcoinclient)
- [tbtcContracts](RedemptionsService.md#tbtccontracts)

### Methods

- [chunkArray](RedemptionsService.md#chunkarray)
- [determineRedemptionData](RedemptionsService.md#determineredemptiondata)
- [determineValidRedemptionWallet](RedemptionsService.md#determinevalidredemptionwallet)
- [determineWalletMainUtxo](RedemptionsService.md#determinewalletmainutxo)
- [fetchWalletsForRedemption](RedemptionsService.md#fetchwalletsforredemption)
- [findWalletForRedemption](RedemptionsService.md#findwalletforredemption)
- [fromSerializableWallet](RedemptionsService.md#fromserializablewallet)
- [getRedeemerOutputScript](RedemptionsService.md#getredeemeroutputscript)
- [getRedemptionRequests](RedemptionsService.md#getredemptionrequests)
- [relayRedemptionRequestToL1](RedemptionsService.md#relayredemptionrequesttol1)
- [requestCrossChainRedemption](RedemptionsService.md#requestcrosschainredemption)
- [requestRedemption](RedemptionsService.md#requestredemption)
- [requestRedemptionWithProxy](RedemptionsService.md#requestredemptionwithproxy)

## Constructors

### constructor

• **new RedemptionsService**(`tbtcContracts`, `bitcoinClient`, `crossChainContracts`): [`RedemptionsService`](RedemptionsService.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `tbtcContracts` | [`TBTCContracts`](../README.md#tbtccontracts) |
| `bitcoinClient` | [`BitcoinClient`](../interfaces/BitcoinClient.md) |
| `crossChainContracts` | (`_`: [`DestinationChainName`](../README.md#destinationchainname)) => `undefined` \| [`CrossChainInterfaces`](../README.md#crosschaininterfaces) |

#### Returns

[`RedemptionsService`](RedemptionsService.md)

#### Defined in

[services/redemptions/redemptions-service.ts:47](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L47)

## Properties

### #crossChainContracts

• `Private` `Readonly` **#crossChainContracts**: (`_`: [`DestinationChainName`](../README.md#destinationchainname)) => `undefined` \| [`CrossChainInterfaces`](../README.md#crosschaininterfaces)

Gets cross-chain contracts for the given supported L2 chain.

#### Type declaration

▸ (`_`): `undefined` \| [`CrossChainInterfaces`](../README.md#crosschaininterfaces)

##### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `_` | [`DestinationChainName`](../README.md#destinationchainname) | Name of the L2 chain for which to get cross-chain contracts. |

##### Returns

`undefined` \| [`CrossChainInterfaces`](../README.md#crosschaininterfaces)

#### Defined in

[services/redemptions/redemptions-service.ts:45](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L45)

___

### bitcoinClient

• `Private` `Readonly` **bitcoinClient**: [`BitcoinClient`](../interfaces/BitcoinClient.md)

Bitcoin client handle.

#### Defined in

[services/redemptions/redemptions-service.ts:38](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L38)

___

### tbtcContracts

• `Private` `Readonly` **tbtcContracts**: [`TBTCContracts`](../README.md#tbtccontracts)

Handle to tBTC contracts.

#### Defined in

[services/redemptions/redemptions-service.ts:34](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L34)

## Methods

### chunkArray

▸ **chunkArray**\<`T`\>(`arr`, `chunkSize`): `T`[][]

Chunk an array into subarrays of a given size.

#### Type parameters

| Name |
| :------ |
| `T` |

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `arr` | `T`[] | The array to be chunked. |
| `chunkSize` | `number` | The size of each chunk. |

#### Returns

`T`[][]

An array of subarrays, where each subarray has a maximum length of `chunkSize`.

#### Defined in

[services/redemptions/redemptions-service.ts:515](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L515)

___

### determineRedemptionData

▸ **determineRedemptionData**(`bitcoinRedeemerAddress`, `amount`): `Promise`\<\{ `mainUtxo`: [`BitcoinUtxo`](../README.md#bitcoinutxo) ; `redeemerOutputScript`: [`Hex`](Hex.md) ; `walletPublicKey`: [`Hex`](Hex.md)  }\>

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `bitcoinRedeemerAddress` | `string` | Bitcoin address redeemed BTC should be sent to. Only P2PKH, P2WPKH, P2SH, and P2WSH address types are supported. |
| `amount` | `BigNumber` | The amount to be redeemed with the precision of the tBTC on-chain token contract. |

#### Returns

`Promise`\<\{ `mainUtxo`: [`BitcoinUtxo`](../README.md#bitcoinutxo) ; `redeemerOutputScript`: [`Hex`](Hex.md) ; `walletPublicKey`: [`Hex`](Hex.md)  }\>

Object containing:
         - Bitcoin public key of the wallet asked to handle the redemption.
           Presented in the compressed form (33 bytes long with 02 or 03 prefix).
         - Main UTXO of the wallet.
         - Redeemer output script.

#### Defined in

[services/redemptions/redemptions-service.ts:261](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L261)

___

### determineValidRedemptionWallet

▸ **determineValidRedemptionWallet**(`bitcoinRedeemerAddress`, `amount`, `potentialCandidateWallets`): `Promise`\<[`RedemptionWallet`](../interfaces/RedemptionWallet.md)\>

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `bitcoinRedeemerAddress` | `string` | Bitcoin address redeemed BTC should be sent to. Only P2PKH, P2WPKH, P2SH, and P2WSH address types are supported. |
| `amount` | `BigNumber` | The amount to be redeemed with the precision of the tBTC on-chain token contract. |
| `potentialCandidateWallets` | [`SerializableWallet`](../interfaces/SerializableWallet.md)[] | Array of wallets that can handle the redemption request. The wallets must be in the Live state. |

#### Returns

`Promise`\<[`RedemptionWallet`](../interfaces/RedemptionWallet.md)\>

Object containing:
         - Bitcoin public key of the wallet asked to handle the redemption.
          Presented in the compressed form (33 bytes long with 02 or 03 prefix).
        - Wallet public key hash.
        - Main UTXO of the wallet.
        - Redeemer output script.

**`Throws`**

Throws an error if no valid redemption wallet exists for the given
        input parameters.

#### Defined in

[services/redemptions/redemptions-service.ts:304](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L304)

___

### determineWalletMainUtxo

▸ **determineWalletMainUtxo**(`walletPublicKeyHash`, `bitcoinNetwork`): `Promise`\<`undefined` \| [`BitcoinUtxo`](../README.md#bitcoinutxo)\>

Determines the plain-text wallet main UTXO currently registered in the
Bridge on-chain contract. The returned main UTXO can be undefined if the
wallet does not have a main UTXO registered in the Bridge at the moment.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `walletPublicKeyHash` | [`Hex`](Hex.md) | Public key hash of the wallet. |
| `bitcoinNetwork` | [`BitcoinNetwork`](../enums/BitcoinNetwork-1.md) | Bitcoin network. |

#### Returns

`Promise`\<`undefined` \| [`BitcoinUtxo`](../README.md#bitcoinutxo)\>

Promise holding the wallet main UTXO or undefined value.

#### Defined in

[services/redemptions/redemptions-service.ts:534](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L534)

___

### fetchWalletsForRedemption

▸ **fetchWalletsForRedemption**(): `Promise`\<[`SerializableWallet`](../interfaces/SerializableWallet.md)[]\>

Fetches all wallets that are currently live and can handle a redemption
request.

#### Returns

`Promise`\<[`SerializableWallet`](../interfaces/SerializableWallet.md)[]\>

Array of wallet events.

#### Defined in

[services/redemptions/redemptions-service.ts:688](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L688)

___

### findWalletForRedemption

▸ **findWalletForRedemption**(`redeemerOutputScript`, `amount`): `Promise`\<\{ `mainUtxo`: [`BitcoinUtxo`](../README.md#bitcoinutxo) ; `walletPublicKey`: [`Hex`](Hex.md)  }\>

Finds the oldest live wallet that has enough BTC to handle a redemption
request.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `redeemerOutputScript` | [`Hex`](Hex.md) | The redeemer output script the redeemed funds are supposed to be locked on. Must not be prepended with length. |
| `amount` | `BigNumber` | The amount to be redeemed in satoshis. |

#### Returns

`Promise`\<\{ `mainUtxo`: [`BitcoinUtxo`](../README.md#bitcoinutxo) ; `walletPublicKey`: [`Hex`](Hex.md)  }\>

Promise with the wallet details needed to request a redemption.

#### Defined in

[services/redemptions/redemptions-service.ts:376](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L376)

___

### fromSerializableWallet

▸ **fromSerializableWallet**(`serialized`): [`ValidRedemptionWallet`](../interfaces/ValidRedemptionWallet.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `serialized` | [`SerializableWallet`](../interfaces/SerializableWallet.md) |

#### Returns

[`ValidRedemptionWallet`](../interfaces/ValidRedemptionWallet.md)

#### Defined in

[services/redemptions/redemptions-service.ts:735](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L735)

___

### getRedeemerOutputScript

▸ **getRedeemerOutputScript**(`bitcoinRedeemerAddress`): `Promise`\<[`Hex`](Hex.md)\>

Converts a Bitcoin address to its output script.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `bitcoinRedeemerAddress` | `string` | Bitcoin address to be converted. |

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

The output script of the given Bitcoin address.

#### Defined in

[services/redemptions/redemptions-service.ts:713](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L713)

___

### getRedemptionRequests

▸ **getRedemptionRequests**(`bitcoinRedeemerAddress`, `walletPublicKey`, `type?`): `Promise`\<[`RedemptionRequest`](../interfaces/RedemptionRequest.md)\>

Gets data of a registered redemption request from the Bridge contract.

#### Parameters

| Name | Type | Default value | Description |
| :------ | :------ | :------ | :------ |
| `bitcoinRedeemerAddress` | `string` | `undefined` | Bitcoin redeemer address used to request the redemption. |
| `walletPublicKey` | [`Hex`](Hex.md) | `undefined` | Bitcoin public key of the wallet handling the redemption. Must be in the compressed form (33 bytes long with 02 or 03 prefix). |
| `type` | ``"pending"`` \| ``"timedOut"`` | `"pending"` | Type of redemption requests the function will look for. Can be either `pending` or `timedOut`. By default, `pending` is used. |

#### Returns

`Promise`\<[`RedemptionRequest`](../interfaces/RedemptionRequest.md)\>

Matching redemption requests.

**`Throws`**

Throws an error if no redemption request exists for the given
        input parameters.

#### Defined in

[services/redemptions/redemptions-service.ts:646](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L646)

___

### relayRedemptionRequestToL1

▸ **relayRedemptionRequestToL1**(`amount`, `redeemerOutputScript`, `encodedVm`, `l2ChainName`): `Promise`\<\{ `targetChainTxHash`: [`Hex`](Hex.md)  }\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `amount` | `BigNumber` |
| `redeemerOutputScript` | [`Hex`](Hex.md) |
| `encodedVm` | `BytesLike` |
| `l2ChainName` | [`DestinationChainName`](../README.md#destinationchainname) |

#### Returns

`Promise`\<\{ `targetChainTxHash`: [`Hex`](Hex.md)  }\>

#### Defined in

[services/redemptions/redemptions-service.ts:213](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L213)

___

### requestCrossChainRedemption

▸ **requestCrossChainRedemption**(`bitcoinRedeemerAddress`, `amount`, `l2ChainName`): `Promise`\<\{ `targetChainTxHash`: [`Hex`](Hex.md)  }\>

Requests a redemption of TBTC v2 token into BTC using a custom integration.
The function builds the redemption data and handles the redemption request
through the provided redeemer proxy.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `bitcoinRedeemerAddress` | `string` | Bitcoin address the redeemed BTC should be sent to. Only P2PKH, P2WPKH, P2SH, and P2WSH address types are supported. |
| `amount` | `BigNumber` | The amount to be redeemed with the precision of the tBTC on-chain token contract. |
| `l2ChainName` | [`DestinationChainName`](../README.md#destinationchainname) | The name of the L2 chain to request redemption on. |

#### Returns

`Promise`\<\{ `targetChainTxHash`: [`Hex`](Hex.md)  }\>

Object containing:
         - Target chain hash of the request redemption transaction
           (for example, Ethereum transaction hash)

#### Defined in

[services/redemptions/redemptions-service.ts:180](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L180)

___

### requestRedemption

▸ **requestRedemption**(`bitcoinRedeemerAddress`, `amount`): `Promise`\<\{ `targetChainTxHash`: [`Hex`](Hex.md) ; `walletPublicKey`: [`Hex`](Hex.md)  }\>

Requests a redemption of TBTC v2 token into BTC.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `bitcoinRedeemerAddress` | `string` | Bitcoin address redeemed BTC should be sent to. Only P2PKH, P2WPKH, P2SH, and P2WSH address types are supported. |
| `amount` | `BigNumber` | The amount to be redeemed with the precision of the tBTC on-chain token contract. |

#### Returns

`Promise`\<\{ `targetChainTxHash`: [`Hex`](Hex.md) ; `walletPublicKey`: [`Hex`](Hex.md)  }\>

Object containing:
         - Target chain hash of the request redemption transaction
           (for example, Ethereum transaction hash)
         - Bitcoin public key of the wallet asked to handle the redemption.
           Presented in the compressed form (33 bytes long with 02 or 03 prefix).

#### Defined in

[services/redemptions/redemptions-service.ts:70](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L70)

___

### requestRedemptionWithProxy

▸ **requestRedemptionWithProxy**(`bitcoinRedeemerAddress`, `amount`, `redeemerProxy`): `Promise`\<\{ `targetChainTxHash`: [`Hex`](Hex.md) ; `walletPublicKey`: [`Hex`](Hex.md)  }\>

Requests a redemption of TBTC v2 token into BTC using a custom integration.
The function builds the redemption data and handles the redemption request
through the provided redeemer proxy.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `bitcoinRedeemerAddress` | `string` | Bitcoin address the redeemed BTC should be sent to. Only P2PKH, P2WPKH, P2SH, and P2WSH address types are supported. |
| `amount` | `BigNumberish` | The amount to be redeemed with the precision of the tBTC on-chain token contract. |
| `redeemerProxy` | [`RedeemerProxy`](../interfaces/RedeemerProxy.md) | Object impleenting functions required to route tBTC redemption requests through the tBTC bridge. |

#### Returns

`Promise`\<\{ `targetChainTxHash`: [`Hex`](Hex.md) ; `walletPublicKey`: [`Hex`](Hex.md)  }\>

Object containing:
         - Target chain hash of the request redemption transaction
           (for example, Ethereum transaction hash)
         - Bitcoin public key of the wallet asked to handle the redemption.
           Presented in the compressed form (33 bytes long with 02 or 03 prefix).

#### Defined in

[services/redemptions/redemptions-service.ts:136](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L136)
