# Class: DepositsService

Service exposing features related to tBTC v2 deposits.

## Table of contents

### Constructors

- [constructor](DepositsService.md#constructor)

### Properties

- [#crossChainContracts](DepositsService.md##crosschaincontracts)
- [#defaultDepositor](DepositsService.md##defaultdepositor)
- [#nativeBTCDepositor](DepositsService.md##nativebtcdepositor)
- [ADDRESS\_HEX\_CHARS](DepositsService.md#address_hex_chars)
- [ADDRESS\_HEX\_LENGTH](DepositsService.md#address_hex_length)
- [BYTES32\_HEX\_LENGTH](DepositsService.md#bytes32_hex_length)
- [SUPPORTED\_GASLESS\_CHAINS](DepositsService.md#supported_gasless_chains)
- [bitcoinClient](DepositsService.md#bitcoinclient)
- [depositRefundLocktimeDuration](DepositsService.md#depositrefundlocktimeduration)
- [tbtcContracts](DepositsService.md#tbtccontracts)

### Methods

- [buildGaslessRelayPayload](DepositsService.md#buildgaslessrelaypayload)
- [generateDepositReceipt](DepositsService.md#generatedepositreceipt)
- [getNativeBTCDepositorAddress](DepositsService.md#getnativebtcdepositoraddress)
- [initiateCrossChainDeposit](DepositsService.md#initiatecrosschaindeposit)
- [initiateDeposit](DepositsService.md#initiatedeposit)
- [initiateDepositWithProxy](DepositsService.md#initiatedepositwithproxy)
- [initiateGaslessDeposit](DepositsService.md#initiategaslessdeposit)
- [initiateL1GaslessDeposit](DepositsService.md#initiatel1gaslessdeposit)
- [initiateL2GaslessDeposit](DepositsService.md#initiatel2gaslessdeposit)
- [resolveNativeBTCDepositorFromNetwork](DepositsService.md#resolvenativebtcdepositorfromnetwork)
- [setDefaultDepositor](DepositsService.md#setdefaultdepositor)
- [setNativeBTCDepositor](DepositsService.md#setnativebtcdepositor)

## Constructors

### constructor

• **new DepositsService**(`tbtcContracts`, `bitcoinClient`, `crossChainContracts`, `nativeBTCDepositor?`): [`DepositsService`](DepositsService.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `tbtcContracts` | [`TBTCContracts`](../README.md#tbtccontracts) |
| `bitcoinClient` | [`BitcoinClient`](../interfaces/BitcoinClient.md) |
| `crossChainContracts` | (`_`: [`DestinationChainName`](../README.md#destinationchainname)) => `undefined` \| [`CrossChainInterfaces`](../README.md#crosschaininterfaces) |
| `nativeBTCDepositor?` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) |

#### Returns

[`DepositsService`](DepositsService.md)

#### Defined in

[services/deposits/deposits-service.ts:235](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L235)

## Properties

### #crossChainContracts

• `Private` `Readonly` **#crossChainContracts**: (`_`: [`DestinationChainName`](../README.md#destinationchainname)) => `undefined` \| [`CrossChainInterfaces`](../README.md#crosschaininterfaces)

Gets cross-chain contracts for the given supported L2 chain.

#### Type declaration

▸ (`_`): `undefined` \| [`CrossChainInterfaces`](../README.md#crosschaininterfaces)

##### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `_` | [`DestinationChainName`](../README.md#destinationchainname) | Name of the L2 chain for which to get cross-chain contracts. |

##### Returns

`undefined` \| [`CrossChainInterfaces`](../README.md#crosschaininterfaces)

#### Defined in

[services/deposits/deposits-service.ts:226](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L226)

___

### #defaultDepositor

• `Private` **#defaultDepositor**: `undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

Chain-specific identifier of the default depositor used for deposits
initiated by this service.

#### Defined in

[services/deposits/deposits-service.ts:219](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L219)

___

### #nativeBTCDepositor

• `Private` **#nativeBTCDepositor**: `undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

Chain-specific identifier of the NativeBTCDepositor contract used for
L1 gasless deposits.

#### Defined in

[services/deposits/deposits-service.ts:233](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L233)

___

### ADDRESS\_HEX\_CHARS

• `Private` `Readonly` **ADDRESS\_HEX\_CHARS**: ``40``

Number of hex characters representing a 20-byte Ethereum address (40 chars).
Used when extracting address from bytes32 extraData.

#### Defined in

[services/deposits/deposits-service.ts:205](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L205)

___

### ADDRESS\_HEX\_LENGTH

• `Private` `Readonly` **ADDRESS\_HEX\_LENGTH**: ``42``

Hex string length for an Ethereum address (0x prefix + 40 hex characters).
Used for L2 deposit owner encoding and extraData validation.

#### Defined in

[services/deposits/deposits-service.ts:199](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L199)

___

### BYTES32\_HEX\_LENGTH

• `Private` `Readonly` **BYTES32\_HEX\_LENGTH**: ``66``

Hex string length for a bytes32 value (0x prefix + 64 hex characters).
Used for L1 deposit owner encoding and extraData validation.

#### Defined in

[services/deposits/deposits-service.ts:193](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L193)

___

### SUPPORTED\_GASLESS\_CHAINS

• `Private` `Readonly` **SUPPORTED\_GASLESS\_CHAINS**: readonly [``"L1"``, ``"Arbitrum"``, ``"Base"``, ``"Sui"``, ``"StarkNet"``]

List of chains that support gasless deposits.
- "L1": Direct L1 deposits via NativeBTCDepositor
- "Arbitrum", "Base", "Sui", "StarkNet": L2 deposits via L1BitcoinDepositor

Note: "Solana" is excluded as it uses a different architecture and
gasless deposit support is not yet confirmed.

#### Defined in

[services/deposits/deposits-service.ts:181](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L181)

___

### bitcoinClient

• `Private` `Readonly` **bitcoinClient**: [`BitcoinClient`](../interfaces/BitcoinClient.md)

Bitcoin client handle.

#### Defined in

[services/deposits/deposits-service.ts:214](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L214)

___

### depositRefundLocktimeDuration

• `Private` `Readonly` **depositRefundLocktimeDuration**: ``23328000``

Deposit refund locktime duration in seconds.
This is 9 month in seconds assuming 1 month = 30 days

#### Defined in

[services/deposits/deposits-service.ts:171](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L171)

___

### tbtcContracts

• `Private` `Readonly` **tbtcContracts**: [`TBTCContracts`](../README.md#tbtccontracts)

Handle to tBTC contracts.

#### Defined in

[services/deposits/deposits-service.ts:210](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L210)

## Methods

### buildGaslessRelayPayload

▸ **buildGaslessRelayPayload**(`receipt`, `fundingTxHash`, `fundingOutputIndex`, `destinationChainName`): `Promise`\<[`GaslessRevealPayload`](../interfaces/GaslessRevealPayload.md)\>

Builds the payload for backend gasless reveal endpoint.

This public method constructs the complete payload needed by the relayer
backend to submit a gasless deposit reveal transaction after the Bitcoin
funding transaction is confirmed. The method handles chain-specific owner
encoding requirements:
- L1 deposits: Encode owner as bytes32 (left-padded Ethereum address)
- L2 deposits: Extract 20-byte address from 32-byte extraData

The payload includes:
- Bitcoin funding transaction decomposed into vectors (version, inputs,
  outputs, locktime) - used by backend for deposit key computation
- Deposit reveal parameters from the receipt (blinding factor, wallet PKH,
  refund PKH, refund locktime, vault)
- Destination chain deposit owner (encoding varies by chain type)
- Destination chain name for backend routing (normalized to lowercase)

CRITICAL: This method provides raw Bitcoin transaction vectors to the
backend. The backend computes the depositKey using Bitcoin's hash256
(double-SHA256) algorithm, NOT keccak256. The SDK does not compute the
depositKey directly.

IMPORTANT: Chain names are automatically normalized to lowercase for
backend compatibility. The SDK accepts capitalized chain names (e.g.,
"Arbitrum", "Base") but converts them to lowercase (e.g., "arbitrum",
"base") in the returned payload. The exception is "L1" which remains
as-is.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `receipt` | [`DepositReceipt`](../interfaces/DepositReceipt.md) | Deposit receipt from initiateGaslessDeposit containing all deposit parameters. For L2 deposits, receipt MUST include extraData with the deposit owner address encoded. |
| `fundingTxHash` | [`BitcoinTxHash`](BitcoinTxHash.md) | Bitcoin transaction hash of the funding transaction. This transaction must be confirmed on Bitcoin network before calling this method. |
| `fundingOutputIndex` | `number` | Zero-based index of the deposit output in the funding transaction. Use the output index where the deposit script address received the funds. |
| `destinationChainName` | `string` | Target chain name for the deposit. Should match the chain name used in initiateGaslessDeposit: - "L1" for direct L1 deposits (remains "L1") - L2 chain names: "Arbitrum", "Base", "Sui", "StarkNet" (converted to lowercase in payload) |

#### Returns

`Promise`\<[`GaslessRevealPayload`](../interfaces/GaslessRevealPayload.md)\>

Promise resolving to GaslessRevealPayload ready for submission to
         backend POST /tbtc/gasless-reveal endpoint. The
         destinationChainName field will be lowercase (except "L1")

**`Throws`**

Error if extraData is missing for L2 deposits (cross-chain)

**`Throws`**

Error if extraData has invalid length for L2 deposits (must be 20
        or 32 bytes)

**`Throws`**

Error if Bitcoin transaction cannot be fetched from the client

**`Throws`**

Error if vault address cannot be retrieved from contracts

#### Defined in

[services/deposits/deposits-service.ts:562](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L562)

___

### generateDepositReceipt

▸ **generateDepositReceipt**(`bitcoinRecoveryAddress`, `depositor`, `extraData?`): `Promise`\<[`DepositReceipt`](../interfaces/DepositReceipt.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `bitcoinRecoveryAddress` | `string` |
| `depositor` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) |
| `extraData?` | [`Hex`](Hex.md) |

#### Returns

`Promise`\<[`DepositReceipt`](../interfaces/DepositReceipt.md)\>

#### Defined in

[services/deposits/deposits-service.ts:699](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L699)

___

### getNativeBTCDepositorAddress

▸ **getNativeBTCDepositorAddress**(): `undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

Gets the chain identifier of the NativeBTCDepositor contract.
This contract is used for L1 gasless deposits.

#### Returns

`undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

Chain identifier of the NativeBTCDepositor or undefined if not available.

#### Defined in

[services/deposits/deposits-service.ts:658](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L658)

___

### initiateCrossChainDeposit

▸ **initiateCrossChainDeposit**(`bitcoinRecoveryAddress`, `destinationChainName`): `Promise`\<[`Deposit`](Deposit.md)\>

Initiates the tBTC v2 cross-chain deposit process. A cross-chain deposit
is a deposit that targets an L2 chain other than the L1 chain the tBTC
system is deployed on. Such a deposit is initiated using a transaction
on the L2 chain. To make it happen, the given L2 cross-chain contracts
must be initialized along with a L2 signer first.

 THIS IS EXPERIMENTAL CODE THAT CAN BE CHANGED OR REMOVED
              IN FUTURE RELEASES. IT SHOULD BE USED ONLY FOR INTERNAL
              PURPOSES AND EXTERNAL APPLICATIONS SHOULD NOT DEPEND ON IT.
              CROSS-CHAIN SUPPORT IS NOT FULLY OPERATIONAL YET.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `bitcoinRecoveryAddress` | `string` | P2PKH or P2WPKH Bitcoin address that can be used for emergency recovery of the deposited funds. |
| `destinationChainName` | [`DestinationChainName`](../README.md#destinationchainname) | Name of the L2 chain the deposit is targeting. |

#### Returns

`Promise`\<[`Deposit`](Deposit.md)\>

Handle to the initiated deposit process.

**`Throws`**

Throws an error if one of the following occurs:
        - There are no active wallet in the Bridge contract
        - The Bitcoin recovery address is not a valid P2(W)PKH
        - The cross-chain contracts for the given L2 chain are not
          initialized
        - The L2 deposit owner cannot be resolved. This typically
          happens if the L2 cross-chain contracts operate with a
          read-only signer whose address cannot be resolved.

**`See`**

for cross-chain contracts initialization.

**`Dev`**

This is actually a call to initiateDepositWithProxy with a built-in
     depositor proxy.

#### Defined in

[services/deposits/deposits-service.ts:351](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L351)

___

### initiateDeposit

▸ **initiateDeposit**(`bitcoinRecoveryAddress`, `extraData?`): `Promise`\<[`Deposit`](Deposit.md)\>

Initiates the tBTC v2 deposit process.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `bitcoinRecoveryAddress` | `string` | P2PKH or P2WPKH Bitcoin address that can be used for emergency recovery of the deposited funds. |
| `extraData?` | [`Hex`](Hex.md) | Optional 32-byte extra data to be included in the deposit script. Cannot be equal to 32 zero bytes. |

#### Returns

`Promise`\<[`Deposit`](Deposit.md)\>

Handle to the initiated deposit process.

**`Throws`**

Throws an error if one of the following occurs:
        - The default depositor is not set
        - There are no active wallet in the Bridge contract
        - The Bitcoin recovery address is not a valid P2(W)PKH
        - The optional extra data is set but is not 32-byte or equals
          to 32 zero bytes.

#### Defined in

[services/deposits/deposits-service.ts:264](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L264)

___

### initiateDepositWithProxy

▸ **initiateDepositWithProxy**(`bitcoinRecoveryAddress`, `depositorProxy`, `extraData?`): `Promise`\<[`Deposit`](Deposit.md)\>

Initiates the tBTC v2 deposit process using a depositor proxy.
The depositor proxy initiates minting on behalf of the user (i.e. original
depositor) and receives minted TBTC. This allows the proxy to provide
additional services to the user, such as routing the minted TBTC tokens
to another protocols, in an automated way.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `bitcoinRecoveryAddress` | `string` | P2PKH or P2WPKH Bitcoin address that can be used for emergency recovery of the deposited funds. |
| `depositorProxy` | [`DepositorProxy`](../interfaces/DepositorProxy.md) | Depositor proxy used to initiate the deposit. |
| `extraData?` | [`Hex`](Hex.md) | Optional 32-byte extra data to be included in the deposit script. Cannot be equal to 32 zero bytes. |

#### Returns

`Promise`\<[`Deposit`](Deposit.md)\>

Handle to the initiated deposit process.

**`See`**

DepositorProxy

**`Throws`**

Throws an error if one of the following occurs:
        - There are no active wallet in the Bridge contract
        - The Bitcoin recovery address is not a valid P2(W)PKH
        - The optional extra data is set but is not 32-byte or equals
          to 32 zero bytes.

#### Defined in

[services/deposits/deposits-service.ts:303](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L303)

___

### initiateGaslessDeposit

▸ **initiateGaslessDeposit**(`bitcoinRecoveryAddress`, `depositOwner`, `destinationChainName`): `Promise`\<[`GaslessDepositResult`](../interfaces/GaslessDepositResult.md)\>

Initiates a gasless tBTC v2 deposit where the backend relayer pays all gas fees.

This method generates a deposit for backend relay, supporting both L1 and L2
(cross-chain) destinations. For L1 deposits, the NativeBTCDepositor contract
is used. For L2 deposits, the L1BitcoinDepositor contract is used with
proper extraData encoding for the destination chain.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `bitcoinRecoveryAddress` | `string` | P2PKH or P2WPKH Bitcoin address for emergency recovery |
| `depositOwner` | `string` | Ethereum address that will receive the minted tBTC. For L1 deposits, this is the user's Ethereum address. For L2 deposits, this is typically the signer's address (obtained from the destination chain BitcoinDepositor). |
| `destinationChainName` | [`GaslessDestination`](../README.md#gaslessdestination) | Target chain name for the deposit. Must be one of the supported chains (case-sensitive): - "L1" - Direct L1 deposits via NativeBTCDepositor - "Arbitrum" - Arbitrum L2 deposits - "Base" - Base L2 deposits - "Sui" - Sui L2 deposits - "StarkNet" - StarkNet L2 deposits (note: capital 'N') Note: "Solana" is not currently supported for gasless deposits |

#### Returns

`Promise`\<[`GaslessDepositResult`](../interfaces/GaslessDepositResult.md)\>

GaslessDepositResult containing deposit object, receipt, and chain name

**`Throws`**

Throws an error if:
        - Bitcoin recovery address is not P2PKH or P2WPKH
        - Deposit owner is not a valid Ethereum address
        - Destination chain name is not in the supported list
        - Destination chain contracts not initialized (for L2 deposits)
        - NativeBTCDepositor address not available (for L1 deposits)
        - Deposit owner cannot be resolved (for L2 deposits)
        - No active wallet in Bridge contract

#### Defined in

[services/deposits/deposits-service.ts:402](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L402)

___

### initiateL1GaslessDeposit

▸ **initiateL1GaslessDeposit**(`bitcoinRecoveryAddress`, `depositOwner`): `Promise`\<[`GaslessDepositResult`](../interfaces/GaslessDepositResult.md)\>

Internal helper for L1 gasless deposits using NativeBTCDepositor.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `bitcoinRecoveryAddress` | `string` | Bitcoin address for recovery if deposit fails (P2PKH or P2WPKH). |
| `depositOwner` | `string` | Ethereum address that will receive the minted tBTC on L1. |

#### Returns

`Promise`\<[`GaslessDepositResult`](../interfaces/GaslessDepositResult.md)\>

Promise resolving to GaslessDepositResult containing deposit, receipt, and "L1" chain name.

#### Defined in

[services/deposits/deposits-service.ts:431](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L431)

___

### initiateL2GaslessDeposit

▸ **initiateL2GaslessDeposit**(`bitcoinRecoveryAddress`, `destinationChainName`): `Promise`\<[`GaslessDepositResult`](../interfaces/GaslessDepositResult.md)\>

Internal helper for L2 gasless deposits using L1BitcoinDepositor.
Pattern based on initiateCrossChainDeposit.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `bitcoinRecoveryAddress` | `string` | Bitcoin address for recovery if deposit fails (P2PKH or P2WPKH). |
| `destinationChainName` | [`DestinationChainName`](../README.md#destinationchainname) | Name of the L2 destination chain (e.g., "Base", "Arbitrum", "Optimism"). |

#### Returns

`Promise`\<[`GaslessDepositResult`](../interfaces/GaslessDepositResult.md)\>

Promise resolving to GaslessDepositResult containing deposit, receipt, and destination chain name.

#### Defined in

[services/deposits/deposits-service.ts:478](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L478)

___

### resolveNativeBTCDepositorFromNetwork

▸ **resolveNativeBTCDepositorFromNetwork**(): `Promise`\<`undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)\>

Resolves the NativeBTCDepositor address from the current Bitcoin network
using the NATIVE_BTC_DEPOSITOR_ADDRESSES mapping.

#### Returns

`Promise`\<`undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)\>

Chain identifier of the NativeBTCDepositor contract, or undefined
         if the mapping is missing or invalid for the network.

#### Defined in

[services/deposits/deposits-service.ts:678](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L678)

___

### setDefaultDepositor

▸ **setDefaultDepositor**(`defaultDepositor`): `void`

Sets the default depositor used for deposits initiated by this service.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `defaultDepositor` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) | Chain-specific identifier of the default depositor. |

#### Returns

`void`

**`Dev`**

Typically, there is no need to use this method when DepositsService
     is orchestrated automatically. However, there are some use cases
     where setting the default depositor explicitly may be useful.
     Make sure you know what you are doing while using this method.

#### Defined in

[services/deposits/deposits-service.ts:777](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L777)

___

### setNativeBTCDepositor

▸ **setNativeBTCDepositor**(`nativeBTCDepositor`): `void`

Sets the NativeBTCDepositor address override used for L1 gasless deposits.
Useful for custom deployments or testing environments.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `nativeBTCDepositor` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) | Chain identifier of the NativeBTCDepositor contract to use. |

#### Returns

`void`

#### Defined in

[services/deposits/deposits-service.ts:668](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L668)
