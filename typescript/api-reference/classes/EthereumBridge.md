# Class: EthereumBridge

Implementation of the Ethereum Bridge handle.

**`See`**

for reference.

## Hierarchy

- `EthersContractHandle`\<`BridgeTypechain`\>

  ↳ **`EthereumBridge`**

## Implements

- [`Bridge`](../interfaces/Bridge.md)

## Table of contents

### Constructors

- [constructor](EthereumBridge.md#constructor)

### Properties

- [\_deployedAtBlockNumber](EthereumBridge.md#_deployedatblocknumber)
- [\_instance](EthereumBridge.md#_instance)
- [\_totalRetryAttempts](EthereumBridge.md#_totalretryattempts)

### Methods

- [activeWalletID](EthereumBridge.md#activewalletid)
- [activeWalletPublicKey](EthereumBridge.md#activewalletpublickey)
- [activeWalletPublicKeyHash](EthereumBridge.md#activewalletpublickeyhash)
- [bridgeV2CompatibilityContract](EthereumBridge.md#bridgev2compatibilitycontract)
- [buildUtxoHash](EthereumBridge.md#buildutxohash)
- [deposits](EthereumBridge.md#deposits)
- [getAddress](EthereumBridge.md#getaddress)
- [getChainIdentifier](EthereumBridge.md#getchainidentifier)
- [getDepositRevealedEvents](EthereumBridge.md#getdepositrevealedevents)
- [getEvents](EthereumBridge.md#getevents)
- [getNewWalletRegisteredEvents](EthereumBridge.md#getnewwalletregisteredevents)
- [getRedemptionRequestedEvents](EthereumBridge.md#getredemptionrequestedevents)
- [getTaprootDepositRevealedEvents](EthereumBridge.md#gettaprootdepositrevealedevents)
- [getWalletCompressedPublicKey](EthereumBridge.md#getwalletcompressedpublickey)
- [parseDepositRequest](EthereumBridge.md#parsedepositrequest)
- [parseRedemptionRequest](EthereumBridge.md#parseredemptionrequest)
- [parseWalletDetails](EthereumBridge.md#parsewalletdetails)
- [pendingRedemptions](EthereumBridge.md#pendingredemptions)
- [pendingRedemptionsByWalletPKH](EthereumBridge.md#pendingredemptionsbywalletpkh)
- [requestRedemption](EthereumBridge.md#requestredemption)
- [resolveWalletPublicKey](EthereumBridge.md#resolvewalletpublickey)
- [revealDeposit](EthereumBridge.md#revealdeposit)
- [submitDepositSweepProof](EthereumBridge.md#submitdepositsweepproof)
- [submitRedemptionProof](EthereumBridge.md#submitredemptionproof)
- [taprootDepositRevealContract](EthereumBridge.md#taprootdepositrevealcontract)
- [timedOutRedemptions](EthereumBridge.md#timedoutredemptions)
- [txProofDifficultyFactor](EthereumBridge.md#txproofdifficultyfactor)
- [walletID](EthereumBridge.md#walletid)
- [walletPublicKeyHashForWalletID](EthereumBridge.md#walletpublickeyhashforwalletid)
- [walletRegistry](EthereumBridge.md#walletregistry)
- [wallets](EthereumBridge.md#wallets)
- [walletsByWalletID](EthereumBridge.md#walletsbywalletid)
- [buildDepositKey](EthereumBridge.md#builddepositkey)
- [buildRedemptionKey](EthereumBridge.md#buildredemptionkey)
- [compareEventsByChainOrder](EthereumBridge.md#compareeventsbychainorder)
- [ensureBridgeV2CompatibilityFallback](EthereumBridge.md#ensurebridgev2compatibilityfallback)
- [isMissingBridgeV2CompatibilityMethodError](EthereumBridge.md#ismissingbridgev2compatibilitymethoderror)
- [parseLegacyNewWalletRegisteredEvent](EthereumBridge.md#parselegacynewwalletregisteredevent)
- [parseV2NewWalletRegisteredEvent](EthereumBridge.md#parsev2newwalletregisteredevent)
- [walletRegistrationFilterArgs](EthereumBridge.md#walletregistrationfilterargs)

## Constructors

### constructor

• **new EthereumBridge**(`config`, `chainId?`): [`EthereumBridge`](EthereumBridge.md)

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `config` | [`EthereumContractConfig`](../interfaces/EthereumContractConfig.md) | `undefined` |
| `chainId` | [`Ethereum`](../enums/Chains.Ethereum.md) | `Chains.Ethereum.Local` |

#### Returns

[`EthereumBridge`](EthereumBridge.md)

#### Overrides

EthersContractHandle\&lt;BridgeTypechain\&gt;.constructor

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:204](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L204)

## Properties

### \_deployedAtBlockNumber

• `Protected` `Readonly` **\_deployedAtBlockNumber**: `number`

Number of a block within which the contract was deployed. Value is read from
the contract deployment artifact. It can be overwritten by setting a
[EthersContractConfig.deployedAtBlockNumber](../interfaces/EthereumContractConfig.md#deployedatblocknumber) property.

#### Inherited from

EthersContractHandle.\_deployedAtBlockNumber

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/adapter.ts:80](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L80)

___

### \_instance

• `Protected` `Readonly` **\_instance**: `Bridge`

Ethers instance of the deployed contract.

#### Inherited from

EthersContractHandle.\_instance

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/adapter.ts:74](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L74)

___

### \_totalRetryAttempts

• `Protected` `Readonly` **\_totalRetryAttempts**: `number`

Number of retries for ethereum requests.

#### Inherited from

EthersContractHandle.\_totalRetryAttempts

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/adapter.ts:84](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L84)

## Methods

### activeWalletID

▸ **activeWalletID**(): `Promise`\<`undefined` \| [`Hex`](Hex.md)\>

#### Returns

`Promise`\<`undefined` \| [`Hex`](Hex.md)\>

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[activeWalletID](../interfaces/Bridge.md#activewalletid)

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:780](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L780)

___

### activeWalletPublicKey

▸ **activeWalletPublicKey**(): `Promise`\<`undefined` \| [`Hex`](Hex.md)\>

#### Returns

`Promise`\<`undefined` \| [`Hex`](Hex.md)\>

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[activeWalletPublicKey](../interfaces/Bridge.md#activewalletpublickey)

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:764](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L764)

___

### activeWalletPublicKeyHash

▸ **activeWalletPublicKeyHash**(): `Promise`\<`undefined` \| [`Hex`](Hex.md)\>

#### Returns

`Promise`\<`undefined` \| [`Hex`](Hex.md)\>

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[activeWalletPublicKeyHash](../interfaces/Bridge.md#activewalletpublickeyhash)

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:743](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L743)

___

### bridgeV2CompatibilityContract

▸ **bridgeV2CompatibilityContract**(): `Contract`

#### Returns

`Contract`

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:239](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L239)

___

### buildUtxoHash

▸ **buildUtxoHash**(`utxo`): [`Hex`](Hex.md)

Builds the UTXO hash based on the UTXO components. UTXO hash is computed as
`keccak256(txHash | txOutputIndex | txOutputValue)`.

#### Parameters

| Name | Type |
| :------ | :------ |
| `utxo` | [`BitcoinUtxo`](../README.md#bitcoinutxo) |

#### Returns

[`Hex`](Hex.md)

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[buildUtxoHash](../interfaces/Bridge.md#buildutxohash)

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:1189](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L1189)

___

### deposits

▸ **deposits**(`depositTxHash`, `depositOutputIndex`): `Promise`\<[`DepositRequest`](../interfaces/DepositRequest.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `depositTxHash` | [`BitcoinTxHash`](BitcoinTxHash.md) |
| `depositOutputIndex` | `number` |

#### Returns

`Promise`\<[`DepositRequest`](../interfaces/DepositRequest.md)\>

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[deposits](../interfaces/Bridge.md#deposits)

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:678](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L678)

___

### getAddress

▸ **getAddress**(): [`EthereumAddress`](EthereumAddress.md)

Get address of the contract instance.

#### Returns

[`EthereumAddress`](EthereumAddress.md)

Address of this contract instance.

#### Inherited from

EthersContractHandle.getAddress

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/adapter.ts:112](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L112)

___

### getChainIdentifier

▸ **getChainIdentifier**(): [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

#### Returns

[`ChainIdentifier`](../interfaces/ChainIdentifier.md)

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[getChainIdentifier](../interfaces/Bridge.md#getchainidentifier)

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:231](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L231)

___

### getDepositRevealedEvents

▸ **getDepositRevealedEvents**(`options?`, `...filterArgs`): `Promise`\<[`DepositRevealedEvent`](../README.md#depositrevealedevent)[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `options?` | [`Options`](../interfaces/GetChainEvents.Options.md) |
| `...filterArgs` | `unknown`[] |

#### Returns

`Promise`\<[`DepositRevealedEvent`](../README.md#depositrevealedevent)[]\>

**`See`**

#### Implementation of

Bridge.getDepositRevealedEvents

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:251](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L251)

___

### getEvents

▸ **getEvents**(`eventName`, `options?`, `...filterArgs`): `Promise`\<`Event`[]\>

Get events emitted by the Ethereum contract.
It starts searching from provided block number. If the GetEvents.Options#fromBlock
option is missing it looks for a contract's defined property
[_deployedAtBlockNumber](BaseBitcoinDepositor.md#_deployedatblocknumber). If the property is missing starts searching
from block `0`.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `eventName` | `string` | Name of the event. |
| `options?` | [`Options`](../interfaces/GetChainEvents.Options.md) | Options for events fetching. |
| `...filterArgs` | `unknown`[] | Arguments for events filtering. |

#### Returns

`Promise`\<`Event`[]\>

Array of found events.

#### Inherited from

EthersContractHandle.getEvents

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/adapter.ts:127](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L127)

___

### getNewWalletRegisteredEvents

▸ **getNewWalletRegisteredEvents**(`options?`, `...filterArgs`): `Promise`\<[`NewWalletRegisteredEvent`](../README.md#newwalletregisteredevent)[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `options?` | [`Options`](../interfaces/GetChainEvents.Options.md) |
| `...filterArgs` | `unknown`[] |

#### Returns

`Promise`\<[`NewWalletRegisteredEvent`](../README.md#newwalletregisteredevent)[]\>

**`See`**

#### Implementation of

Bridge.getNewWalletRegisteredEvents

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:861](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L861)

___

### getRedemptionRequestedEvents

▸ **getRedemptionRequestedEvents**(`options?`, `...filterArgs`): `Promise`\<[`RedemptionRequestedEvent`](../README.md#redemptionrequestedevent)[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `options?` | [`Options`](../interfaces/GetChainEvents.Options.md) |
| `...filterArgs` | `unknown`[] |

#### Returns

`Promise`\<[`RedemptionRequestedEvent`](../README.md#redemptionrequestedevent)[]\>

**`See`**

#### Implementation of

Bridge.getRedemptionRequestedEvents

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:1206](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L1206)

___

### getTaprootDepositRevealedEvents

▸ **getTaprootDepositRevealedEvents**(`options?`, `...filterArgs`): `Promise`\<[`TaprootDepositRevealedEvent`](../README.md#taprootdepositrevealedevent)[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `options?` | [`Options`](../interfaces/GetChainEvents.Options.md) |
| `...filterArgs` | `unknown`[] |

#### Returns

`Promise`\<[`TaprootDepositRevealedEvent`](../README.md#taprootdepositrevealedevent)[]\>

**`See`**

#### Implementation of

Bridge.getTaprootDepositRevealedEvents

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:288](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L288)

___

### getWalletCompressedPublicKey

▸ **getWalletCompressedPublicKey**(`ecdsaWalletID`): `Promise`\<`undefined` \| [`Hex`](Hex.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `ecdsaWalletID` | [`Hex`](Hex.md) |

#### Returns

`Promise`\<`undefined` \| [`Hex`](Hex.md)\>

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:835](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L835)

___

### parseDepositRequest

▸ **parseDepositRequest**(`deposit`): [`DepositRequest`](../interfaces/DepositRequest.md)

Parses a deposit request using data fetched from the on-chain contract.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `deposit` | `DepositRequestStructOutput` | Data of the deposit request. |

#### Returns

[`DepositRequest`](../interfaces/DepositRequest.md)

Parsed deposit request.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:723](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L723)

___

### parseRedemptionRequest

▸ **parseRedemptionRequest**(`request`, `redeemerOutputScript`): [`RedemptionRequest`](../interfaces/RedemptionRequest.md)

Parses a redemption request using data fetched from the on-chain contract.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `request` | `RedemptionRequestStructOutput` | Data of the request. |
| `redeemerOutputScript` | [`Hex`](Hex.md) | The redeemer output script that identifies the pending redemption (along with the wallet public key hash). Must not be prepended with length. |

#### Returns

[`RedemptionRequest`](../interfaces/RedemptionRequest.md)

Parsed redemption request.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:434](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L434)

___

### parseWalletDetails

▸ **parseWalletDetails**(`wallet`, `walletID?`, `walletPublicKeyHash?`): `Promise`\<[`Wallet`](../interfaces/Wallet.md)\>

Parses a wallet data using data fetched from the on-chain contract.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `wallet` | `WalletStructOutput` | Data of the wallet. |
| `walletID?` | [`Hex`](Hex.md) | Optional canonical wallet identifier. When provided, the legacy `walletPublicKeyHash` field is overridden with the canonical mapping lookup derived from this ID. |
| `walletPublicKeyHash?` | [`Hex`](Hex.md) | Optional wallet public key hash, threaded through for the FROST public-key synthesis legacy-alias guard. |

#### Returns

`Promise`\<[`Wallet`](../interfaces/Wallet.md)\>

Parsed wallet data.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:1153](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L1153)

___

### pendingRedemptions

▸ **pendingRedemptions**(`walletPublicKey`, `redeemerOutputScript`): `Promise`\<[`RedemptionRequest`](../interfaces/RedemptionRequest.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `walletPublicKey` | [`Hex`](Hex.md) |
| `redeemerOutputScript` | [`Hex`](Hex.md) |

#### Returns

`Promise`\<[`RedemptionRequest`](../interfaces/RedemptionRequest.md)\>

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[pendingRedemptions](../interfaces/Bridge.md#pendingredemptions)

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:337](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L337)

___

### pendingRedemptionsByWalletPKH

▸ **pendingRedemptionsByWalletPKH**(`walletPublicKeyHash`, `redeemerOutputScript`): `Promise`\<[`RedemptionRequest`](../interfaces/RedemptionRequest.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `walletPublicKeyHash` | [`Hex`](Hex.md) |
| `redeemerOutputScript` | [`Hex`](Hex.md) |

#### Returns

`Promise`\<[`RedemptionRequest`](../interfaces/RedemptionRequest.md)\>

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[pendingRedemptionsByWalletPKH](../interfaces/Bridge.md#pendingredemptionsbywalletpkh)

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:353](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L353)

___

### requestRedemption

▸ **requestRedemption**(`walletPublicKey`, `mainUtxo`, `redeemerOutputScript`, `amount`): `Promise`\<[`Hex`](Hex.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `walletPublicKey` | [`Hex`](Hex.md) |
| `mainUtxo` | [`BitcoinUtxo`](../README.md#bitcoinutxo) |
| `redeemerOutputScript` | [`Hex`](Hex.md) |
| `amount` | `BigNumber` |

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[requestRedemption](../interfaces/Bridge.md#requestredemption)

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:579](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L579)

___

### resolveWalletPublicKey

▸ **resolveWalletPublicKey**(`ecdsaWalletID`, `walletID?`, `walletPublicKeyHash?`): `Promise`\<`undefined` \| [`Hex`](Hex.md)\>

Resolves a wallet's compressed public key. ECDSA wallets expose it via the
ECDSA wallet registry; FROST wallets (zero `ecdsaWalletID`) carry their
Taproot x-only key as the native `walletID`, which is synthesized into a
compressed compatibility key (the same way redemption wallet selection does)
so legacy callers such as `activeWalletPublicKey()` still get a key after
FROST activation.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `ecdsaWalletID` | [`Hex`](Hex.md) | The wallet's ECDSA wallet ID (zero for FROST wallets). |
| `walletID?` | [`Hex`](Hex.md) | The wallet's native wallet ID, if known. |
| `walletPublicKeyHash?` | [`Hex`](Hex.md) | The wallet public key hash, when available; it enables the exact legacy-alias guard in the FROST synthesis. |

#### Returns

`Promise`\<`undefined` \| [`Hex`](Hex.md)\>

The compressed wallet public key, or undefined when unavailable.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:1120](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L1120)

___

### revealDeposit

▸ **revealDeposit**(`depositTx`, `depositOutputIndex`, `deposit`, `vault?`): `Promise`\<[`Hex`](Hex.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `depositTx` | [`BitcoinRawTxVectors`](../interfaces/BitcoinRawTxVectors.md) |
| `depositOutputIndex` | `number` |
| `deposit` | [`DepositReceipt`](../interfaces/DepositReceipt.md) |
| `vault?` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) |

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[revealDeposit](../interfaces/Bridge.md#revealdeposit)

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:452](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L452)

___

### submitDepositSweepProof

▸ **submitDepositSweepProof**(`sweepTx`, `sweepProof`, `mainUtxo`, `vault?`): `Promise`\<[`Hex`](Hex.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `sweepTx` | [`BitcoinRawTxVectors`](../interfaces/BitcoinRawTxVectors.md) |
| `sweepProof` | [`BitcoinSpvProof`](../interfaces/BitcoinSpvProof.md) |
| `mainUtxo` | [`BitcoinUtxo`](../README.md#bitcoinutxo) |
| `vault?` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) |

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[submitDepositSweepProof](../interfaces/Bridge.md#submitdepositsweepproof)

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:513](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L513)

___

### submitRedemptionProof

▸ **submitRedemptionProof**(`redemptionTx`, `redemptionProof`, `mainUtxo`, `walletPublicKey`): `Promise`\<[`Hex`](Hex.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `redemptionTx` | [`BitcoinRawTxVectors`](../interfaces/BitcoinRawTxVectors.md) |
| `redemptionProof` | [`BitcoinSpvProof`](../interfaces/BitcoinSpvProof.md) |
| `mainUtxo` | [`BitcoinUtxo`](../README.md#bitcoinutxo) |
| `walletPublicKey` | [`Hex`](Hex.md) |

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[submitRedemptionProof](../interfaces/Bridge.md#submitredemptionproof)

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:625](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L625)

___

### taprootDepositRevealContract

▸ **taprootDepositRevealContract**(): `Contract`

#### Returns

`Contract`

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:235](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L235)

___

### timedOutRedemptions

▸ **timedOutRedemptions**(`walletPublicKey`, `redeemerOutputScript`): `Promise`\<[`RedemptionRequest`](../interfaces/RedemptionRequest.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `walletPublicKey` | [`Hex`](Hex.md) |
| `redeemerOutputScript` | [`Hex`](Hex.md) |

#### Returns

`Promise`\<[`RedemptionRequest`](../interfaces/RedemptionRequest.md)\>

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[timedOutRedemptions](../interfaces/Bridge.md#timedoutredemptions)

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:376](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L376)

___

### txProofDifficultyFactor

▸ **txProofDifficultyFactor**(): `Promise`\<`number`\>

#### Returns

`Promise`\<`number`\>

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[txProofDifficultyFactor](../interfaces/Bridge.md#txproofdifficultyfactor)

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:565](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L565)

___

### walletID

▸ **walletID**(`walletPublicKeyHash`): `Promise`\<[`Hex`](Hex.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `walletPublicKeyHash` | [`Hex`](Hex.md) |

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[walletID](../interfaces/Bridge.md#walletid)

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:1001](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L1001)

___

### walletPublicKeyHashForWalletID

▸ **walletPublicKeyHashForWalletID**(`walletID`): `Promise`\<[`Hex`](Hex.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `walletID` | [`Hex`](Hex.md) |

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[walletPublicKeyHashForWalletID](../interfaces/Bridge.md#walletpublickeyhashforwalletid)

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:1042](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L1042)

___

### walletRegistry

▸ **walletRegistry**(): `Promise`\<[`WalletRegistry`](../interfaces/WalletRegistry.md)\>

#### Returns

`Promise`\<[`WalletRegistry`](../interfaces/WalletRegistry.md)\>

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[walletRegistry](../interfaces/Bridge.md#walletregistry)

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:937](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L937)

___

### wallets

▸ **wallets**(`walletPublicKeyHash`): `Promise`\<[`Wallet`](../interfaces/Wallet.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `walletPublicKeyHash` | [`Hex`](Hex.md) |

#### Returns

`Promise`\<[`Wallet`](../interfaces/Wallet.md)\>

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[wallets](../interfaces/Bridge.md#wallets)

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:954](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L954)

___

### walletsByWalletID

▸ **walletsByWalletID**(`walletID`): `Promise`\<[`Wallet`](../interfaces/Wallet.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `walletID` | [`Hex`](Hex.md) |

#### Returns

`Promise`\<[`Wallet`](../interfaces/Wallet.md)\>

**`See`**

#### Implementation of

[Bridge](../interfaces/Bridge.md).[walletsByWalletID](../interfaces/Bridge.md#walletsbywalletid)

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:972](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L972)

___

### buildDepositKey

▸ **buildDepositKey**(`depositTxHash`, `depositOutputIndex`): `string`

Builds the deposit key required to refer a revealed deposit.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositTxHash` | [`BitcoinTxHash`](BitcoinTxHash.md) | The revealed deposit transaction's hash. |
| `depositOutputIndex` | `number` | Index of the deposit transaction output that funds the revealed deposit. |

#### Returns

`string`

Deposit key.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:704](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L704)

___

### buildRedemptionKey

▸ **buildRedemptionKey**(`walletPublicKeyHash`, `redeemerOutputScript`): `string`

Builds a redemption key required to refer a redemption request.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `walletPublicKeyHash` | [`Hex`](Hex.md) | The wallet public key hash that identifies the pending redemption (along with the redeemer output script). |
| `redeemerOutputScript` | [`Hex`](Hex.md) | The redeemer output script that identifies the pending redemption (along with the wallet public key hash). Must not be prepended with length. |

#### Returns

`string`

The redemption key.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:404](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L404)

___

### compareEventsByChainOrder

▸ **compareEventsByChainOrder**(`left`, `right`): `number`

#### Parameters

| Name | Type |
| :------ | :------ |
| `left` | `Event` |
| `right` | `Event` |

#### Returns

`number`

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:164](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L164)

___

### ensureBridgeV2CompatibilityFallback

▸ **ensureBridgeV2CompatibilityFallback**(`error`, `methodName`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `error` | `unknown` |
| `methodName` | `string` |

#### Returns

`void`

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:82](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L82)

___

### isMissingBridgeV2CompatibilityMethodError

▸ **isMissingBridgeV2CompatibilityMethodError**(`error`): `boolean`

#### Parameters

| Name | Type |
| :------ | :------ |
| `error` | `unknown` |

#### Returns

`boolean`

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:96](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L96)

___

### parseLegacyNewWalletRegisteredEvent

▸ **parseLegacyNewWalletRegisteredEvent**(`event`): [`NewWalletRegisteredEvent`](../README.md#newwalletregisteredevent)

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | `Event` |

#### Returns

[`NewWalletRegisteredEvent`](../README.md#newwalletregisteredevent)

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:175](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L175)

___

### parseV2NewWalletRegisteredEvent

▸ **parseV2NewWalletRegisteredEvent**(`event`): [`NewWalletRegisteredEvent`](../README.md#newwalletregisteredevent)

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | `Event` |

#### Returns

[`NewWalletRegisteredEvent`](../README.md#newwalletregisteredevent)

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:191](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L191)

___

### walletRegistrationFilterArgs

▸ **walletRegistrationFilterArgs**(`filterArgs`): `Object`

#### Parameters

| Name | Type |
| :------ | :------ |
| `filterArgs` | `unknown`[] |

#### Returns

`Object`

| Name | Type |
| :------ | :------ |
| `legacyFilterArgs` | `unknown`[] |
| `skipLegacy` | `boolean` |
| `v2FilterArgs` | `unknown`[] |

#### Defined in

[tbtc-v2-m993/typescript/src/lib/ethereum/bridge.ts:127](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L127)
