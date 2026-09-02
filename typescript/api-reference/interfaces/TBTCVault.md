# Interface: TBTCVault

Interface for communication with the TBTCVault on-chain contract.

## Implemented by

- [`EthereumTBTCVault`](../classes/EthereumTBTCVault.md)

## Table of contents

### Properties

- [getOptimisticMintingCancelledEvents](TBTCVault.md#getoptimisticmintingcancelledevents)
- [getOptimisticMintingFinalizedEvents](TBTCVault.md#getoptimisticmintingfinalizedevents)
- [getOptimisticMintingRequestedEvents](TBTCVault.md#getoptimisticmintingrequestedevents)

### Methods

- [cancelOptimisticMint](TBTCVault.md#canceloptimisticmint)
- [finalizeOptimisticMint](TBTCVault.md#finalizeoptimisticmint)
- [getChainIdentifier](TBTCVault.md#getchainidentifier)
- [getMinters](TBTCVault.md#getminters)
- [isGuardian](TBTCVault.md#isguardian)
- [isMinter](TBTCVault.md#isminter)
- [optimisticMintingDelay](TBTCVault.md#optimisticmintingdelay)
- [optimisticMintingRequests](TBTCVault.md#optimisticmintingrequests)
- [requestOptimisticMint](TBTCVault.md#requestoptimisticmint)

## Properties

### getOptimisticMintingCancelledEvents

• **getOptimisticMintingCancelledEvents**: [`Function`](GetChainEvents.Function.md)\<[`OptimisticMintingCancelledEvent`](../README.md#optimisticmintingcancelledevent)\>

Get emitted OptimisticMintingCancelled events.

**`See`**

GetEventsFunction

#### Defined in

[src/lib/contracts/tbtc-vault.ts:106](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/tbtc-vault.ts#L106)

___

### getOptimisticMintingFinalizedEvents

• **getOptimisticMintingFinalizedEvents**: [`Function`](GetChainEvents.Function.md)\<[`OptimisticMintingFinalizedEvent`](../README.md#optimisticmintingfinalizedevent)\>

Get emitted OptimisticMintingFinalized events.

**`See`**

GetEventsFunction

#### Defined in

[src/lib/contracts/tbtc-vault.ts:112](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/tbtc-vault.ts#L112)

___

### getOptimisticMintingRequestedEvents

• **getOptimisticMintingRequestedEvents**: [`Function`](GetChainEvents.Function.md)\<[`OptimisticMintingRequestedEvent`](../README.md#optimisticmintingrequestedevent)\>

Get emitted OptimisticMintingRequested events.

**`See`**

GetEventsFunction

#### Defined in

[src/lib/contracts/tbtc-vault.ts:100](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/tbtc-vault.ts#L100)

## Methods

### cancelOptimisticMint

▸ **cancelOptimisticMint**(`depositTxHash`, `depositOutputIndex`): `Promise`\<[`Hex`](../classes/Hex.md)\>

Cancels optimistic minting for a deposit in an on-chain contract.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositTxHash` | [`BitcoinTxHash`](../classes/BitcoinTxHash.md) | The revealed deposit transaction's hash. |
| `depositOutputIndex` | `number` | Index of the deposit transaction output that funds the revealed deposit. |

#### Returns

`Promise`\<[`Hex`](../classes/Hex.md)\>

Transaction hash of the optimistic mint cancel transaction.

#### Defined in

[src/lib/contracts/tbtc-vault.ts:66](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/tbtc-vault.ts#L66)

___

### finalizeOptimisticMint

▸ **finalizeOptimisticMint**(`depositTxHash`, `depositOutputIndex`): `Promise`\<[`Hex`](../classes/Hex.md)\>

Finalizes optimistic minting for a deposit in an on-chain contract.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositTxHash` | [`BitcoinTxHash`](../classes/BitcoinTxHash.md) | The revealed deposit transaction's hash. |
| `depositOutputIndex` | `number` | Index of the deposit transaction output that funds the revealed deposit. |

#### Returns

`Promise`\<[`Hex`](../classes/Hex.md)\>

Transaction hash of the optimistic mint finalize transaction.

#### Defined in

[src/lib/contracts/tbtc-vault.ts:79](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/tbtc-vault.ts#L79)

___

### getChainIdentifier

▸ **getChainIdentifier**(): [`ChainIdentifier`](ChainIdentifier.md)

Gets the chain-specific identifier of this contract.

#### Returns

[`ChainIdentifier`](ChainIdentifier.md)

#### Defined in

[src/lib/contracts/tbtc-vault.ts:13](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/tbtc-vault.ts#L13)

___

### getMinters

▸ **getMinters**(): `Promise`\<[`ChainIdentifier`](ChainIdentifier.md)[]\>

Gets currently registered minters.

#### Returns

`Promise`\<[`ChainIdentifier`](ChainIdentifier.md)[]\>

Array containing identifiers of all currently registered minters.

#### Defined in

[src/lib/contracts/tbtc-vault.ts:29](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/tbtc-vault.ts#L29)

___

### isGuardian

▸ **isGuardian**(`identifier`): `Promise`\<`boolean`\>

Checks if given identifier is registered as guardian.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `identifier` | [`ChainIdentifier`](ChainIdentifier.md) | Chain identifier to check. |

#### Returns

`Promise`\<`boolean`\>

#### Defined in

[src/lib/contracts/tbtc-vault.ts:43](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/tbtc-vault.ts#L43)

___

### isMinter

▸ **isMinter**(`identifier`): `Promise`\<`boolean`\>

Checks if given identifier is registered as minter.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `identifier` | [`ChainIdentifier`](ChainIdentifier.md) | Chain identifier to check. |

#### Returns

`Promise`\<`boolean`\>

#### Defined in

[src/lib/contracts/tbtc-vault.ts:36](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/tbtc-vault.ts#L36)

___

### optimisticMintingDelay

▸ **optimisticMintingDelay**(): `Promise`\<`number`\>

Gets optimistic minting delay.

The time that needs to pass between the moment the optimistic minting is
requested and the moment optimistic minting is finalized with minting TBTC.

#### Returns

`Promise`\<`number`\>

Optimistic Minting Delay in seconds.

#### Defined in

[src/lib/contracts/tbtc-vault.ts:22](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/tbtc-vault.ts#L22)

___

### optimisticMintingRequests

▸ **optimisticMintingRequests**(`depositTxHash`, `depositOutputIndex`): `Promise`\<[`OptimisticMintingRequest`](../README.md#optimisticmintingrequest)\>

Gets optimistic minting request for a deposit.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositTxHash` | [`BitcoinTxHash`](../classes/BitcoinTxHash.md) | The revealed deposit transaction's hash. |
| `depositOutputIndex` | `number` | Index of the deposit transaction output that funds the revealed deposit. |

#### Returns

`Promise`\<[`OptimisticMintingRequest`](../README.md#optimisticmintingrequest)\>

Optimistic minting request.

#### Defined in

[src/lib/contracts/tbtc-vault.ts:91](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/tbtc-vault.ts#L91)

___

### requestOptimisticMint

▸ **requestOptimisticMint**(`depositTxHash`, `depositOutputIndex`): `Promise`\<[`Hex`](../classes/Hex.md)\>

Requests optimistic minting for a deposit in an on-chain contract.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositTxHash` | [`BitcoinTxHash`](../classes/BitcoinTxHash.md) | The revealed deposit transaction's hash. |
| `depositOutputIndex` | `number` | Index of the deposit transaction output that funds the revealed deposit. |

#### Returns

`Promise`\<[`Hex`](../classes/Hex.md)\>

Transaction hash of the optimistic mint request transaction.

#### Defined in

[src/lib/contracts/tbtc-vault.ts:53](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/tbtc-vault.ts#L53)
