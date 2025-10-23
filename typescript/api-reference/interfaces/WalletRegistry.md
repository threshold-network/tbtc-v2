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

[lib/contracts/wallet-registry.ts:32](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/wallet-registry.ts#L32)

___

### getDkgResultChallengedEvents

• **getDkgResultChallengedEvents**: [`Function`](GetChainEvents.Function.md)\<[`DkgResultChallengedEvent`](../README.md#dkgresultchallengedevent)\>

Get emitted DkgResultChallengedEvent events.

**`See`**

GetEventsFunction

#### Defined in

[lib/contracts/wallet-registry.ts:38](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/wallet-registry.ts#L38)

___

### getDkgResultSubmittedEvents

• **getDkgResultSubmittedEvents**: [`Function`](GetChainEvents.Function.md)\<[`DkgResultSubmittedEvent`](../README.md#dkgresultsubmittedevent)\>

Get emitted DkgResultSubmittedEvent events.

**`See`**

GetEventsFunction

#### Defined in

[lib/contracts/wallet-registry.ts:26](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/wallet-registry.ts#L26)

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

▸ **getWalletPublicKey**(`walletID`): `Promise`\<[`Hex`](../classes/Hex.md)\>

Gets the public key for the given wallet.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `walletID` | [`Hex`](../classes/Hex.md) | ID of the wallet. |

#### Returns

`Promise`\<[`Hex`](../classes/Hex.md)\>

Uncompressed public key without the 04 prefix.

#### Defined in

[lib/contracts/wallet-registry.ts:20](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/wallet-registry.ts#L20)
