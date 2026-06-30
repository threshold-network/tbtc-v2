# Interface: Bridge

Interface for communication with the Bridge on-chain contract.

## Implemented by

- [`EthereumBridge`](../classes/EthereumBridge.md)

## Table of contents

### Properties

- [getDepositRevealedEvents](Bridge.md#getdepositrevealedevents)
- [getNewWalletRegisteredEvents](Bridge.md#getnewwalletregisteredevents)
- [getRedemptionRequestedEvents](Bridge.md#getredemptionrequestedevents)
- [getTaprootDepositRevealedEvents](Bridge.md#gettaprootdepositrevealedevents)

### Methods

- [activeWalletID](Bridge.md#activewalletid)
- [activeWalletPublicKey](Bridge.md#activewalletpublickey)
- [activeWalletPublicKeyHash](Bridge.md#activewalletpublickeyhash)
- [buildUtxoHash](Bridge.md#buildutxohash)
- [deposits](Bridge.md#deposits)
- [getChainIdentifier](Bridge.md#getchainidentifier)
- [pendingRedemptions](Bridge.md#pendingredemptions)
- [pendingRedemptionsByWalletPKH](Bridge.md#pendingredemptionsbywalletpkh)
- [requestRedemption](Bridge.md#requestredemption)
- [revealDeposit](Bridge.md#revealdeposit)
- [submitDepositSweepProof](Bridge.md#submitdepositsweepproof)
- [submitRedemptionProof](Bridge.md#submitredemptionproof)
- [timedOutRedemptions](Bridge.md#timedoutredemptions)
- [txProofDifficultyFactor](Bridge.md#txproofdifficultyfactor)
- [walletID](Bridge.md#walletid)
- [walletPublicKeyHashForWalletID](Bridge.md#walletpublickeyhashforwalletid)
- [walletRegistry](Bridge.md#walletregistry)
- [wallets](Bridge.md#wallets)
- [walletsByWalletID](Bridge.md#walletsbywalletid)

## Properties

### getDepositRevealedEvents

• **getDepositRevealedEvents**: [`Function`](GetChainEvents.Function.md)\<[`DepositRevealedEvent`](../README.md#depositrevealedevent)\>

Get emitted DepositRevealed events.

**`See`**

GetEventsFunction

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:26](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L26)

___

### getNewWalletRegisteredEvents

• **getNewWalletRegisteredEvents**: [`Function`](GetChainEvents.Function.md)\<[`NewWalletRegisteredEvent`](../README.md#newwalletregisteredevent)\>

Get emitted NewWalletRegisteredEvent events.

**`See`**

GetEventsFunction

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:182](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L182)

___

### getRedemptionRequestedEvents

• **getRedemptionRequestedEvents**: [`Function`](GetChainEvents.Function.md)\<[`RedemptionRequestedEvent`](../README.md#redemptionrequestedevent)\>

Get emitted RedemptionRequested events.

**`See`**

GetEventsFunction

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:235](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L235)

___

### getTaprootDepositRevealedEvents

• **getTaprootDepositRevealedEvents**: [`Function`](GetChainEvents.Function.md)\<[`TaprootDepositRevealedEvent`](../README.md#taprootdepositrevealedevent)\>

Get emitted TaprootDepositRevealed events.

**`See`**

GetEventsFunction

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:32](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L32)

## Methods

### activeWalletID

▸ **activeWalletID**(): `Promise`\<`undefined` \| [`Hex`](../classes/Hex.md)\>

Gets canonical wallet ID of the active wallet.

#### Returns

`Promise`\<`undefined` \| [`Hex`](../classes/Hex.md)\>

Canonical wallet ID of the active wallet, if set.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:222](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L222)

___

### activeWalletPublicKey

▸ **activeWalletPublicKey**(): `Promise`\<`undefined` \| [`Hex`](../classes/Hex.md)\>

Gets the public key of the current active wallet.

#### Returns

`Promise`\<`undefined` \| [`Hex`](../classes/Hex.md)\>

Compressed (33 bytes long with 02 or 03 prefix) active wallet's
         public key. If there is no active wallet at the moment, undefined
         is returned.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:176](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L176)

___

### activeWalletPublicKeyHash

▸ **activeWalletPublicKeyHash**(): `Promise`\<`undefined` \| [`Hex`](../classes/Hex.md)\>

Gets the public key hash of the current active wallet.

#### Returns

`Promise`\<`undefined` \| [`Hex`](../classes/Hex.md)\>

20-byte active wallet public key hash. If there is no active
         wallet at the moment, undefined is returned.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:168](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L168)

___

### buildUtxoHash

▸ **buildUtxoHash**(`utxo`): [`Hex`](../classes/Hex.md)

Builds the UTXO hash based on the UTXO components.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `utxo` | [`BitcoinUtxo`](../README.md#bitcoinutxo) | UTXO components. |

#### Returns

[`Hex`](../classes/Hex.md)

The hash of the UTXO.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:229](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L229)

___

### deposits

▸ **deposits**(`depositTxHash`, `depositOutputIndex`): `Promise`\<[`DepositRequest`](DepositRequest.md)\>

Gets a revealed deposit from the on-chain contract.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositTxHash` | [`BitcoinTxHash`](../classes/BitcoinTxHash.md) | The revealed deposit transaction's hash. |
| `depositOutputIndex` | `number` | Index of the deposit transaction output that funds the revealed deposit. |

#### Returns

`Promise`\<[`DepositRequest`](DepositRequest.md)\>

Revealed deposit data.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:74](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L74)

___

### getChainIdentifier

▸ **getChainIdentifier**(): [`ChainIdentifier`](ChainIdentifier.md)

Gets the chain-specific identifier of this contract.

#### Returns

[`ChainIdentifier`](ChainIdentifier.md)

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:20](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L20)

___

### pendingRedemptions

▸ **pendingRedemptions**(`walletPublicKey`, `redeemerOutputScript`): `Promise`\<[`RedemptionRequest`](RedemptionRequest.md)\>

Gets a pending redemption from the on-chain contract.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `walletPublicKey` | [`Hex`](../classes/Hex.md) | Bitcoin public key of the wallet the request is targeted to. Must be in the compressed form (33 bytes long with 02 or 03 prefix). |
| `redeemerOutputScript` | [`Hex`](../classes/Hex.md) | The redeemer output script the redeemed funds are supposed to be locked on. Must not be prepended with length. |

#### Returns

`Promise`\<[`RedemptionRequest`](RedemptionRequest.md)\>

Promise with the pending redemption.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:130](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L130)

___

### pendingRedemptionsByWalletPKH

▸ **pendingRedemptionsByWalletPKH**(`walletPublicKeyHash`, `redeemerOutputScript`): `Promise`\<[`RedemptionRequest`](RedemptionRequest.md)\>

Gets a pending redemption from the on-chain contract using the wallet's
public key hash instead of the plain-text public key.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `walletPublicKeyHash` | [`Hex`](../classes/Hex.md) | Bitcoin public key hash of the wallet the request is targeted to. Must be 20 bytes long. |
| `redeemerOutputScript` | [`Hex`](../classes/Hex.md) | The redeemer output script the redeemed funds are supposed to be locked on. Must not be prepended with length. |

#### Returns

`Promise`\<[`RedemptionRequest`](RedemptionRequest.md)\>

Promise with the pending redemption.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:144](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L144)

___

### requestRedemption

▸ **requestRedemption**(`walletPublicKey`, `mainUtxo`, `redeemerOutputScript`, `amount`): `Promise`\<[`Hex`](../classes/Hex.md)\>

Requests a redemption from the on-chain contract.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `walletPublicKey` | [`Hex`](../classes/Hex.md) | The Bitcoin public key of the wallet. Must be in the compressed form (33 bytes long with 02 or 03 prefix). |
| `mainUtxo` | [`BitcoinUtxo`](../README.md#bitcoinutxo) | The main UTXO of the wallet. Must match the main UTXO held by the on-chain contract. |
| `redeemerOutputScript` | [`Hex`](../classes/Hex.md) | The output script that the redeemed funds will be locked to. Must not be prepended with length. |
| `amount` | `BigNumber` | The amount to be redeemed in satoshis. |

#### Returns

`Promise`\<[`Hex`](../classes/Hex.md)\>

Transaction hash of the request redemption transaction.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:90](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L90)

___

### revealDeposit

▸ **revealDeposit**(`depositTx`, `depositOutputIndex`, `deposit`, `vault?`): `Promise`\<[`Hex`](../classes/Hex.md)\>

Reveals a given deposit to the on-chain contract.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositTx` | [`BitcoinRawTxVectors`](BitcoinRawTxVectors.md) | Deposit transaction data |
| `depositOutputIndex` | `number` | Index of the deposit transaction output that funds the revealed deposit |
| `deposit` | [`DepositReceipt`](DepositReceipt.md) | Data of the revealed deposit |
| `vault?` | [`ChainIdentifier`](ChainIdentifier.md) | Optional parameter denoting the vault the given deposit should be routed to |

#### Returns

`Promise`\<[`Hex`](../classes/Hex.md)\>

Transaction hash of the reveal deposit transaction.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:60](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L60)

___

### submitDepositSweepProof

▸ **submitDepositSweepProof**(`sweepTx`, `sweepProof`, `mainUtxo`, `vault?`): `Promise`\<[`Hex`](../classes/Hex.md)\>

Submits a deposit sweep transaction proof to the on-chain contract.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `sweepTx` | [`BitcoinRawTxVectors`](BitcoinRawTxVectors.md) | Sweep transaction data. |
| `sweepProof` | [`BitcoinSpvProof`](BitcoinSpvProof.md) | Sweep proof data. |
| `mainUtxo` | [`BitcoinUtxo`](../README.md#bitcoinutxo) | Data of the wallet's main UTXO. |
| `vault?` | [`ChainIdentifier`](ChainIdentifier.md) | Optional identifier of the vault the swept deposits should be routed in. |

#### Returns

`Promise`\<[`Hex`](../classes/Hex.md)\>

Transaction hash of the submit deposit sweep proof transaction.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:43](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L43)

___

### submitRedemptionProof

▸ **submitRedemptionProof**(`redemptionTx`, `redemptionProof`, `mainUtxo`, `walletPublicKey`): `Promise`\<[`Hex`](../classes/Hex.md)\>

Submits a redemption transaction proof to the on-chain contract.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `redemptionTx` | [`BitcoinRawTxVectors`](BitcoinRawTxVectors.md) | Redemption transaction data |
| `redemptionProof` | [`BitcoinSpvProof`](BitcoinSpvProof.md) | Redemption proof data |
| `mainUtxo` | [`BitcoinUtxo`](../README.md#bitcoinutxo) | Data of the wallet's main UTXO |
| `walletPublicKey` | [`Hex`](../classes/Hex.md) | Bitcoin public key of the wallet. Must be in the compressed form (33 bytes long with 02 or 03 prefix). |

#### Returns

`Promise`\<[`Hex`](../classes/Hex.md)\>

Transaction hash of the submit redemption proof transaction.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:106](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L106)

___

### timedOutRedemptions

▸ **timedOutRedemptions**(`walletPublicKey`, `redeemerOutputScript`): `Promise`\<[`RedemptionRequest`](RedemptionRequest.md)\>

Gets a timed-out redemption from the on-chain contract.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `walletPublicKey` | [`Hex`](../classes/Hex.md) | Bitcoin public key of the wallet the request is targeted to. Must be in the compressed form (33 bytes long with 02 or 03 prefix). |
| `redeemerOutputScript` | [`Hex`](../classes/Hex.md) | The redeemer output script the redeemed funds are supposed to be locked on. Must not be prepended with length. |

#### Returns

`Promise`\<[`RedemptionRequest`](RedemptionRequest.md)\>

Promise with the pending redemption.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:158](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L158)

___

### txProofDifficultyFactor

▸ **txProofDifficultyFactor**(): `Promise`\<`number`\>

Gets transaction proof difficulty factor from the on-chain contract.

#### Returns

`Promise`\<`number`\>

Proof difficulty factor.

**`Dev`**

This number signifies how many confirmations a transaction has to
     accumulate before it can be proven on-chain.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:119](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L119)

___

### walletID

▸ **walletID**(`walletPublicKeyHash`): `Promise`\<[`Hex`](../classes/Hex.md)\>

Resolves canonical wallet ID from legacy wallet public key hash.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `walletPublicKeyHash` | [`Hex`](../classes/Hex.md) | The 20-byte wallet public key hash. |

#### Returns

`Promise`\<[`Hex`](../classes/Hex.md)\>

Canonical wallet ID.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:209](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L209)

___

### walletPublicKeyHashForWalletID

▸ **walletPublicKeyHashForWalletID**(`walletID`): `Promise`\<[`Hex`](../classes/Hex.md)\>

Resolves legacy wallet public key hash from canonical wallet ID.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `walletID` | [`Hex`](../classes/Hex.md) | Canonical wallet identifier. |

#### Returns

`Promise`\<[`Hex`](../classes/Hex.md)\>

20-byte wallet public key hash.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:216](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L216)

___

### walletRegistry

▸ **walletRegistry**(): `Promise`\<[`WalletRegistry`](WalletRegistry.md)\>

Returns the attached WalletRegistry instance.

#### Returns

`Promise`\<[`WalletRegistry`](WalletRegistry.md)\>

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:187](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L187)

___

### wallets

▸ **wallets**(`walletPublicKeyHash`): `Promise`\<[`Wallet`](Wallet.md)\>

Gets details about a registered wallet.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `walletPublicKeyHash` | [`Hex`](../classes/Hex.md) | The 20-byte wallet public key hash (computed using Bitcoin HASH160 over the compressed ECDSA public key). |

#### Returns

`Promise`\<[`Wallet`](Wallet.md)\>

Promise with the wallet details.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:195](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L195)

___

### walletsByWalletID

▸ **walletsByWalletID**(`walletID`): `Promise`\<[`Wallet`](Wallet.md)\>

Gets details about a registered wallet using canonical wallet ID.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `walletID` | [`Hex`](../classes/Hex.md) | Canonical wallet identifier. |

#### Returns

`Promise`\<[`Wallet`](Wallet.md)\>

Promise with the wallet details.

#### Defined in

[tbtc-v2-m993/typescript/src/lib/contracts/bridge.ts:202](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L202)
