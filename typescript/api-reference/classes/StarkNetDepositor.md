# Class: StarkNetDepositor

Full implementation of the L2BitcoinDepositor interface for StarkNet.
This implementation uses a StarkNet provider for operations and supports
deposit initialization through the relayer endpoint.

Unlike other L2 chains, StarkNet deposits are primarily handled through L1
contracts, with this depositor serving as a provider-aware interface for
future L2 functionality and relayer integration.

## Implements

- [`L2BitcoinDepositor`](../interfaces/L2BitcoinDepositor.md)

## Table of contents

### Constructors

- [constructor](StarkNetDepositor.md#constructor)

### Properties

- [#chainName](StarkNetDepositor.md##chainname)
- [#config](StarkNetDepositor.md##config)
- [#depositOwner](StarkNetDepositor.md##depositowner)
- [#extraDataEncoder](StarkNetDepositor.md##extradataencoder)
- [#provider](StarkNetDepositor.md##provider)

### Methods

- [extraDataEncoder](StarkNetDepositor.md#extradataencoder)
- [getChainIdentifier](StarkNetDepositor.md#getchainidentifier)
- [getChainName](StarkNetDepositor.md#getchainname)
- [getDepositOwner](StarkNetDepositor.md#getdepositowner)
- [getProvider](StarkNetDepositor.md#getprovider)
- [initializeDeposit](StarkNetDepositor.md#initializedeposit)
- [setDepositOwner](StarkNetDepositor.md#setdepositowner)

## Constructors

### constructor

• **new StarkNetDepositor**(`config`, `chainName`, `provider`): [`StarkNetDepositor`](StarkNetDepositor.md)

Creates a new StarkNetDepositor instance.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `config` | [`StarkNetDepositorConfig`](../interfaces/StarkNetDepositorConfig.md) | Configuration containing chainId and other chain-specific settings |
| `chainName` | `string` | Name of the chain (should be "StarkNet") |
| `provider` | [`StarkNetProvider`](../README.md#starknetprovider) | StarkNet provider for blockchain interactions (Provider or Account) |

#### Returns

[`StarkNetDepositor`](StarkNetDepositor.md)

**`Throws`**

Error if provider is not provided

#### Defined in

[lib/starknet/starknet-depositor.ts:43](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L43)

## Properties

### #chainName

• `Private` `Readonly` **#chainName**: `string`

#### Defined in

[lib/starknet/starknet-depositor.ts:32](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L32)

___

### #config

• `Private` `Readonly` **#config**: [`StarkNetDepositorConfig`](../interfaces/StarkNetDepositorConfig.md)

#### Defined in

[lib/starknet/starknet-depositor.ts:31](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L31)

___

### #depositOwner

• `Private` **#depositOwner**: `undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

#### Defined in

[lib/starknet/starknet-depositor.ts:34](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L34)

___

### #extraDataEncoder

• `Private` `Readonly` **#extraDataEncoder**: [`StarkNetCrossChainExtraDataEncoder`](StarkNetCrossChainExtraDataEncoder.md)

#### Defined in

[lib/starknet/starknet-depositor.ts:30](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L30)

___

### #provider

• `Private` `Readonly` **#provider**: [`StarkNetProvider`](../README.md#starknetprovider)

#### Defined in

[lib/starknet/starknet-depositor.ts:33](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L33)

## Methods

### extraDataEncoder

▸ **extraDataEncoder**(): [`CrossChainExtraDataEncoder`](../interfaces/CrossChainExtraDataEncoder.md)

Returns the extra data encoder for StarkNet.

#### Returns

[`CrossChainExtraDataEncoder`](../interfaces/CrossChainExtraDataEncoder.md)

The StarkNetCrossChainExtraDataEncoder instance.

#### Implementation of

[L2BitcoinDepositor](../interfaces/L2BitcoinDepositor.md).[extraDataEncoder](../interfaces/L2BitcoinDepositor.md#extradataencoder)

#### Defined in

[lib/starknet/starknet-depositor.ts:118](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L118)

___

### getChainIdentifier

▸ **getChainIdentifier**(): [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

Gets the chain-specific identifier of this contract.

#### Returns

[`ChainIdentifier`](../interfaces/ChainIdentifier.md)

**`Throws`**

Always throws since StarkNet deposits are handled via L1.

#### Implementation of

[L2BitcoinDepositor](../interfaces/L2BitcoinDepositor.md).[getChainIdentifier](../interfaces/L2BitcoinDepositor.md#getchainidentifier)

#### Defined in

[lib/starknet/starknet-depositor.ts:78](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L78)

___

### getChainName

▸ **getChainName**(): `string`

Gets the chain name for this depositor.

#### Returns

`string`

The chain name (e.g., "StarkNet")

#### Defined in

[lib/starknet/starknet-depositor.ts:61](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L61)

___

### getDepositOwner

▸ **getDepositOwner**(): `undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

Gets the identifier that should be used as the owner of deposits.

#### Returns

`undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

The StarkNet address set as deposit owner, or undefined if not set.

#### Implementation of

[L2BitcoinDepositor](../interfaces/L2BitcoinDepositor.md).[getDepositOwner](../interfaces/L2BitcoinDepositor.md#getdepositowner)

#### Defined in

[lib/starknet/starknet-depositor.ts:89](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L89)

___

### getProvider

▸ **getProvider**(): [`StarkNetProvider`](../README.md#starknetprovider)

Gets the StarkNet provider used by this depositor.

#### Returns

[`StarkNetProvider`](../README.md#starknetprovider)

The StarkNet provider instance

#### Defined in

[lib/starknet/starknet-depositor.ts:69](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L69)

___

### initializeDeposit

▸ **initializeDeposit**(`_depositTx`, `_depositOutputIndex`, `_deposit`, `_vault?`): `Promise`\<[`Hex`](Hex.md)\>

Initializes a cross-chain deposit (to be implemented in T-007).

#### Parameters

| Name | Type |
| :------ | :------ |
| `_depositTx` | [`BitcoinRawTxVectors`](../interfaces/BitcoinRawTxVectors.md) |
| `_depositOutputIndex` | `number` |
| `_deposit` | [`DepositReceipt`](../interfaces/DepositReceipt.md) |
| `_vault?` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) |

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

**`Throws`**

Currently throws error - will be implemented with relayer support

#### Implementation of

[L2BitcoinDepositor](../interfaces/L2BitcoinDepositor.md).[initializeDeposit](../interfaces/L2BitcoinDepositor.md#initializedeposit)

#### Defined in

[lib/starknet/starknet-depositor.ts:127](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L127)

___

### setDepositOwner

▸ **setDepositOwner**(`depositOwner`): `void`

Sets the identifier that should be used as the owner of deposits.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositOwner` | `undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md) | Must be a StarkNetAddress instance or undefined/null to clear. |

#### Returns

`void`

**`Throws`**

Error if the deposit owner is not a StarkNetAddress and not undefined/null.

#### Implementation of

[L2BitcoinDepositor](../interfaces/L2BitcoinDepositor.md).[setDepositOwner](../interfaces/L2BitcoinDepositor.md#setdepositowner)

#### Defined in

[lib/starknet/starknet-depositor.ts:99](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L99)
