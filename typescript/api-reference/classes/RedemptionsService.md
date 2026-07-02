# Class: RedemptionsService

Service exposing features related to tBTC v2 redemptions.

## Table of contents

### Constructors

- [constructor](RedemptionsService.md#constructor)

### Properties

- [#crossChainContracts](RedemptionsService.md##crosschaincontracts)
- [bitcoinClient](RedemptionsService.md#bitcoinclient)
- [tbtcContracts](RedemptionsService.md#tbtccontracts)
- [ZeroBytes32](RedemptionsService.md#zerobytes32)

### Methods

- [chunkArray](RedemptionsService.md#chunkarray)
- [determineRedemptionData](RedemptionsService.md#determineredemptiondata)
- [determineValidRedemptionWallet](RedemptionsService.md#determinevalidredemptionwallet)
- [determineWalletMainUtxo](RedemptionsService.md#determinewalletmainutxo)
- [fetchWalletsForRedemption](RedemptionsService.md#fetchwalletsforredemption)
- [findWalletForRedemption](RedemptionsService.md#findwalletforredemption)
- [fromSerializableWallet](RedemptionsService.md#fromserializablewallet)
- [frostWalletID](RedemptionsService.md#frostwalletid)
- [getRedeemerOutputScript](RedemptionsService.md#getredeemeroutputscript)
- [getRedemptionRequests](RedemptionsService.md#getredemptionrequests)
- [isFrostWallet](RedemptionsService.md#isfrostwallet)
- [redemptionWalletIdentityFromCandidate](RedemptionsService.md#redemptionwalletidentityfromcandidate)
- [redemptionWalletPublicKey](RedemptionsService.md#redemptionwalletpublickey)
- [relayRedemptionRequestToL1](RedemptionsService.md#relayredemptionrequesttol1)
- [requestCrossChainRedemption](RedemptionsService.md#requestcrosschainredemption)
- [requestRedemption](RedemptionsService.md#requestredemption)
- [requestRedemptionWithProxy](RedemptionsService.md#requestredemptionwithproxy)
- [resolveRedeemerOutputScript](RedemptionsService.md#resolveredeemeroutputscript)
- [setCrossChainContractsResolver](RedemptionsService.md#setcrosschaincontractsresolver)

## Constructors

### constructor

• **new RedemptionsService**(`tbtcContracts`, `bitcoinClient`, `crossChainContracts?`): [`RedemptionsService`](RedemptionsService.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `tbtcContracts` | [`TBTCContracts`](../README.md#tbtccontracts) |
| `bitcoinClient` | [`BitcoinClient`](../interfaces/BitcoinClient.md) |
| `crossChainContracts?` | (`_`: [`DestinationChainName`](../README.md#destinationchainname)) => `undefined` \| [`CrossChainInterfaces`](../README.md#crosschaininterfaces) |

#### Returns

[`RedemptionsService`](RedemptionsService.md)

#### Defined in

[src/services/redemptions/redemptions-service.ts:55](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L55)

## Properties

### #crossChainContracts

• `Private` **#crossChainContracts**: (`_`: [`DestinationChainName`](../README.md#destinationchainname)) => `undefined` \| [`CrossChainInterfaces`](../README.md#crosschaininterfaces)

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

[src/services/redemptions/redemptions-service.ts:53](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L53)

___

### bitcoinClient

• `Private` `Readonly` **bitcoinClient**: [`BitcoinClient`](../interfaces/BitcoinClient.md)

Bitcoin client handle.

#### Defined in

[src/services/redemptions/redemptions-service.ts:46](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L46)

___

### tbtcContracts

• `Private` `Readonly` **tbtcContracts**: [`TBTCContracts`](../README.md#tbtccontracts)

Handle to tBTC contracts.

#### Defined in

[src/services/redemptions/redemptions-service.ts:42](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L42)

___

### ZeroBytes32

▪ `Static` `Private` `Readonly` **ZeroBytes32**: [`Hex`](Hex.md)

#### Defined in

[src/services/redemptions/redemptions-service.ts:35](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L35)

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

[src/services/redemptions/redemptions-service.ts:678](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L678)

___

### determineRedemptionData

▸ **determineRedemptionData**(`bitcoinRedeemerAddress`, `amount`): `Promise`\<\{ `mainUtxo`: [`BitcoinUtxo`](../README.md#bitcoinutxo) ; `redeemerOutputScript`: [`Hex`](Hex.md) ; `walletPublicKey`: [`Hex`](Hex.md)  }\>

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `bitcoinRedeemerAddress` | `string` | Bitcoin address redeemed BTC should be sent to. Only P2PKH, P2WPKH, P2SH, P2WSH, and P2TR address types are supported. |
| `amount` | `BigNumber` | The amount to be redeemed with the precision of the tBTC on-chain token contract. |

#### Returns

`Promise`\<\{ `mainUtxo`: [`BitcoinUtxo`](../README.md#bitcoinutxo) ; `redeemerOutputScript`: [`Hex`](Hex.md) ; `walletPublicKey`: [`Hex`](Hex.md)  }\>

Object containing:
         - Bitcoin public key of the wallet asked to handle the redemption.
           Presented in the compressed form (33 bytes long with 02 or 03 prefix).
         - Main UTXO of the wallet.
         - Redeemer output script.

#### Defined in

[src/services/redemptions/redemptions-service.ts:325](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L325)

___

### determineValidRedemptionWallet

▸ **determineValidRedemptionWallet**(`amount`, `potentialCandidateWallets`, `redeemerAddressOrScript?`): `Promise`\<[`RedemptionWallet`](../interfaces/RedemptionWallet.md)\>

Determines a valid wallet that can handle a redemption request.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `amount` | `BigNumber` | The amount to be redeemed in satoshi precision (1e8). |
| `potentialCandidateWallets` | [`SerializableWallet`](../interfaces/SerializableWallet.md)[] | Array of wallets that can handle the redemption request. The wallets must be in the Live state. |
| `redeemerAddressOrScript?` | `string` | Optional. Either a Bitcoin address (P2PKH, P2WPKH, P2SH, P2WSH, P2TR) or a raw hex output script (with or without 0x prefix). When provided, the function checks for pending redemptions to avoid wallet collisions. - If the input matches /^(0x)?[0-9a-fA-F]+$/, it's treated as a raw hex output script and used directly. - Otherwise, it's treated as a Bitcoin address and converted to an output script. |

#### Returns

`Promise`\<[`RedemptionWallet`](../interfaces/RedemptionWallet.md)\>

Object containing:
         - Bitcoin public key of the wallet asked to handle the redemption.
           Presented in the compressed form (33 bytes long with 02 or 03 prefix).
         - Main UTXO of the wallet.
         - Redeemer output script (if provided).

**`Throws`**

Throws an error if no valid redemption wallet exists for the given
        input parameters.

#### Defined in

[src/services/redemptions/redemptions-service.ts:369](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L369)

___

### determineWalletMainUtxo

▸ **determineWalletMainUtxo**(`walletPublicKeyHash`, `bitcoinNetwork`, `taprootWalletID?`): `Promise`\<`undefined` \| [`BitcoinUtxo`](../README.md#bitcoinutxo)\>

Determines the plain-text wallet main UTXO currently registered in the
Bridge on-chain contract. The returned main UTXO can be undefined if the
wallet does not have a main UTXO registered in the Bridge at the moment.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `walletPublicKeyHash` | [`Hex`](Hex.md) | Public key hash of the wallet. |
| `bitcoinNetwork` | [`BitcoinNetwork`](../enums/BitcoinNetwork-1.md) | Bitcoin network. |
| `taprootWalletID?` | [`Hex`](Hex.md) | Optional 32-byte x-only FROST wallet ID. When present, P2TR wallet history is scanned as well. |

#### Returns

`Promise`\<`undefined` \| [`BitcoinUtxo`](../README.md#bitcoinutxo)\>

Promise holding the wallet main UTXO or undefined value.

#### Defined in

[src/services/redemptions/redemptions-service.ts:760](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L760)

___

### fetchWalletsForRedemption

▸ **fetchWalletsForRedemption**(): `Promise`\<[`SerializableWallet`](../interfaces/SerializableWallet.md)[]\>

Fetches all wallets that are currently live and can handle a redemption
request.

#### Returns

`Promise`\<[`SerializableWallet`](../interfaces/SerializableWallet.md)[]\>

Array of wallet events.

#### Defined in

[src/services/redemptions/redemptions-service.ts:952](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L952)

___

### findWalletForRedemption

▸ **findWalletForRedemption**(`amount`, `redeemerOutputScript?`, `concurrencyLimit?`): `Promise`\<\{ `mainUtxo`: [`BitcoinUtxo`](../README.md#bitcoinutxo) ; `walletPublicKey`: [`Hex`](Hex.md)  }\>

Finds the oldest live wallet that has enough BTC to handle a redemption
request.

#### Parameters

| Name | Type | Default value | Description |
| :------ | :------ | :------ | :------ |
| `amount` | `BigNumber` | `undefined` | The amount to be redeemed in satoshis. |
| `redeemerOutputScript?` | [`Hex`](Hex.md) | `undefined` | The redeemer output script the redeemed funds are supposed to be locked on. Must not be prepended with length. |
| `concurrencyLimit` | `number` | `50` | Maximum number of wallets to process concurrently. Defaults to 50. |

#### Returns

`Promise`\<\{ `mainUtxo`: [`BitcoinUtxo`](../README.md#bitcoinutxo) ; `walletPublicKey`: [`Hex`](Hex.md)  }\>

Promise with the wallet details needed to request a redemption.

#### Defined in

[src/services/redemptions/redemptions-service.ts:528](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L528)

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

[src/services/redemptions/redemptions-service.ts:1041](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L1041)

___

### frostWalletID

▸ **frostWalletID**(`wallet`, `walletPublicKeyHash`): `undefined` \| [`Hex`](Hex.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `wallet` | [`Wallet`](../interfaces/Wallet.md) |
| `walletPublicKeyHash` | [`Hex`](Hex.md) |

#### Returns

`undefined` \| [`Hex`](Hex.md)

#### Defined in

[src/services/redemptions/redemptions-service.ts:729](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L729)

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

[src/services/redemptions/redemptions-service.ts:977](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L977)

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

[src/services/redemptions/redemptions-service.ts:910](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L910)

___

### isFrostWallet

▸ **isFrostWallet**(`wallet`): `boolean`

#### Parameters

| Name | Type |
| :------ | :------ |
| `wallet` | [`Wallet`](../interfaces/Wallet.md) |

#### Returns

`boolean`

#### Defined in

[src/services/redemptions/redemptions-service.ts:743](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L743)

___

### redemptionWalletIdentityFromCandidate

▸ **redemptionWalletIdentityFromCandidate**(`walletKey`): `Object`

#### Parameters

| Name | Type |
| :------ | :------ |
| `walletKey` | [`Hex`](Hex.md) |

#### Returns

`Object`

| Name | Type |
| :------ | :------ |
| `walletID?` | [`Hex`](Hex.md) |
| `walletPublicKey` | [`Hex`](Hex.md) |
| `walletPublicKeyHash` | [`Hex`](Hex.md) |

#### Defined in

[src/services/redemptions/redemptions-service.ts:689](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L689)

___

### redemptionWalletPublicKey

▸ **redemptionWalletPublicKey**(`wallet`, `walletPublicKeyHash`): `undefined` \| [`Hex`](Hex.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `wallet` | [`Wallet`](../interfaces/Wallet.md) |
| `walletPublicKeyHash` | [`Hex`](Hex.md) |

#### Returns

`undefined` \| [`Hex`](Hex.md)

#### Defined in

[src/services/redemptions/redemptions-service.ts:713](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L713)

___

### relayRedemptionRequestToL1

▸ **relayRedemptionRequestToL1**(`amount`, `encodedVm`, `l2ChainName`, `redeemerOutputScript`): `Promise`\<\{ `targetChainTxHash`: [`Hex`](Hex.md)  }\>

Relays a redemption request from L2 to L1.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `amount` | `BigNumber` | The amount to be redeemed with TBTC token precision (1e18). |
| `encodedVm` | `BytesLike` | The encoded Wormhole VAA message from the L2 chain. |
| `l2ChainName` | [`DestinationChainName`](../README.md#destinationchainname) | The name of the L2 chain originating the request. |
| `redeemerOutputScript` | `string` | The Bitcoin output script where redeemed BTC will be sent. Can be raw hex (with or without 0x prefix) representing the output script directly. |

#### Returns

`Promise`\<\{ `targetChainTxHash`: [`Hex`](Hex.md)  }\>

Object containing the target chain transaction hash.

**`Throws`**

Throws an error if cross-chain contracts are not initialized for
        the specified L2 chain.

**`Throws`**

Throws an error if no wallet with sufficient funds can be found.

#### Defined in

[src/services/redemptions/redemptions-service.ts:254](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L254)

___

### requestCrossChainRedemption

▸ **requestCrossChainRedemption**(`bitcoinRedeemerAddress`, `amount`, `l2ChainName`): `Promise`\<\{ `targetChainTxHash`: [`Hex`](Hex.md)  }\>

Requests a redemption of TBTC v2 token into BTC using a custom integration.
The function builds the redemption data and handles the redemption request
through the provided redeemer proxy.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `bitcoinRedeemerAddress` | `string` | Bitcoin address the redeemed BTC should be sent to. Only P2PKH, P2WPKH, P2SH, P2WSH, and P2TR address types are supported. |
| `amount` | `BigNumber` | The amount to be redeemed with the precision of the tBTC on-chain token contract. |
| `l2ChainName` | [`DestinationChainName`](../README.md#destinationchainname) | The name of the L2 chain to request redemption on. |

#### Returns

`Promise`\<\{ `targetChainTxHash`: [`Hex`](Hex.md)  }\>

Object containing:
         - Target chain hash of the request redemption transaction
           (for example, Ethereum transaction hash)

#### Defined in

[src/services/redemptions/redemptions-service.ts:210](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L210)

___

### requestRedemption

▸ **requestRedemption**(`bitcoinRedeemerAddress`, `amount`): `Promise`\<\{ `targetChainTxHash`: [`Hex`](Hex.md) ; `walletPublicKey`: [`Hex`](Hex.md)  }\>

Requests a redemption of TBTC v2 token into BTC.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `bitcoinRedeemerAddress` | `string` | Bitcoin address redeemed BTC should be sent to. Only P2PKH, P2WPKH, P2SH, P2WSH, and P2TR address types are supported. |
| `amount` | `BigNumber` | The amount to be redeemed with the precision of the tBTC on-chain token contract. |

#### Returns

`Promise`\<\{ `targetChainTxHash`: [`Hex`](Hex.md) ; `walletPublicKey`: [`Hex`](Hex.md)  }\>

Object containing:
         - Target chain hash of the request redemption transaction
           (for example, Ethereum transaction hash)
         - Bitcoin public key of the wallet asked to handle the redemption.
           Presented in the compressed form (33 bytes long with 02 or 03 prefix).

#### Defined in

[src/services/redemptions/redemptions-service.ts:92](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L92)

___

### requestRedemptionWithProxy

▸ **requestRedemptionWithProxy**(`bitcoinRedeemerAddress`, `amount`, `redeemerProxy`): `Promise`\<\{ `targetChainTxHash`: [`Hex`](Hex.md) ; `walletPublicKey`: [`Hex`](Hex.md)  }\>

Requests a redemption of TBTC v2 token into BTC using a custom integration.
The function builds the redemption data and handles the redemption request
through the provided redeemer proxy.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `bitcoinRedeemerAddress` | `string` | Bitcoin address the redeemed BTC should be sent to. Only P2PKH, P2WPKH, P2SH, P2WSH, and P2TR address types are supported. |
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

[src/services/redemptions/redemptions-service.ts:165](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L165)

___

### resolveRedeemerOutputScript

▸ **resolveRedeemerOutputScript**(`redeemerAddressOrScript`): `Promise`\<[`Hex`](Hex.md)\>

Resolves a redeemer address or script input to a Hex output script.
This method detects whether the input is a raw hex output script or a
Bitcoin address and handles each case appropriately.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `redeemerAddressOrScript` | `string` | Either a Bitcoin address (P2PKH, P2WPKH, P2SH, P2WSH, P2TR) or a raw hex output script (with or without 0x prefix). |

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

The resolved output script as a Hex object.

#### Defined in

[src/services/redemptions/redemptions-service.ts:1009](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L1009)

___

### setCrossChainContractsResolver

▸ **setCrossChainContractsResolver**(`resolver`): `void`

Sets the cross-chain contracts resolver after construction. This is
used by the TBTC class to wire up cross-chain contract resolution
once the loader is ready.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `resolver` | (`_`: [`DestinationChainName`](../README.md#destinationchainname)) => `undefined` \| [`CrossChainInterfaces`](../README.md#crosschaininterfaces) | Function that returns cross-chain contracts for a given L2 chain, or undefined if not initialized. |

#### Returns

`void`

#### Defined in

[src/services/redemptions/redemptions-service.ts:73](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/redemptions/redemptions-service.ts#L73)
