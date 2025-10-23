# Class: StarkNetBitcoinDepositor

Full implementation of the BitcoinDepositor interface for StarkNet.
This implementation uses a StarkNet provider for operations and supports
deposit initialization through the relayer endpoint.

Unlike other destination chains, StarkNet deposits are primarily handled through L1
contracts, with this depositor serving as a provider-aware interface for
future L2 functionality and relayer integration.

## Implements

- [`BitcoinDepositor`](../interfaces/BitcoinDepositor.md)

## Table of contents

### Constructors

- [constructor](StarkNetBitcoinDepositor.md#constructor)

### Properties

- [#chainName](StarkNetBitcoinDepositor.md##chainname)
- [#config](StarkNetBitcoinDepositor.md##config)
- [#depositOwner](StarkNetBitcoinDepositor.md##depositowner)
- [#extraDataEncoder](StarkNetBitcoinDepositor.md##extradataencoder)
- [#provider](StarkNetBitcoinDepositor.md##provider)

### Methods

- [extraDataEncoder](StarkNetBitcoinDepositor.md#extradataencoder)
- [formatRelayerError](StarkNetBitcoinDepositor.md#formatrelayererror)
- [formatStarkNetAddressAsBytes32](StarkNetBitcoinDepositor.md#formatstarknetaddressasbytes32)
- [getChainIdentifier](StarkNetBitcoinDepositor.md#getchainidentifier)
- [getChainName](StarkNetBitcoinDepositor.md#getchainname)
- [getDepositOwner](StarkNetBitcoinDepositor.md#getdepositowner)
- [getProvider](StarkNetBitcoinDepositor.md#getprovider)
- [initializeDeposit](StarkNetBitcoinDepositor.md#initializedeposit)
- [isRetryableError](StarkNetBitcoinDepositor.md#isretryableerror)
- [setDepositOwner](StarkNetBitcoinDepositor.md#setdepositowner)

## Constructors

### constructor

• **new StarkNetBitcoinDepositor**(`config`, `chainName`, `provider`): [`StarkNetBitcoinDepositor`](StarkNetBitcoinDepositor.md)

Creates a new StarkNetBitcoinDepositor instance.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `config` | [`StarkNetBitcoinDepositorConfig`](../interfaces/StarkNetBitcoinDepositorConfig.md) | Configuration containing chainId and other chain-specific settings |
| `chainName` | `string` | Name of the chain (should be "StarkNet") |
| `provider` | [`StarkNetProvider`](../README.md#starknetprovider) | StarkNet provider for blockchain interactions (Provider or Account) |

#### Returns

[`StarkNetBitcoinDepositor`](StarkNetBitcoinDepositor.md)

**`Throws`**

Error if provider is not provided

#### Defined in

[lib/starknet/starknet-depositor.ts:92](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L92)

## Properties

### #chainName

• `Private` `Readonly` **#chainName**: `string`

#### Defined in

[lib/starknet/starknet-depositor.ts:81](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L81)

___

### #config

• `Private` `Readonly` **#config**: [`StarkNetBitcoinDepositorConfig`](../interfaces/StarkNetBitcoinDepositorConfig.md)

#### Defined in

[lib/starknet/starknet-depositor.ts:80](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L80)

___

### #depositOwner

• `Private` **#depositOwner**: `undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

#### Defined in

[lib/starknet/starknet-depositor.ts:83](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L83)

___

### #extraDataEncoder

• `Private` `Readonly` **#extraDataEncoder**: [`StarkNetExtraDataEncoder`](StarkNetExtraDataEncoder.md)

#### Defined in

[lib/starknet/starknet-depositor.ts:79](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L79)

___

### #provider

• `Private` `Readonly` **#provider**: [`StarkNetProvider`](../README.md#starknetprovider)

#### Defined in

[lib/starknet/starknet-depositor.ts:82](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L82)

## Methods

### extraDataEncoder

▸ **extraDataEncoder**(): [`ExtraDataEncoder`](../interfaces/ExtraDataEncoder.md)

Returns the extra data encoder for StarkNet.

#### Returns

[`ExtraDataEncoder`](../interfaces/ExtraDataEncoder.md)

The StarkNetExtraDataEncoder instance.

#### Implementation of

[BitcoinDepositor](../interfaces/BitcoinDepositor.md).[extraDataEncoder](../interfaces/BitcoinDepositor.md#extradataencoder)

#### Defined in

[lib/starknet/starknet-depositor.ts:195](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L195)

___

### formatRelayerError

▸ **formatRelayerError**(`error`): `string`

Formats relayer errors into user-friendly messages

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `error` | `any` | The error to format |

#### Returns

`string`

Formatted error message

#### Defined in

[lib/starknet/starknet-depositor.ts:426](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L426)

___

### formatStarkNetAddressAsBytes32

▸ **formatStarkNetAddressAsBytes32**(`address`): `string`

Formats a StarkNet address to ensure it's a valid bytes32 value.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `address` | `string` | The StarkNet address to format |

#### Returns

`string`

The formatted address with 0x prefix and 64 hex characters

**`Throws`**

Error if the address is invalid

#### Defined in

[lib/starknet/starknet-depositor.ts:500](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L500)

___

### getChainIdentifier

▸ **getChainIdentifier**(): [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

Gets the chain-specific identifier of this contract.

#### Returns

[`ChainIdentifier`](../interfaces/ChainIdentifier.md)

**`Throws`**

Always throws since StarkNet deposits are handled via L1.

#### Implementation of

[BitcoinDepositor](../interfaces/BitcoinDepositor.md).[getChainIdentifier](../interfaces/BitcoinDepositor.md#getchainidentifier)

#### Defined in

[lib/starknet/starknet-depositor.ts:155](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L155)

___

### getChainName

▸ **getChainName**(): `string`

Gets the chain name for this depositor.

#### Returns

`string`

The chain name (e.g., "StarkNet")

#### Defined in

[lib/starknet/starknet-depositor.ts:138](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L138)

___

### getDepositOwner

▸ **getDepositOwner**(): `undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

Gets the identifier that should be used as the owner of deposits.

#### Returns

`undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

The StarkNet address set as deposit owner, or undefined if not set.

#### Implementation of

[BitcoinDepositor](../interfaces/BitcoinDepositor.md).[getDepositOwner](../interfaces/BitcoinDepositor.md#getdepositowner)

#### Defined in

[lib/starknet/starknet-depositor.ts:166](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L166)

___

### getProvider

▸ **getProvider**(): [`StarkNetProvider`](../README.md#starknetprovider)

Gets the StarkNet provider used by this depositor.

#### Returns

[`StarkNetProvider`](../README.md#starknetprovider)

The StarkNet provider instance

#### Defined in

[lib/starknet/starknet-depositor.ts:146](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L146)

___

### initializeDeposit

▸ **initializeDeposit**(`depositTx`, `depositOutputIndex`, `deposit`, `vault?`): `Promise`\<[`Hex`](Hex.md) \| `TransactionReceipt`\>

Initializes a cross-chain deposit by calling the external relayer service.

This method calls the external service to trigger the deposit transaction
via a relayer off-chain process. It returns the transaction hash as a Hex
or a full transaction receipt.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositTx` | [`BitcoinRawTxVectors`](../interfaces/BitcoinRawTxVectors.md) | The Bitcoin transaction data |
| `depositOutputIndex` | `number` | The output index of the deposit |
| `deposit` | [`DepositReceipt`](../interfaces/DepositReceipt.md) | The deposit receipt containing all deposit parameters |
| `vault?` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) | Optional vault address |

#### Returns

`Promise`\<[`Hex`](Hex.md) \| `TransactionReceipt`\>

The transaction hash or full transaction receipt from the relayer response

**`Throws`**

Error if deposit owner not set or relayer returns unexpected response

#### Implementation of

[BitcoinDepositor](../interfaces/BitcoinDepositor.md).[initializeDeposit](../interfaces/BitcoinDepositor.md#initializedeposit)

#### Defined in

[lib/starknet/starknet-depositor.ts:214](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L214)

___

### isRetryableError

▸ **isRetryableError**(`error`): `boolean`

Determines if an error is retryable

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `error` | `any` | The error to check |

#### Returns

`boolean`

True if the error is retryable

#### Defined in

[lib/starknet/starknet-depositor.ts:398](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L398)

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

[BitcoinDepositor](../interfaces/BitcoinDepositor.md).[setDepositOwner](../interfaces/BitcoinDepositor.md#setdepositowner)

#### Defined in

[lib/starknet/starknet-depositor.ts:176](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L176)
