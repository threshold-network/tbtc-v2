# Interface: Bridge

Interface for communication with the Bridge on-chain contract.

## Implemented by

- [`EthereumBridge`](../classes/EthereumBridge.md)

## Table of contents

### Properties

- [getDepositRevealedEvents](Bridge.md#getdepositrevealedevents)
- [getNewWalletRegisteredEvents](Bridge.md#getnewwalletregisteredevents)
- [getRedemptionRequestedEvents](Bridge.md#getredemptionrequestedevents)

### Methods

- [activeWalletPublicKey](Bridge.md#activewalletpublickey)
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
- [walletRegistry](Bridge.md#walletregistry)
- [wallets](Bridge.md#wallets)

## Properties

### getDepositRevealedEvents

• **getDepositRevealedEvents**: [`Function`](GetChainEvents.Function.md)\<[`DepositRevealedEvent`](../README.md#depositrevealedevent)\>

Get emitted DepositRevealed events.

**`See`**

GetEventsFunction

#### Defined in

[src/lib/contracts/bridge.ts:25](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L25)

___

### getNewWalletRegisteredEvents

• **getNewWalletRegisteredEvents**: [`Function`](GetChainEvents.Function.md)\<[`NewWalletRegisteredEvent`](../README.md#newwalletregisteredevent)\>

Get emitted NewWalletRegisteredEvent events.

**`See`**

GetEventsFunction

#### Defined in

[src/lib/contracts/bridge.ts:168](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L168)

___

### getRedemptionRequestedEvents

• **getRedemptionRequestedEvents**: [`Function`](GetChainEvents.Function.md)\<[`RedemptionRequestedEvent`](../README.md#redemptionrequestedevent)\>

Get emitted RedemptionRequested events.

**`See`**

GetEventsFunction

#### Defined in

[src/lib/contracts/bridge.ts:194](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L194)

## Methods

### activeWalletPublicKey

▸ **activeWalletPublicKey**(): `Promise`\<`undefined` \| [`Hex`](../classes/Hex.md)\>

Gets the public key of the current active wallet.

#### Returns

`Promise`\<`undefined` \| [`Hex`](../classes/Hex.md)\>

Compressed (33 bytes long with 02 or 03 prefix) active wallet's
         public key. If there is no active wallet at the moment, undefined
         is returned.

#### Defined in

[src/lib/contracts/bridge.ts:162](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L162)

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

[src/lib/contracts/bridge.ts:188](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L188)

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

[src/lib/contracts/bridge.ts:67](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L67)

___

### getChainIdentifier

▸ **getChainIdentifier**(): [`ChainIdentifier`](ChainIdentifier.md)

Gets the chain-specific identifier of this contract.

#### Returns

[`ChainIdentifier`](ChainIdentifier.md)

#### Defined in

[src/lib/contracts/bridge.ts:19](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L19)

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

[src/lib/contracts/bridge.ts:123](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L123)

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

[src/lib/contracts/bridge.ts:137](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L137)

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
| `amount` | `bigint` | The amount to be redeemed in satoshis. |

#### Returns

`Promise`\<[`Hex`](../classes/Hex.md)\>

Transaction hash of the request redemption transaction.

#### Defined in

[src/lib/contracts/bridge.ts:83](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L83)

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

[src/lib/contracts/bridge.ts:53](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L53)

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

[src/lib/contracts/bridge.ts:36](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L36)

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

[src/lib/contracts/bridge.ts:99](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L99)

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

[src/lib/contracts/bridge.ts:151](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L151)

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

[src/lib/contracts/bridge.ts:112](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L112)

___

### walletRegistry

▸ **walletRegistry**(): `Promise`\<[`WalletRegistry`](WalletRegistry.md)\>

Returns the attached WalletRegistry instance.

#### Returns

`Promise`\<[`WalletRegistry`](WalletRegistry.md)\>

#### Defined in

[src/lib/contracts/bridge.ts:173](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L173)

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

[src/lib/contracts/bridge.ts:181](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L181)
