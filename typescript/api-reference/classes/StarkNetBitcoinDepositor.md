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
| `config` | [`StarkNetBitcoinDepositorConfig`](../interfaces/StarkNetBitcoinDepositorConfig.md) | Configuration containing chainId and other chain-specific settings. Note: If an unrecognized chain ID is provided, relayerUrl must be supplied. |
| `chainName` | `string` | Name of the chain (should be "StarkNet") |
| `provider` | [`StarkNetProvider`](../README.md#starknetprovider) | StarkNet provider for blockchain interactions (Provider or Account) |

#### Returns

[`StarkNetBitcoinDepositor`](StarkNetBitcoinDepositor.md)

**`Throws`**

Error if provider is not provided or if chain-ID/relayerUrl requirements are unmet.

#### Defined in

[src/lib/starknet/starknet-depositor.ts:444](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L444)

## Properties

### #chainName

• `Private` `Readonly` **#chainName**: `string`

#### Defined in

[src/lib/starknet/starknet-depositor.ts:432](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L432)

___

### #config

• `Private` `Readonly` **#config**: [`StarkNetBitcoinDepositorConfig`](../interfaces/StarkNetBitcoinDepositorConfig.md)

#### Defined in

[src/lib/starknet/starknet-depositor.ts:431](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L431)

___

### #depositOwner

• `Private` **#depositOwner**: `undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

#### Defined in

[src/lib/starknet/starknet-depositor.ts:434](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L434)

___

### #extraDataEncoder

• `Private` `Readonly` **#extraDataEncoder**: [`StarkNetExtraDataEncoder`](StarkNetExtraDataEncoder.md)

#### Defined in

[src/lib/starknet/starknet-depositor.ts:430](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L430)

___

### #provider

• `Private` `Readonly` **#provider**: [`StarkNetProvider`](../README.md#starknetprovider)

#### Defined in

[src/lib/starknet/starknet-depositor.ts:433](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L433)

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

[src/lib/starknet/starknet-depositor.ts:562](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L562)

___

### formatConflictMessage

▸ **formatConflictMessage**(`depositId`, `status`, `statusVerified`, `depositIdMismatch`): `string`

Builds a human-readable message describing an unresolved deposit
conflict, tailored to whatever status information could be verified.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositId` | `undefined` \| `string` | Canonical decimal deposit ID, if known |
| `status` | `undefined` \| [`StarkNetRelayerDepositStatus`](../enums/StarkNetRelayerDepositStatus.md) | Verified relayer status, if known |
| `statusVerified` | `boolean` | Whether status reflects a verified relayer response |
| `depositIdMismatch` | `boolean` | Whether the relayer reported a canonical ID that disagrees with the SDK's own locally-derived ID |

#### Returns

`string`

A descriptive error message

#### Defined in

[src/lib/starknet/starknet-depositor.ts:936](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L936)

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

[src/lib/starknet/starknet-depositor.ts:1015](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L1015)

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

[src/lib/starknet/starknet-depositor.ts:1085](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L1085)

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

[src/lib/starknet/starknet-depositor.ts:522](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L522)

___

### getChainName

▸ **getChainName**(): `string`

Gets the chain name for this depositor.

#### Returns

`string`

The chain name (e.g., "StarkNet")

#### Defined in

[src/lib/starknet/starknet-depositor.ts:505](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L505)

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

[src/lib/starknet/starknet-depositor.ts:533](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L533)

___

### getProvider

▸ **getProvider**(): [`StarkNetProvider`](../README.md#starknetprovider)

Gets the StarkNet provider used by this depositor.

#### Returns

[`StarkNetProvider`](../README.md#starknetprovider)

The StarkNet provider instance

#### Defined in

[src/lib/starknet/starknet-depositor.ts:513](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L513)

___

### handleDepositConflict

▸ **handleDepositConflict**(`error`, `locallyDerivedDepositId?`, `signal?`): `Promise`\<`never`\>

Handles a 409 Conflict response from the relayer, which means the
relayer already has a record of this deposit. That alone is not proof
that L1 initialization succeeded, and the relayer's deposit-status
endpoint cannot supply a real TransactionReceipt (it has no `to`,
`from`, `gasUsed`, `logs`, `blockHash`, etc.), so this method never
returns a value: it always throws a StarkNetRelayerDepositConflictError
carrying whatever deposit ID and verified status could be recovered
from the relayer, so the caller can poll or otherwise recover.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `error` | `unknown` | The Axios error produced by the 409 response |
| `locallyDerivedDepositId?` | `string` | The deposit ID the SDK independently derived from the funding transaction, if available. Used to query the relayer's status endpoint when the relayer's reported ID is missing or non-canonical, and as the required cross-check for trusting any relayer status response as verified (see `statusVerified` below). |
| `signal?` | `AbortSignal` | Optional AbortSignal to cancel the status verification request. |

#### Returns

`Promise`\<`never`\>

Promise that never resolves; always throws StarkNetRelayerDepositConflictError.

**`Throws`**

StarkNetRelayerDepositConflictError always; carries the deposit ID and
        verified status (if any) recovered from the relayer

#### Defined in

[src/lib/starknet/starknet-depositor.ts:796](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L796)

___

### initializeDeposit

▸ **initializeDeposit**(`depositTx`, `depositOutputIndex`, `deposit`, `vault?`, `signal?`): `Promise`\<[`Hex`](Hex.md) \| `TransactionReceipt`\>

Initializes a cross-chain deposit by calling the external relayer service.

This method calls the external service to trigger the deposit transaction
via a relayer off-chain process. It resolves with the full transaction
receipt.

If the relayer reports that the deposit already exists (HTTP 409), this
method attempts to verify the deposit's real status through the relayer's
deposit-status endpoint - only when relayerStatusUrl is configured, and
using the relayer's reported deposit ID when it is canonical, falling
back to the SDK's independently-derived ID when it is not - then always
throws a StarkNetRelayerDepositConflictError carrying the deposit ID and
any verified status so the caller can poll or otherwise recover. The
relayer's deposit-status endpoint cannot supply a real TransactionReceipt
(it has no `to`, `from`, `gasUsed`, `logs`, `blockHash`, etc.), so a
conflict never resolves to a fabricated success value, even when the
relayer confirms the deposit reached a terminal state.

Worst-case latency: up to 4 attempts (1 initial + 3 retries) at a 90s
reveal-POST timeout each, plus a fixed 3s/6s/12s backoff between
retries (21s total) - roughly 6.3 minutes before this rejects, if the
relayer is unreachable or erroring on every attempt. Pass `signal` to
cancel earlier.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositTx` | [`BitcoinRawTxVectors`](../interfaces/BitcoinRawTxVectors.md) | The Bitcoin transaction data |
| `depositOutputIndex` | `number` | The output index of the deposit |
| `deposit` | [`DepositReceipt`](../interfaces/DepositReceipt.md) | The deposit receipt containing all deposit parameters |
| `vault?` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) | Optional vault address |
| `signal?` | `AbortSignal` | Optional AbortSignal to cancel the reveal request, retry backoff delay, or conflict-status verification request. |

