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
- [formatConflictMessage](StarkNetBitcoinDepositor.md#formatconflictmessage)
- [formatRelayerError](StarkNetBitcoinDepositor.md#formatrelayererror)
- [formatStarkNetAddressAsBytes32](StarkNetBitcoinDepositor.md#formatstarknetaddressasbytes32)
- [getChainIdentifier](StarkNetBitcoinDepositor.md#getchainidentifier)
- [getChainName](StarkNetBitcoinDepositor.md#getchainname)
- [getDepositOwner](StarkNetBitcoinDepositor.md#getdepositowner)
- [getProvider](StarkNetBitcoinDepositor.md#getprovider)
- [handleDepositConflict](StarkNetBitcoinDepositor.md#handledepositconflict)
- [initializeDeposit](StarkNetBitcoinDepositor.md#initializedeposit)
- [isRetryableError](StarkNetBitcoinDepositor.md#isretryableerror)
- [queryRelayerDepositStatus](StarkNetBitcoinDepositor.md#queryrelayerdepositstatus)
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

[src/lib/starknet/starknet-depositor.ts:378](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L378)

## Properties

### #chainName

• `Private` `Readonly` **#chainName**: `string`

#### Defined in

[src/lib/starknet/starknet-depositor.ts:367](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L367)

___

### #config

• `Private` `Readonly` **#config**: [`StarkNetBitcoinDepositorConfig`](../interfaces/StarkNetBitcoinDepositorConfig.md)

#### Defined in

[src/lib/starknet/starknet-depositor.ts:366](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L366)

___

### #depositOwner

• `Private` **#depositOwner**: `undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

#### Defined in

[src/lib/starknet/starknet-depositor.ts:369](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L369)

___

### #extraDataEncoder

• `Private` `Readonly` **#extraDataEncoder**: [`StarkNetExtraDataEncoder`](StarkNetExtraDataEncoder.md)

#### Defined in

[src/lib/starknet/starknet-depositor.ts:365](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L365)

___

### #provider

• `Private` `Readonly` **#provider**: [`StarkNetProvider`](../README.md#starknetprovider)

#### Defined in

[src/lib/starknet/starknet-depositor.ts:368](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L368)

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

[src/lib/starknet/starknet-depositor.ts:507](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L507)

___

### formatConflictMessage

▸ **formatConflictMessage**(`depositId`, `status`, `statusVerified`): `string`

Builds a human-readable message describing an unresolved deposit
conflict, tailored to whatever status information could be verified.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositId` | `undefined` \| `string` | Canonical decimal deposit ID, if known |
| `status` | `undefined` \| [`RelayerDepositStatus`](../enums/RelayerDepositStatus.md) | Verified relayer status, if known |
| `statusVerified` | `boolean` | Whether status reflects a verified relayer response |

#### Returns

`string`

A descriptive error message

#### Defined in

[src/lib/starknet/starknet-depositor.ts:808](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L808)

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

[src/lib/starknet/starknet-depositor.ts:876](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L876)

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

[src/lib/starknet/starknet-depositor.ts:946](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L946)

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

[src/lib/starknet/starknet-depositor.ts:467](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L467)

___

### getChainName

▸ **getChainName**(): `string`

Gets the chain name for this depositor.

#### Returns

`string`

The chain name (e.g., "StarkNet")

#### Defined in

[src/lib/starknet/starknet-depositor.ts:450](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L450)

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

[src/lib/starknet/starknet-depositor.ts:478](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L478)

___

### getProvider

▸ **getProvider**(): [`StarkNetProvider`](../README.md#starknetprovider)

Gets the StarkNet provider used by this depositor.

#### Returns

[`StarkNetProvider`](../README.md#starknetprovider)

The StarkNet provider instance

#### Defined in

[src/lib/starknet/starknet-depositor.ts:458](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L458)

___

### handleDepositConflict

▸ **handleDepositConflict**(`error`): `Promise`\<`never`\>

Handles a 409 Conflict response from the relayer, which means the
relayer already has a record of this deposit. That alone is not proof
that L1 initialization succeeded, and the relayer's deposit-status
endpoint cannot supply a real TransactionReceipt (it has no `to`,
`from`, `gasUsed`, `logs`, `blockHash`, etc.), so this method never
returns a value: it always throws a RelayerDepositConflictError
carrying whatever deposit ID and verified status could be recovered
from the relayer, so the caller can poll or otherwise recover.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `error` | `any` | The Axios error produced by the 409 response |

#### Returns

`Promise`\<`never`\>

**`Throws`**

RelayerDepositConflictError always; carries the deposit ID and
        verified status (if any) recovered from the relayer

#### Defined in

[src/lib/starknet/starknet-depositor.ts:705](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L705)

___

### initializeDeposit

▸ **initializeDeposit**(`depositTx`, `depositOutputIndex`, `deposit`, `vault?`): `Promise`\<[`Hex`](Hex.md) \| `TransactionReceipt`\>

Initializes a cross-chain deposit by calling the external relayer service.

This method calls the external service to trigger the deposit transaction
via a relayer off-chain process. It returns the transaction hash as a Hex
or a full transaction receipt.

If the relayer reports that the deposit already exists (HTTP 409), this
method verifies the deposit's real status through the relayer's
deposit-status endpoint, then always throws a RelayerDepositConflictError
carrying the deposit ID and any verified status so the caller can poll
or otherwise recover. The relayer's deposit-status endpoint cannot
supply a real TransactionReceipt (it has no `to`, `from`, `gasUsed`,
`logs`, `blockHash`, etc.), so a conflict never resolves to a
fabricated success value, even when the relayer confirms the deposit
reached a terminal state.

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

**`Throws`**

RelayerDepositConflictError if the relayer reports the deposit
        already exists

#### Implementation of

[BitcoinDepositor](../interfaces/BitcoinDepositor.md).[initializeDeposit](../interfaces/BitcoinDepositor.md#initializedeposit)

#### Defined in

[src/lib/starknet/starknet-depositor.ts:538](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L538)

___

### isRetryableError

▸ **isRetryableError**(`error`): `boolean`

Determines if an error is retryable. A 409 (Conflict) is intentionally not
handled here: it is dispatched to [handleDepositConflict](StarkNetBitcoinDepositor.md#handledepositconflict) in
`initializeDeposit` before this classifier is ever consulted, and an
ordinary 409 would fall through to the default `false` regardless.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `error` | `any` | The error to check |

#### Returns

`boolean`

True if the error is retryable

#### Defined in

[src/lib/starknet/starknet-depositor.ts:853](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L853)

___

### queryRelayerDepositStatus

▸ **queryRelayerDepositStatus**(`depositId`): `Promise`\<`undefined` \| `RelayerDepositStatusResponse`\>

Queries the relayer's deposit-status endpoint for the current status of
a previously-revealed deposit.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositId` | `string` | Canonical decimal deposit ID as reported by the relayer |

#### Returns

`Promise`\<`undefined` \| `RelayerDepositStatusResponse`\>

The parsed status response, or undefined if the relayer did
         not confirm a recognized status for the deposit

#### Defined in

[src/lib/starknet/starknet-depositor.ts:772](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L772)

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

[src/lib/starknet/starknet-depositor.ts:488](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L488)
