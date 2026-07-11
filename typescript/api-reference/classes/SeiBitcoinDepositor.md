# Class: SeiBitcoinDepositor

Full implementation of the BitcoinDepositor interface for Sei.
This implementation uses a Sei provider for operations and supports
deposit initialization through the relayer endpoint.

Like StarkNet, Sei deposits are handled through L1 contracts
(L1BTCDepositorNttWithExecutor), with this depositor serving as a
provider-aware interface for relayer integration.

## Implements

- [`BitcoinDepositor`](../interfaces/BitcoinDepositor.md)

## Table of contents

### Constructors

- [constructor](SeiBitcoinDepositor.md#constructor)

### Properties

- [#chainName](SeiBitcoinDepositor.md##chainname)
- [#config](SeiBitcoinDepositor.md##config)
- [#depositOwner](SeiBitcoinDepositor.md##depositowner)
- [#extraDataEncoder](SeiBitcoinDepositor.md##extradataencoder)
- [#provider](SeiBitcoinDepositor.md##provider)

### Methods

- [extraDataEncoder](SeiBitcoinDepositor.md#extradataencoder)
- [formatRelayerError](SeiBitcoinDepositor.md#formatrelayererror)
- [formatSeiAddressAsBytes32](SeiBitcoinDepositor.md#formatseiaddressasbytes32)
- [getChainIdentifier](SeiBitcoinDepositor.md#getchainidentifier)
- [getChainName](SeiBitcoinDepositor.md#getchainname)
- [getDepositOwner](SeiBitcoinDepositor.md#getdepositowner)
- [getProvider](SeiBitcoinDepositor.md#getprovider)
- [initializeDeposit](SeiBitcoinDepositor.md#initializedeposit)
- [isRetryableError](SeiBitcoinDepositor.md#isretryableerror)
- [setDepositOwner](SeiBitcoinDepositor.md#setdepositowner)
- [supportsTaprootDeposits](SeiBitcoinDepositor.md#supportstaprootdeposits)

## Constructors

### constructor

• **new SeiBitcoinDepositor**(`config`, `chainName`, `provider`): [`SeiBitcoinDepositor`](SeiBitcoinDepositor.md)

Creates a new SeiBitcoinDepositor instance.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `config` | [`SeiBitcoinDepositorConfig`](../interfaces/SeiBitcoinDepositorConfig.md) | Configuration containing chainId and other chain-specific settings |
| `chainName` | `string` | Name of the chain (should be "Sei") |
| `provider` | `Provider` | Sei provider for blockchain interactions |

#### Returns

[`SeiBitcoinDepositor`](SeiBitcoinDepositor.md)

**`Throws`**

Error if provider is not provided

#### Defined in

[src/lib/sei/sei-depositor.ts:89](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/sei/sei-depositor.ts#L89)

## Properties

### #chainName

• `Private` `Readonly` **#chainName**: `string`

#### Defined in

[src/lib/sei/sei-depositor.ts:78](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/sei/sei-depositor.ts#L78)

___

### #config

• `Private` `Readonly` **#config**: [`SeiBitcoinDepositorConfig`](../interfaces/SeiBitcoinDepositorConfig.md)

#### Defined in

[src/lib/sei/sei-depositor.ts:77](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/sei/sei-depositor.ts#L77)

___

### #depositOwner

• `Private` **#depositOwner**: `undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

#### Defined in

[src/lib/sei/sei-depositor.ts:80](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/sei/sei-depositor.ts#L80)

___

### #extraDataEncoder

• `Private` `Readonly` **#extraDataEncoder**: [`SeiExtraDataEncoder`](SeiExtraDataEncoder.md)

#### Defined in

[src/lib/sei/sei-depositor.ts:76](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/sei/sei-depositor.ts#L76)

___

### #provider

• `Private` `Readonly` **#provider**: `Provider`

#### Defined in

[src/lib/sei/sei-depositor.ts:79](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/sei/sei-depositor.ts#L79)

## Methods

### extraDataEncoder

▸ **extraDataEncoder**(): [`ExtraDataEncoder`](../interfaces/ExtraDataEncoder.md)

Returns the extra data encoder for Sei.

#### Returns

[`ExtraDataEncoder`](../interfaces/ExtraDataEncoder.md)

The SeiExtraDataEncoder instance.

#### Implementation of

[BitcoinDepositor](../interfaces/BitcoinDepositor.md).[extraDataEncoder](../interfaces/BitcoinDepositor.md#extradataencoder)

#### Defined in

[src/lib/sei/sei-depositor.ts:193](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/sei/sei-depositor.ts#L193)

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

[src/lib/sei/sei-depositor.ts:434](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/sei/sei-depositor.ts#L434)

___

### formatSeiAddressAsBytes32

▸ **formatSeiAddressAsBytes32**(`address`): `string`

Formats a Sei address to ensure it's a valid bytes32 value.
Sei uses EVM-compatible addresses (20 bytes), so we pad with zeros.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `address` | `string` | The Sei address to format |

#### Returns

`string`

The formatted address with 0x prefix and 64 hex characters

**`Throws`**

Error if the address is invalid

#### Defined in

[src/lib/sei/sei-depositor.ts:509](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/sei/sei-depositor.ts#L509)

___

### getChainIdentifier

▸ **getChainIdentifier**(): [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

Gets the chain-specific identifier of this contract.

#### Returns

[`ChainIdentifier`](../interfaces/ChainIdentifier.md)

**`Throws`**

Always throws since Sei deposits are handled via L1.

#### Implementation of

[BitcoinDepositor](../interfaces/BitcoinDepositor.md).[getChainIdentifier](../interfaces/BitcoinDepositor.md#getchainidentifier)

#### Defined in

[src/lib/sei/sei-depositor.ts:153](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/sei/sei-depositor.ts#L153)

___

### getChainName

▸ **getChainName**(): `string`

Gets the chain name for this depositor.

#### Returns

`string`

The chain name (e.g., "Sei")

#### Defined in

[src/lib/sei/sei-depositor.ts:136](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/sei/sei-depositor.ts#L136)

___

### getDepositOwner

▸ **getDepositOwner**(): `undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

Gets the identifier that should be used as the owner of deposits.

#### Returns

`undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

The Sei address set as deposit owner, or undefined if not set.

#### Implementation of

[BitcoinDepositor](../interfaces/BitcoinDepositor.md).[getDepositOwner](../interfaces/BitcoinDepositor.md#getdepositowner)

#### Defined in

[src/lib/sei/sei-depositor.ts:164](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/sei/sei-depositor.ts#L164)

___

### getProvider

▸ **getProvider**(): `Provider`

Gets the Sei provider used by this depositor.

#### Returns

`Provider`

The Sei provider instance

#### Defined in

[src/lib/sei/sei-depositor.ts:144](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/sei/sei-depositor.ts#L144)

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

[src/lib/sei/sei-depositor.ts:220](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/sei/sei-depositor.ts#L220)

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

[src/lib/sei/sei-depositor.ts:406](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/sei/sei-depositor.ts#L406)

___

### setDepositOwner

▸ **setDepositOwner**(`depositOwner`): `void`

Sets the identifier that should be used as the owner of deposits.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositOwner` | `undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md) | Must be a SeiAddress instance or undefined/null to clear. |

#### Returns

`void`

**`Throws`**

Error if the deposit owner is not a SeiAddress and not undefined/null.

#### Implementation of

[BitcoinDepositor](../interfaces/BitcoinDepositor.md).[setDepositOwner](../interfaces/BitcoinDepositor.md#setdepositowner)

#### Defined in

[src/lib/sei/sei-depositor.ts:174](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/sei/sei-depositor.ts#L174)

___

### supportsTaprootDeposits

▸ **supportsTaprootDeposits**(): `boolean`

#### Returns

`boolean`

False until the relayer and L1 depositor support Taproot reveals.

**`See`**

#### Implementation of

[BitcoinDepositor](../interfaces/BitcoinDepositor.md).[supportsTaprootDeposits](../interfaces/BitcoinDepositor.md#supportstaprootdeposits)

#### Defined in

[src/lib/sei/sei-depositor.ts:201](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/sei/sei-depositor.ts#L201)
