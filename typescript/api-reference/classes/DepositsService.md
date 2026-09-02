# Class: DepositsService

Service exposing features related to tBTC v2 deposits.

## Table of contents

### Constructors

- [constructor](DepositsService.md#constructor)

### Properties

- [#crossChainContracts](DepositsService.md##crosschaincontracts)
- [#defaultDepositor](DepositsService.md##defaultdepositor)
- [#nativeBTCDepositor](DepositsService.md##nativebtcdepositor)
- [bitcoinClient](DepositsService.md#bitcoinclient)
- [depositRefundLocktimeDuration](DepositsService.md#depositrefundlocktimeduration)
- [tbtcContracts](DepositsService.md#tbtccontracts)

### Methods

- [buildGaslessRelayPayload](DepositsService.md#buildgaslessrelaypayload)
- [generateDepositReceipt](DepositsService.md#generatedepositreceipt)
- [initiateCrossChainDeposit](DepositsService.md#initiatecrosschaindeposit)
- [initiateDeposit](DepositsService.md#initiatedeposit)
- [initiateDepositWithProxy](DepositsService.md#initiatedepositwithproxy)
- [initiateGaslessDeposit](DepositsService.md#initiategaslessdeposit)
- [initiateL1GaslessDeposit](DepositsService.md#initiatel1gaslessdeposit)
- [initiateL2GaslessDeposit](DepositsService.md#initiatel2gaslessdeposit)
- [setCrossChainContractsResolver](DepositsService.md#setcrosschaincontractsresolver)
- [setDefaultDepositor](DepositsService.md#setdefaultdepositor)
- [setNativeBTCDepositor](DepositsService.md#setnativebtcdepositor)

## Constructors

### constructor

• **new DepositsService**(`tbtcContracts`, `bitcoinClient`, `crossChainContracts?`, `nativeBTCDepositor?`): [`DepositsService`](DepositsService.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `tbtcContracts` | [`TBTCContracts`](../README.md#tbtccontracts) |
| `bitcoinClient` | [`BitcoinClient`](../interfaces/BitcoinClient.md) |
| `crossChainContracts?` | (`_`: [`DestinationChainName`](../README.md#destinationchainname)) => `undefined` \| [`CrossChainInterfaces`](../README.md#crosschaininterfaces) |
| `nativeBTCDepositor?` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) |

#### Returns

[`DepositsService`](DepositsService.md)

#### Defined in

[src/services/deposits/deposits-service.ts:225](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L225)

## Properties

### #crossChainContracts

• `Private` **#crossChainContracts**: (`_`: [`DestinationChainName`](../README.md#destinationchainname)) => `undefined` \| [`CrossChainInterfaces`](../README.md#crosschaininterfaces)

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

[src/services/deposits/deposits-service.ts:216](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L216)

___

### #defaultDepositor

• `Private` **#defaultDepositor**: `undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

Chain-specific identifier of the default depositor used for deposits
initiated by this service.

#### Defined in

[src/services/deposits/deposits-service.ts:209](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L209)

___

### #nativeBTCDepositor

• `Private` **#nativeBTCDepositor**: `undefined` \| [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

Chain-specific identifier of the NativeBTCDepositor contract used for
L1 gasless deposits.

#### Defined in

[src/services/deposits/deposits-service.ts:223](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L223)

___

### bitcoinClient

• `Private` `Readonly` **bitcoinClient**: [`BitcoinClient`](../interfaces/BitcoinClient.md)

Bitcoin client handle.

#### Defined in

[src/services/deposits/deposits-service.ts:204](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L204)

___

### depositRefundLocktimeDuration

• `Private` `Readonly` **depositRefundLocktimeDuration**: ``15552000``

Deposit refund locktime duration in seconds.
This is 180 days (6 months assuming 1 month = 30 days).

#### Defined in

[src/services/deposits/deposits-service.ts:194](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L194)

___

### tbtcContracts

• `Private` `Readonly` **tbtcContracts**: [`TBTCContracts`](../README.md#tbtccontracts)

Handle to tBTC contracts.

#### Defined in

[src/services/deposits/deposits-service.ts:200](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L200)

## Methods

### buildGaslessRelayPayload

▸ **buildGaslessRelayPayload**(`receipt`, `fundingTxHash`, `fundingOutputIndex`, `destinationChainName`): `Promise`\<[`GaslessRevealPayload`](../interfaces/GaslessRevealPayload.md)\>

Builds the payload for backend gasless reveal endpoint.

 THIS IS EXPERIMENTAL CODE THAT CAN BE CHANGED OR REMOVED
              IN FUTURE RELEASES. IT SHOULD BE USED ONLY FOR INTERNAL
              PURPOSES AND EXTERNAL APPLICATIONS SHOULD NOT DEPEND ON IT.
              CROSS-CHAIN SUPPORT IS NOT FULLY OPERATIONAL YET.

The payload carries the Bitcoin funding transaction (decomposed into
version / inputVector / outputVector / locktime), the reveal parameters
from the receipt, the destination-chain deposit owner (32-byte extraData
passed through unchanged; the relayer or on-chain contract decodes per
chain type — see `EthereumExtraDataEncoder.decodeDepositOwner` and the
per-chain encoders under `typescript/src/lib/contracts/cross-chain.ts`),
and the destination chain name (lowercased for backend routing, except
"L1" which is preserved).

NOTE: The backend recovers the funding txid by `hash256` over the supplied
vectors, then computes
`depositKey = keccak256(abi.encodePacked(reversedTxHash, fundingOutputIndex))`
— see `EthereumBridge.buildDepositKey` at
`typescript/src/lib/ethereum/bridge.ts:478-481`. The SDK does not compute
the depositKey directly.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `receipt` | [`DepositReceipt`](../interfaces/DepositReceipt.md) | Deposit receipt from `initiateGaslessDeposit`. `receipt.extraData` MUST be present. |
| `fundingTxHash` | [`BitcoinTxHash`](BitcoinTxHash.md) | Bitcoin transaction hash of the funding transaction. |
| `fundingOutputIndex` | `number` | Zero-based index of the deposit output in the funding transaction (non-negative integer). |
| `destinationChainName` | ``"Base"`` \| ``"Arbitrum"`` \| ``"StarkNet"`` \| ``"Sui"`` \| ``"L1"`` | One of `SUPPORTED_GASLESS_CHAINS`. The wire format lowercases L2 chain names. |

#### Returns

`Promise`\<[`GaslessRevealPayload`](../interfaces/GaslessRevealPayload.md)\>

Payload ready for submission to the backend gasless-reveal endpoint.

#### Defined in

[src/services/deposits/deposits-service.ts:574](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L574)

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

[src/services/deposits/deposits-service.ts:667](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L667)

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

[src/services/deposits/deposits-service.ts:356](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L356)

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

[src/services/deposits/deposits-service.ts:269](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L269)

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

[src/services/deposits/deposits-service.ts:308](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L308)

___

### initiateGaslessDeposit

▸ **initiateGaslessDeposit**(`bitcoinRecoveryAddress`, `depositOwner`, `destinationChainName`): `Promise`\<[`GaslessDepositResult`](../interfaces/GaslessDepositResult.md)\>

Initiates a gasless tBTC v2 deposit where the backend relayer pays all gas fees.

 THIS IS EXPERIMENTAL CODE THAT CAN BE CHANGED OR REMOVED
              IN FUTURE RELEASES. IT SHOULD BE USED ONLY FOR INTERNAL
              PURPOSES AND EXTERNAL APPLICATIONS SHOULD NOT DEPEND ON IT.
              CROSS-CHAIN SUPPORT IS NOT FULLY OPERATIONAL YET.

For L1 destinations the `depositOwner` is encoded as bytes32 in extraData.
For L2 destinations the SDK throws if `depositOwner` does not match the
L2 signer's resolved owner (the resolved owner is authoritative — the
caller cannot override it).

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `bitcoinRecoveryAddress` | `string` | P2PKH or P2WPKH Bitcoin recovery address. |
| `depositOwner` | `string` | Ethereum address that will receive the minted tBTC. |
| `destinationChainName` | ``"Base"`` \| ``"Arbitrum"`` \| ``"StarkNet"`` \| ``"Sui"`` \| ``"L1"`` | Target chain name (one of `SUPPORTED_GASLESS_CHAINS`). |

#### Returns

`Promise`\<[`GaslessDepositResult`](../interfaces/GaslessDepositResult.md)\>

GaslessDepositResult containing deposit, receipt, and chain name.

#### Defined in

[src/services/deposits/deposits-service.ts:394](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L394)

___

### initiateL1GaslessDeposit

▸ **initiateL1GaslessDeposit**(`bitcoinRecoveryAddress`, `depositOwner`): `Promise`\<[`GaslessDepositResult`](../interfaces/GaslessDepositResult.md)\>

Internal helper for L1 gasless deposits using the NativeBTCDepositor contract
configured via the constructor or `setNativeBTCDepositor`.

 THIS IS EXPERIMENTAL CODE THAT CAN BE CHANGED OR REMOVED
              IN FUTURE RELEASES. IT SHOULD BE USED ONLY FOR INTERNAL
              PURPOSES AND EXTERNAL APPLICATIONS SHOULD NOT DEPEND ON IT.
              CROSS-CHAIN SUPPORT IS NOT FULLY OPERATIONAL YET.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `bitcoinRecoveryAddress` | `string` | P2PKH or P2WPKH Bitcoin recovery address. |
| `depositOwner` | `string` | Ethereum address that will receive the minted tBTC on L1. Validated and encoded as bytes32 in extraData. |

#### Returns

`Promise`\<[`GaslessDepositResult`](../interfaces/GaslessDepositResult.md)\>

Promise resolving to the GaslessDepositResult for the L1 deposit.

**`Throws`**

Error if `depositOwner` is not a valid 20-byte Ethereum address or
        if no NativeBTCDepositor address has been configured.

#### Defined in

[src/services/deposits/deposits-service.ts:432](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L432)

___

### initiateL2GaslessDeposit

▸ **initiateL2GaslessDeposit**(`bitcoinRecoveryAddress`, `destinationChainName`, `depositOwner`): `Promise`\<[`GaslessDepositResult`](../interfaces/GaslessDepositResult.md)\>

Internal helper for L2 gasless deposits using L1BitcoinDepositor with
L1-transaction reveal mode.

 THIS IS EXPERIMENTAL CODE THAT CAN BE CHANGED OR REMOVED
              IN FUTURE RELEASES. IT SHOULD BE USED ONLY FOR INTERNAL
              PURPOSES AND EXTERNAL APPLICATIONS SHOULD NOT DEPEND ON IT.
              CROSS-CHAIN SUPPORT IS NOT FULLY OPERATIONAL YET.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `bitcoinRecoveryAddress` | `string` | P2PKH or P2WPKH Bitcoin recovery address. |
| `destinationChainName` | ``"Base"`` \| ``"Arbitrum"`` \| ``"StarkNet"`` \| ``"Sui"`` | L2 destination chain. |
| `depositOwner` | `string` | Ethereum address that the caller wants to receive the minted tBTC. Must match the resolved L2 signer owner; otherwise throws (the resolved owner is authoritative — callers cannot override). |

#### Returns

`Promise`\<[`GaslessDepositResult`](../interfaces/GaslessDepositResult.md)\>

Promise resolving to the GaslessDepositResult for the L2 deposit.

#### Defined in

[src/services/deposits/deposits-service.ts:486](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L486)

___

### setCrossChainContractsResolver

▸ **setCrossChainContractsResolver**(`resolver`): `void`

Sets the cross-chain contracts resolver after construction. This is
used by the TBTC class to wire up cross-chain contract resolution
once the loader is ready.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `resolver` | (`_`: [`DestinationChainName`](../README.md#destinationchainname)) => `undefined` \| [`CrossChainInterfaces`](../README.md#crosschaininterfaces) | Function that returns cross-chain contracts for a given destination chain name, or undefined if not initialized. |

#### Returns

`void`

#### Defined in

[src/services/deposits/deposits-service.ts:248](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L248)

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

[src/services/deposits/deposits-service.ts:745](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L745)

___

### setNativeBTCDepositor

▸ **setNativeBTCDepositor**(`nativeBTCDepositor`): `void`

Sets the NativeBTCDepositor address used for L1 gasless deposits.

Required for any gasless L1 deposit. There is no auto-resolve from
`BitcoinNetwork` anymore — the SDK cannot verify a deployed contract
address, so the caller is responsible for supplying the canonical
NativeBTCDepositor contract address for the target Ethereum network.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `nativeBTCDepositor` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) | Chain identifier of the NativeBTCDepositor contract. Must be a valid Ethereum address (40 hex chars, non-zero). Solana/StarkNet/Sui/other identifiers are rejected. |

#### Returns

`void`

**`Throws`**

If the identifier is not a valid Ethereum address.

#### Defined in

[src/services/deposits/deposits-service.ts:651](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L651)
