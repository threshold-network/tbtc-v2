# Interface: WalletRegistry

Interface for communication with the WalletRegistry on-chain contract.

## Implemented by

- [`EthereumWalletRegistry`](../classes/EthereumWalletRegistry.md)

## Table of contents

### Properties

- [getDkgResultApprovedEvents](WalletRegistry.md#getdkgresultapprovedevents)
- [getDkgResultChallengedEvents](WalletRegistry.md#getdkgresultchallengedevents)
- [getDkgResultSubmittedEvents](WalletRegistry.md#getdkgresultsubmittedevents)

### Methods

- [getChainIdentifier](WalletRegistry.md#getchainidentifier)
- [getWalletPublicKey](WalletRegistry.md#getwalletpublickey)

## Properties

### getDkgResultApprovedEvents

• **getDkgResultApprovedEvents**: [`Function`](GetChainEvents.Function.md)\<[`DkgResultApprovedEvent`](../README.md#dkgresultapprovedevent)\>

Get emitted DkgResultApprovedEvent events.

**`See`**

GetEventsFunction

#### Defined in

[lib/contracts/wallet-registry.ts:41](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/wallet-registry.ts#L41)

___

### getDkgResultChallengedEvents

• **getDkgResultChallengedEvents**: [`Function`](GetChainEvents.Function.md)\<[`DkgResultChallengedEvent`](../README.md#dkgresultchallengedevent)\>

Get emitted DkgResultChallengedEvent events.

**`See`**

GetEventsFunction

#### Defined in

[lib/contracts/wallet-registry.ts:47](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/wallet-registry.ts#L47)

___

### getDkgResultSubmittedEvents

• **getDkgResultSubmittedEvents**: [`Function`](GetChainEvents.Function.md)\<[`DkgResultSubmittedEvent`](../README.md#dkgresultsubmittedevent)\>

Get emitted DkgResultSubmittedEvent events.

**`See`**

GetEventsFunction

#### Defined in

[lib/contracts/wallet-registry.ts:35](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/wallet-registry.ts#L35)

## Methods

### getChainIdentifier

▸ **getChainIdentifier**(): [`ChainIdentifier`](ChainIdentifier.md)

Gets the chain-specific identifier of this contract.

#### Returns

[`ChainIdentifier`](ChainIdentifier.md)

#### Defined in

[lib/contracts/wallet-registry.ts:13](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/wallet-registry.ts#L13)

___

### getWalletPublicKey

▸ **getWalletPublicKey**(`walletID`, `skipRetryWhenNotRegistered?`): `Promise`\<[`Hex`](../classes/Hex.md)\>

Gets the public key for the given wallet.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `walletID` | [`Hex`](../classes/Hex.md) | ID of the wallet. |
| `skipRetryWhenNotRegistered?` | `boolean` | When set to true, the underlying contract call is not retried if it reverts because the wallet with the given ID is not registered (e.g. the wallet was closed or terminated). Defaults to false so that callers that may race a not-yet-synced chain endpoint right after wallet creation keep the retry behavior. |

#### Returns

`Promise`\<[`Hex`](../classes/Hex.md)\>

Uncompressed public key without the 04 prefix.

#### Defined in

[lib/contracts/wallet-registry.ts:26](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/wallet-registry.ts#L26)