#### Returns

`Promise`\<[`Hex`](Hex.md) \| `TransactionReceipt`\>

The full transaction receipt from the relayer response

**`Throws`**

Error if deposit owner not set or relayer returns unexpected response

**`Throws`**

StarkNetRelayerDepositConflictError if the relayer reports the deposit
        already exists

#### Implementation of

[BitcoinDepositor](../interfaces/BitcoinDepositor.md).[initializeDeposit](../interfaces/BitcoinDepositor.md#initializedeposit)

#### Defined in

[src/lib/starknet/starknet-depositor.ts:603](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L603)

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

[src/lib/starknet/starknet-depositor.ts:992](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L992)

___

### queryRelayerDepositStatus

▸ **queryRelayerDepositStatus**(`depositId`, `signal?`): `Promise`\<`undefined` \| `RelayerDepositStatusResponse`\>

Queries the relayer's deposit-status endpoint for the current status of
a previously-revealed deposit.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositId` | `string` | Canonical decimal deposit ID as reported by the relayer |
| `signal?` | `AbortSignal` | Optional AbortSignal to cancel the request. |

#### Returns

`Promise`\<`undefined` \| `RelayerDepositStatusResponse`\>

The parsed status response, or undefined if the relayer did
         not confirm a recognized status for the deposit

#### Defined in

[src/lib/starknet/starknet-depositor.ts:895](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L895)

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

[src/lib/starknet/starknet-depositor.ts:543](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L543)
