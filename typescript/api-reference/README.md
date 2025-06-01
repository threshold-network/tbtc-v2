# @keep-network/tbtc-v2.ts

## Table of contents

### Namespaces

- [BitcoinNetwork](modules/BitcoinNetwork.md)
- [Chains](modules/Chains.md)
- [GetChainEvents](modules/GetChainEvents.md)
- [WalletState](modules/WalletState.md)

### Enumerations

- [ApiUrl](enums/ApiUrl.md)
- [BitcoinNetwork](enums/BitcoinNetwork-1.md)
- [DepositState](enums/DepositState.md)
- [WalletState](enums/WalletState-1.md)
- [endpointUrl](enums/endpointUrl.md)

### Classes

- [ArbitrumL2BitcoinDepositor](classes/ArbitrumL2BitcoinDepositor.md)
- [ArbitrumL2TBTCToken](classes/ArbitrumL2TBTCToken.md)
- [BaseL2BitcoinDepositor](classes/BaseL2BitcoinDepositor.md)
- [BaseL2TBTCToken](classes/BaseL2TBTCToken.md)
- [BitcoinTxHash](classes/BitcoinTxHash.md)
- [CrossChainDepositor](classes/CrossChainDepositor.md)
- [Deposit](classes/Deposit.md)
- [DepositFunding](classes/DepositFunding.md)
- [DepositRefund](classes/DepositRefund.md)
- [DepositScript](classes/DepositScript.md)
- [DepositsService](classes/DepositsService.md)
- [ElectrumClient](classes/ElectrumClient.md)
- [EthereumAddress](classes/EthereumAddress.md)
- [EthereumBridge](classes/EthereumBridge.md)
- [EthereumCrossChainExtraDataEncoder](classes/EthereumCrossChainExtraDataEncoder.md)
- [EthereumDepositorProxy](classes/EthereumDepositorProxy.md)
- [EthereumL1BitcoinDepositor](classes/EthereumL1BitcoinDepositor.md)
- [EthereumTBTCToken](classes/EthereumTBTCToken.md)
- [EthereumTBTCVault](classes/EthereumTBTCVault.md)
- [EthereumWalletRegistry](classes/EthereumWalletRegistry.md)
- [Hex](classes/Hex.md)
- [MaintenanceService](classes/MaintenanceService.md)
- [OptimisticMinting](classes/OptimisticMinting.md)
- [RedemptionsService](classes/RedemptionsService.md)
- [Spv](classes/Spv.md)
- [StarkNetAddress](classes/StarkNetAddress.md)
- [StarkNetCrossChainExtraDataEncoder](classes/StarkNetCrossChainExtraDataEncoder.md)
- [StarkNetDepositorInterface](classes/StarkNetDepositorInterface.md)
- [StarkNetTBTCToken](classes/StarkNetTBTCToken.md)
- [TBTC](classes/TBTC.md)
- [WalletTx](classes/WalletTx.md)

### Interfaces

- [BitcoinClient](interfaces/BitcoinClient.md)
- [BitcoinHeader](interfaces/BitcoinHeader.md)
- [BitcoinRawTx](interfaces/BitcoinRawTx.md)
- [BitcoinRawTxVectors](interfaces/BitcoinRawTxVectors.md)
- [BitcoinSpvProof](interfaces/BitcoinSpvProof.md)
- [BitcoinTx](interfaces/BitcoinTx.md)
- [BitcoinTxMerkleBranch](interfaces/BitcoinTxMerkleBranch.md)
- [BitcoinTxOutpoint](interfaces/BitcoinTxOutpoint.md)
- [BitcoinTxOutput](interfaces/BitcoinTxOutput.md)
- [Bridge](interfaces/Bridge.md)
- [ChainEvent](interfaces/ChainEvent.md)
- [ChainIdentifier](interfaces/ChainIdentifier.md)
- [CrossChainContractsLoader](interfaces/CrossChainContractsLoader.md)
- [CrossChainExtraDataEncoder](interfaces/CrossChainExtraDataEncoder.md)
- [DepositReceipt](interfaces/DepositReceipt.md)
- [DepositRequest](interfaces/DepositRequest.md)
- [DepositorProxy](interfaces/DepositorProxy.md)
- [ElectrumCredentials](interfaces/ElectrumCredentials.md)
- [EthereumContractConfig](interfaces/EthereumContractConfig.md)
- [L1BitcoinDepositor](interfaces/L1BitcoinDepositor.md)
- [L2BitcoinDepositor](interfaces/L2BitcoinDepositor.md)
- [L2TBTCToken](interfaces/L2TBTCToken.md)
- [RedeemerProxy](interfaces/RedeemerProxy.md)
- [RedemptionRequest](interfaces/RedemptionRequest.md)
- [RedemptionWallet](interfaces/RedemptionWallet.md)
- [SerializableWallet](interfaces/SerializableWallet.md)
- [TBTCToken](interfaces/TBTCToken.md)
- [TBTCVault](interfaces/TBTCVault.md)
- [ValidRedemptionWallet](interfaces/ValidRedemptionWallet.md)
- [Wallet](interfaces/Wallet.md)
- [WalletRegistry](interfaces/WalletRegistry.md)

### Type Aliases

- [BitcoinTxInput](README.md#bitcointxinput)
- [BitcoinUtxo](README.md#bitcoinutxo)
- [ChainMapping](README.md#chainmapping)
- [CrossChainContracts](README.md#crosschaincontracts)
- [CrossChainDepositorMode](README.md#crosschaindepositormode)
- [DepositRevealedEvent](README.md#depositrevealedevent)
- [DkgResultApprovedEvent](README.md#dkgresultapprovedevent)
- [DkgResultChallengedEvent](README.md#dkgresultchallengedevent)
- [DkgResultSubmittedEvent](README.md#dkgresultsubmittedevent)
- [ElectrumClientOptions](README.md#electrumclientoptions)
- [ErrorMatcherFn](README.md#errormatcherfn)
- [EthereumSigner](README.md#ethereumsigner)
- [ExecutionLoggerFn](README.md#executionloggerfn)
- [L1CrossChainContracts](README.md#l1crosschaincontracts)
- [L2Chain](README.md#l2chain)
- [L2CrossChainContracts](README.md#l2crosschaincontracts)
- [NewWalletRegisteredEvent](README.md#newwalletregisteredevent)
- [OptimisticMintingCancelledEvent](README.md#optimisticmintingcancelledevent)
- [OptimisticMintingFinalizedEvent](README.md#optimisticmintingfinalizedevent)
- [OptimisticMintingRequest](README.md#optimisticmintingrequest)
- [OptimisticMintingRequestedEvent](README.md#optimisticmintingrequestedevent)
- [RedemptionRequestedEvent](README.md#redemptionrequestedevent)
- [RetrierFn](README.md#retrierfn)
- [TBTCContracts](README.md#tbtccontracts)

### Variables

- [BitcoinAddressConverter](README.md#bitcoinaddressconverter)
- [BitcoinCompactSizeUint](README.md#bitcoincompactsizeuint)
- [BitcoinHashUtils](README.md#bitcoinhashutils)
- [BitcoinHeaderSerializer](README.md#bitcoinheaderserializer)
- [BitcoinLocktimeUtils](README.md#bitcoinlocktimeutils)
- [BitcoinPrivateKeyUtils](README.md#bitcoinprivatekeyutils)
- [BitcoinPublicKeyUtils](README.md#bitcoinpublickeyutils)
- [BitcoinScriptUtils](README.md#bitcoinscriptutils)
- [BitcoinTargetConverter](README.md#bitcointargetconverter)
- [ChainMappings](README.md#chainmappings)

### Functions

- [amountToSatoshi](README.md#amounttosatoshi)
- [assembleBitcoinSpvProof](README.md#assemblebitcoinspvproof)
- [backoffRetrier](README.md#backoffretrier)
- [chainIdFromSigner](README.md#chainidfromsigner)
- [computeElectrumScriptHash](README.md#computeelectrumscripthash)
- [ethereumAddressFromSigner](README.md#ethereumaddressfromsigner)
- [ethereumCrossChainContractsLoader](README.md#ethereumcrosschaincontractsloader)
- [extractBitcoinRawTxVectors](README.md#extractbitcoinrawtxvectors)
- [loadArbitrumCrossChainContracts](README.md#loadarbitrumcrosschaincontracts)
- [loadBaseCrossChainContracts](README.md#loadbasecrosschaincontracts)
- [loadEthereumCoreContracts](README.md#loadethereumcorecontracts)
- [loadStarkNetCrossChainContracts](README.md#loadstarknetcrosschaincontracts)
- [packRevealDepositParameters](README.md#packrevealdepositparameters)
- [retryAll](README.md#retryall)
- [skipRetryWhenMatched](README.md#skipretrywhenmatched)
- [toBitcoinJsLibNetwork](README.md#tobitcoinjslibnetwork)
- [validateBitcoinHeadersChain](README.md#validatebitcoinheaderschain)
- [validateBitcoinSpvProof](README.md#validatebitcoinspvproof)
- [validateDepositReceipt](README.md#validatedepositreceipt)

## Type Aliases

### BitcoinTxInput

Ƭ **BitcoinTxInput**: [`BitcoinTxOutpoint`](interfaces/BitcoinTxOutpoint.md) & \{ `scriptSig`: [`Hex`](classes/Hex.md)  }

Data about a Bitcoin transaction input.

#### Defined in

[lib/bitcoin/tx.ts:63](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/tx.ts#L63)

___

### BitcoinUtxo

Ƭ **BitcoinUtxo**: [`BitcoinTxOutpoint`](interfaces/BitcoinTxOutpoint.md) & \{ `value`: `BigNumber`  }

Data about a Bitcoin unspent transaction output.

#### Defined in

[lib/bitcoin/tx.ts:93](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/tx.ts#L93)

___

### ChainMapping

Ƭ **ChainMapping**: `Object`

Type representing a mapping between specific L1 and L2 chains.

#### Type declaration

| Name | Type | Description |
| :------ | :------ | :------ |
| `arbitrum?` | [`Arbitrum`](enums/Chains.Arbitrum.md) | Identifier of the Arbitrum L2 chain. |
| `base?` | [`Base`](enums/Chains.Base.md) | Identifier of the Base L2 chain. |
| `ethereum?` | [`Ethereum`](enums/Chains.Ethereum.md) | Identifier of the Ethereum L1 chain. |
| `starknet?` | [`StarkNet`](enums/Chains.StarkNet.md) | Identifier of the StarkNet L2 chain. |

#### Defined in

[lib/contracts/chain.ts:45](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/chain.ts#L45)

___

### CrossChainContracts

Ƭ **CrossChainContracts**: [`L2CrossChainContracts`](README.md#l2crosschaincontracts) & [`L1CrossChainContracts`](README.md#l1crosschaincontracts)

Convenience type aggregating TBTC cross-chain contracts forming a connector
between TBTC L1 ledger chain and a specific supported L2/side-chain.

#### Defined in

[lib/contracts/cross-chain.ts:12](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L12)

___

### CrossChainDepositorMode

Ƭ **CrossChainDepositorMode**: ``"L2Transaction"`` \| ``"L1Transaction"``

Mode of operation for the cross-chain depositor proxy:
- [L2Transaction]: The proxy will reveal the deposit using a transaction on
  the L2 chain. The tBTC system is responsible for relaying the deposit to
  the tBTC L1 chain.
- [L1Transaction]: The proxy will directly reveal the deposit using a
  transaction on the tBTC L1 chain.

#### Defined in

[services/deposits/cross-chain.ts:19](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/cross-chain.ts#L19)

___

### DepositRevealedEvent

Ƭ **DepositRevealedEvent**: [`DepositReceipt`](interfaces/DepositReceipt.md) & `Pick`\<[`DepositRequest`](interfaces/DepositRequest.md), ``"amount"`` \| ``"vault"``\> & \{ `fundingOutputIndex`: `number` ; `fundingTxHash`: [`BitcoinTxHash`](classes/BitcoinTxHash.md)  } & [`ChainEvent`](interfaces/ChainEvent.md)

Represents an event emitted on deposit reveal to the on-chain bridge.

#### Defined in

[lib/contracts/bridge.ts:307](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L307)

___

### DkgResultApprovedEvent

Ƭ **DkgResultApprovedEvent**: \{ `approver`: [`ChainIdentifier`](interfaces/ChainIdentifier.md) ; `resultHash`: [`Hex`](classes/Hex.md)  } & [`ChainEvent`](interfaces/ChainEvent.md)

Represents an event emitted when a DKG result is approved on the on-chain
wallet registry.

#### Defined in

[lib/contracts/wallet-registry.ts:64](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/wallet-registry.ts#L64)

___

### DkgResultChallengedEvent

Ƭ **DkgResultChallengedEvent**: \{ `challenger`: [`ChainIdentifier`](interfaces/ChainIdentifier.md) ; `reason`: `string` ; `resultHash`: [`Hex`](classes/Hex.md)  } & [`ChainEvent`](interfaces/ChainEvent.md)

Represents an event emitted when a DKG result is challenged on the on-chain
wallet registry.

#### Defined in

[lib/contracts/wallet-registry.ts:79](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/wallet-registry.ts#L79)

___

### DkgResultSubmittedEvent

Ƭ **DkgResultSubmittedEvent**: \{ `result`: `DkgResult` ; `resultHash`: [`Hex`](classes/Hex.md) ; `seed`: [`Hex`](classes/Hex.md)  } & [`ChainEvent`](interfaces/ChainEvent.md)

Represents an event emitted when a DKG result is submitted to the on-chain
wallet registry.

#### Defined in

[lib/contracts/wallet-registry.ts:45](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/wallet-registry.ts#L45)

___

### ElectrumClientOptions

Ƭ **ElectrumClientOptions**: `object`

Additional options used by the Electrum server.

#### Defined in

[lib/electrum/client.ts:49](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L49)

___

### ErrorMatcherFn

Ƭ **ErrorMatcherFn**: (`err`: `unknown`) => `boolean`

#### Type declaration

▸ (`err`): `boolean`

##### Parameters

| Name | Type |
| :------ | :------ |
| `err` | `unknown` |

##### Returns

`boolean`

True if the error matches, false otherwise.

#### Defined in

[lib/utils/backoff.ts:42](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/backoff.ts#L42)

___

### EthereumSigner

Ƭ **EthereumSigner**: `Signer` \| `providers.Provider`

Represents an Ethereum signer. This type is a wrapper for Ethers-specific
types and can be either a Signer that can make write transactions
or a Provider that works only in the read-only mode.

#### Defined in

[lib/ethereum/index.ts:34](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/index.ts#L34)

___

### ExecutionLoggerFn

Ƭ **ExecutionLoggerFn**: (`msg`: `string`) => `void`

#### Type declaration

▸ (`msg`): `void`

A function that is called with execution status messages.

##### Parameters

| Name | Type |
| :------ | :------ |
| `msg` | `string` |

##### Returns

`void`

#### Defined in

[lib/utils/backoff.ts:56](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/backoff.ts#L56)

___

### L1CrossChainContracts

Ƭ **L1CrossChainContracts**: `Object`

Aggregates L1-specific TBTC cross-chain contracts.

#### Type declaration

| Name | Type |
| :------ | :------ |
| `l1BitcoinDepositor` | [`L1BitcoinDepositor`](interfaces/L1BitcoinDepositor.md) |

#### Defined in

[lib/contracts/cross-chain.ts:25](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L25)

___

### L2Chain

Ƭ **L2Chain**: `Exclude`\<keyof typeof [`Chains`](modules/Chains.md), ``"Ethereum"``\>

Layer 2 chains supported by tBTC v2 contracts.

#### Defined in

[lib/contracts/chain.ts:40](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/chain.ts#L40)

___

### L2CrossChainContracts

Ƭ **L2CrossChainContracts**: `Object`

Aggregates L2-specific TBTC cross-chain contracts.

#### Type declaration

| Name | Type |
| :------ | :------ |
| `l2BitcoinDepositor` | [`L2BitcoinDepositor`](interfaces/L2BitcoinDepositor.md) |
| `l2TbtcToken` | [`L2TBTCToken`](interfaces/L2TBTCToken.md) |

#### Defined in

[lib/contracts/cross-chain.ts:17](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/cross-chain.ts#L17)

___

### NewWalletRegisteredEvent

Ƭ **NewWalletRegisteredEvent**: \{ `ecdsaWalletID`: [`Hex`](classes/Hex.md) ; `walletPublicKeyHash`: [`Hex`](classes/Hex.md)  } & [`ChainEvent`](interfaces/ChainEvent.md)

Represents an event emitted when new wallet is registered on the on-chain bridge.

#### Defined in

[lib/contracts/bridge.ts:471](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L471)

___

### OptimisticMintingCancelledEvent

Ƭ **OptimisticMintingCancelledEvent**: \{ `depositKey`: [`Hex`](classes/Hex.md) ; `guardian`: [`ChainIdentifier`](interfaces/ChainIdentifier.md)  } & [`ChainEvent`](interfaces/ChainEvent.md)

Represents an event that is emitted when an optimistic minting request
is cancelled on chain.

#### Defined in

[lib/contracts/tbtc-vault.ts:170](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/tbtc-vault.ts#L170)

___

### OptimisticMintingFinalizedEvent

Ƭ **OptimisticMintingFinalizedEvent**: \{ `depositKey`: [`Hex`](classes/Hex.md) ; `depositor`: [`ChainIdentifier`](interfaces/ChainIdentifier.md) ; `minter`: [`ChainIdentifier`](interfaces/ChainIdentifier.md) ; `optimisticMintingDebt`: `BigNumber`  } & [`ChainEvent`](interfaces/ChainEvent.md)

Represents an event that is emitted when an optimistic minting request
is finalized on chain.

#### Defined in

[lib/contracts/tbtc-vault.ts:186](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/tbtc-vault.ts#L186)

___

### OptimisticMintingRequest

Ƭ **OptimisticMintingRequest**: `Object`

Represents optimistic minting request for the given deposit revealed to the
Bridge.

#### Type declaration

| Name | Type | Description |
| :------ | :------ | :------ |
| `finalizedAt` | `number` | UNIX timestamp at which the optimistic minting was finalized. 0 if not yet finalized. |
| `requestedAt` | `number` | UNIX timestamp at which the optimistic minting was requested. |

#### Defined in

[lib/contracts/tbtc-vault.ts:120](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/tbtc-vault.ts#L120)

___

### OptimisticMintingRequestedEvent

Ƭ **OptimisticMintingRequestedEvent**: \{ `amount`: `BigNumber` ; `depositKey`: [`Hex`](classes/Hex.md) ; `depositor`: [`ChainIdentifier`](interfaces/ChainIdentifier.md) ; `fundingOutputIndex`: `number` ; `fundingTxHash`: [`BitcoinTxHash`](classes/BitcoinTxHash.md) ; `minter`: [`ChainIdentifier`](interfaces/ChainIdentifier.md)  } & [`ChainEvent`](interfaces/ChainEvent.md)

Represents an event that is emitted when a new optimistic minting is requested
on chain.

#### Defined in

[lib/contracts/tbtc-vault.ts:136](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/tbtc-vault.ts#L136)

___

### RedemptionRequestedEvent

Ƭ **RedemptionRequestedEvent**: `Omit`\<[`RedemptionRequest`](interfaces/RedemptionRequest.md), ``"requestedAt"``\> & \{ `walletPublicKeyHash`: [`Hex`](classes/Hex.md)  } & [`ChainEvent`](interfaces/ChainEvent.md)

Represents an event emitted on redemption request.

#### Defined in

[lib/contracts/bridge.ts:358](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L358)

___

### RetrierFn

Ƭ **RetrierFn**\<`T`\>: (`fn`: () => `Promise`\<`T`\>) => `Promise`\<`T`\>

#### Type parameters

| Name |
| :------ |
| `T` |

#### Type declaration

▸ (`fn`): `Promise`\<`T`\>

##### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `fn` | () => `Promise`\<`T`\> | The function to be retried. |

##### Returns

`Promise`\<`T`\>

#### Defined in

[lib/utils/backoff.ts:51](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/backoff.ts#L51)

___

### TBTCContracts

Ƭ **TBTCContracts**: `Object`

Convenience type aggregating all TBTC core contracts.

#### Type declaration

| Name | Type |
| :------ | :------ |
| `bridge` | [`Bridge`](interfaces/Bridge.md) |
| `tbtcToken` | [`TBTCToken`](interfaces/TBTCToken.md) |
| `tbtcVault` | [`TBTCVault`](interfaces/TBTCVault.md) |
| `walletRegistry` | [`WalletRegistry`](interfaces/WalletRegistry.md) |

#### Defined in

[lib/contracts/index.ts:19](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/index.ts#L19)

## Variables

### BitcoinAddressConverter

• `Const` **BitcoinAddressConverter**: `Object`

Utility functions allowing to perform Bitcoin address conversions.

#### Type declaration

| Name | Type |
| :------ | :------ |
| `addressToOutputScript` | (`address`: `string`, `bitcoinNetwork`: [`BitcoinNetwork`](enums/BitcoinNetwork-1.md)) => [`Hex`](classes/Hex.md) |
| `addressToPublicKeyHash` | (`address`: `string`, `bitcoinNetwork`: [`BitcoinNetwork`](enums/BitcoinNetwork-1.md)) => [`Hex`](classes/Hex.md) |
| `outputScriptToAddress` | (`script`: [`Hex`](classes/Hex.md), `bitcoinNetwork`: [`BitcoinNetwork`](enums/BitcoinNetwork-1.md)) => `string` |
| `publicKeyHashToAddress` | (`publicKeyHash`: [`Hex`](classes/Hex.md), `witness`: `boolean`, `bitcoinNetwork`: [`BitcoinNetwork`](enums/BitcoinNetwork-1.md)) => `string` |
| `publicKeyToAddress` | (`publicKey`: [`Hex`](classes/Hex.md), `bitcoinNetwork`: [`BitcoinNetwork`](enums/BitcoinNetwork-1.md), `witness`: `boolean`) => `string` |

#### Defined in

[lib/bitcoin/address.ts:112](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/address.ts#L112)

___

### BitcoinCompactSizeUint

• `Const` **BitcoinCompactSizeUint**: `Object`

Utility functions allowing to deal with Bitcoin compact size uints.

#### Type declaration

| Name | Type |
| :------ | :------ |
| `read` | (`varLenData`: [`Hex`](classes/Hex.md)) => \{ `byteLength`: `number` ; `value`: `number`  } |

#### Defined in

[lib/bitcoin/csuint.ts:50](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/csuint.ts#L50)

___

### BitcoinHashUtils

• `Const` **BitcoinHashUtils**: `Object`

Utility functions allowing to deal with Bitcoin hashes.

#### Type declaration

| Name | Type |
| :------ | :------ |
| `computeHash160` | (`text`: [`Hex`](classes/Hex.md)) => [`Hex`](classes/Hex.md) |
| `computeHash256` | (`text`: [`Hex`](classes/Hex.md)) => [`Hex`](classes/Hex.md) |
| `computeSha256` | (`text`: [`Hex`](classes/Hex.md)) => [`Hex`](classes/Hex.md) |
| `hashLEToBigNumber` | (`hash`: [`Hex`](classes/Hex.md)) => `BigNumber` |

#### Defined in

[lib/bitcoin/hash.ts:52](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/hash.ts#L52)

___

### BitcoinHeaderSerializer

• `Const` **BitcoinHeaderSerializer**: `Object`

Utility functions allowing to serialize and deserialize Bitcoin block headers.

#### Type declaration

| Name | Type |
| :------ | :------ |
| `deserializeHeader` | (`rawHeader`: [`Hex`](classes/Hex.md)) => [`BitcoinHeader`](interfaces/BitcoinHeader.md) |
| `deserializeHeadersChain` | (`rawHeadersChain`: [`Hex`](classes/Hex.md)) => [`BitcoinHeader`](interfaces/BitcoinHeader.md)[] |
| `serializeHeader` | (`header`: [`BitcoinHeader`](interfaces/BitcoinHeader.md)) => [`Hex`](classes/Hex.md) |

#### Defined in

[lib/bitcoin/header.ts:109](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/header.ts#L109)

___

### BitcoinLocktimeUtils

• `Const` **BitcoinLocktimeUtils**: `Object`

Utility functions allowing to deal with Bitcoin locktime.

#### Type declaration

| Name | Type |
| :------ | :------ |
| `calculateLocktime` | (`locktimeStartedAt`: `number`, `locktimeDuration`: `number`) => [`Hex`](classes/Hex.md) |
| `locktimeToNumber` | (`locktimeLE`: `string` \| `Buffer`\<`ArrayBufferLike`\>) => `number` |

#### Defined in

[lib/bitcoin/tx.ts:234](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/tx.ts#L234)

___

### BitcoinPrivateKeyUtils

• `Const` **BitcoinPrivateKeyUtils**: `Object`

Utility functions allowing to perform operations on Bitcoin ECDSA private keys.

#### Type declaration

| Name | Type |
| :------ | :------ |
| `createKeyPair` | (`privateKey`: `string`, `bitcoinNetwork`: [`BitcoinNetwork`](enums/BitcoinNetwork-1.md)) => `ECPairInterface` |

#### Defined in

[lib/bitcoin/ecdsa-key.ts:77](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/ecdsa-key.ts#L77)

___

### BitcoinPublicKeyUtils

• `Const` **BitcoinPublicKeyUtils**: `Object`

Utility functions allowing to perform operations on Bitcoin ECDSA public keys.

#### Type declaration

| Name | Type |
| :------ | :------ |
| `compressPublicKey` | (`publicKey`: [`Hex`](classes/Hex.md)) => `string` |
| `isCompressedPublicKey` | (`publicKey`: [`Hex`](classes/Hex.md)) => `boolean` |

#### Defined in

[lib/bitcoin/ecdsa-key.ts:51](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/ecdsa-key.ts#L51)

___

### BitcoinScriptUtils

• `Const` **BitcoinScriptUtils**: `Object`

Utility functions allowing to deal with Bitcoin scripts.

#### Type declaration

| Name | Type |
| :------ | :------ |
| `isP2PKHScript` | (`script`: [`Hex`](classes/Hex.md)) => `boolean` |
| `isP2SHScript` | (`script`: [`Hex`](classes/Hex.md)) => `boolean` |
| `isP2WPKHScript` | (`script`: [`Hex`](classes/Hex.md)) => `boolean` |
| `isP2WSHScript` | (`script`: [`Hex`](classes/Hex.md)) => `boolean` |

#### Defined in

[lib/bitcoin/script.ts:63](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/script.ts#L63)

___

### BitcoinTargetConverter

• `Const` **BitcoinTargetConverter**: `Object`

Utility functions allowing to perform Bitcoin target conversions.

#### Type declaration

| Name | Type |
| :------ | :------ |
| `bitsToTarget` | (`bits`: `number`) => `BigNumber` |
| `targetToDifficulty` | (`target`: `BigNumber`) => `BigNumber` |

#### Defined in

[lib/bitcoin/header.ts:268](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/header.ts#L268)

___

### ChainMappings

• `Const` **ChainMappings**: [`ChainMapping`](README.md#chainmapping)[]

List of chain mappings supported by tBTC v2 contracts.

#### Defined in

[lib/contracts/chain.ts:68](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/chain.ts#L68)

## Functions

### amountToSatoshi

▸ **amountToSatoshi**(`value`): `BigNumber`

Converts the amount to Satoshi precision.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `value` | `BigNumber` | The amount to be converted. |

#### Returns

`BigNumber`

The amount in Satoshi precision.

#### Defined in

[lib/utils/bitcoin.ts:8](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/bitcoin.ts#L8)

___

### assembleBitcoinSpvProof

▸ **assembleBitcoinSpvProof**(`transactionHash`, `requiredConfirmations`, `bitcoinClient`): `Promise`\<[`BitcoinTx`](interfaces/BitcoinTx.md) & [`BitcoinSpvProof`](interfaces/BitcoinSpvProof.md)\>

Assembles a proof that a given transaction was included in the blockchain and
has accumulated the required number of confirmations.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `transactionHash` | [`BitcoinTxHash`](classes/BitcoinTxHash.md) | Hash of the transaction being proven. |
| `requiredConfirmations` | `number` | Required number of confirmations. |
| `bitcoinClient` | [`BitcoinClient`](interfaces/BitcoinClient.md) | Bitcoin client used to interact with the network. |

#### Returns

`Promise`\<[`BitcoinTx`](interfaces/BitcoinTx.md) & [`BitcoinSpvProof`](interfaces/BitcoinSpvProof.md)\>

Bitcoin transaction along with the inclusion proof.

#### Defined in

[lib/bitcoin/spv.ts:75](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/spv.ts#L75)

___

### backoffRetrier

▸ **backoffRetrier**\<`T`\>(`retries`, `backoffStepMs?`, `logger?`, `errorMatcher?`): [`RetrierFn`](README.md#retrierfn)\<`T`\>

Returns a retrier that can be passed a function to be retried `retries`
number of times, with exponential backoff. The result will return the
function's return value if no exceptions are thrown. It will only retry if
the function throws an exception matched by `matcher`; {@see retryAll} can
be used to retry no matter the exception, though this is not necessarily
recommended in production.

Example usage:

     await url.get("https://example.com/") // may transiently fail
     // Retries 3 times with exponential backoff, no matter what error is
     // reported by `url.get`.
     backoffRetrier(3)(async () => url.get("https://example.com"))
     // Retries 3 times with exponential backoff, but only if the error
     // message includes "server unavailable".
     backoffRetrier(3, (_) => _.message.includes('server unavailable'))(
       async () => url.get("https://example.com"))
     )

#### Type parameters

| Name |
| :------ |
| `T` |

#### Parameters

| Name | Type | Default value | Description |
| :------ | :------ | :------ | :------ |
| `retries` | `number` | `undefined` | The number of retries to perform before bubbling the failure out. |
| `backoffStepMs` | `number` | `1000` | Initial backoff step in milliseconds that will be increased exponentially for subsequent retry attempts. (default = 1000 ms) |
| `logger` | [`ExecutionLoggerFn`](README.md#executionloggerfn) | `console.debug` | A logger function to pass execution messages. |
| `errorMatcher?` | [`ErrorMatcherFn`](README.md#errormatcherfn) | `retryAll` | A matcher function that receives the error when an exception is thrown, and returns true if the error should lead to a retry. A false return will rethrow the error and terminate the retry loop. |

#### Returns

[`RetrierFn`](README.md#retrierfn)\<`T`\>

A function that can retry any function.

#### Defined in

[lib/utils/backoff.ts:89](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/backoff.ts#L89)

___

### chainIdFromSigner

▸ **chainIdFromSigner**(`signer`): `Promise`\<`string`\>

Resolves the chain ID from the given signer.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `signer` | [`EthereumSigner`](README.md#ethereumsigner) | The signer whose chain ID should be resolved. |

#### Returns

`Promise`\<`string`\>

Chain ID as a string.

#### Defined in

[lib/ethereum/index.ts:41](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/index.ts#L41)

___

### computeElectrumScriptHash

▸ **computeElectrumScriptHash**(`script`): `string`

Converts a Bitcoin script to an Electrum script hash. See
[Electrum protocol][https://electrumx.readthedocs.io/en/stable/protocol-basics.html#script-hashes](https://electrumx.readthedocs.io/en/stable/protocol-basics.html#script-hashes)

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `script` | [`Hex`](classes/Hex.md) | Bitcoin script as hex string |

#### Returns

`string`

Electrum script hash as a hex string.

#### Defined in

[lib/electrum/client.ts:668](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/electrum/client.ts#L668)

___

### ethereumAddressFromSigner

▸ **ethereumAddressFromSigner**(`signer`): `Promise`\<[`EthereumAddress`](classes/EthereumAddress.md) \| `undefined`\>

Resolves the Ethereum address tied to the given signer. The address
cannot be resolved for signers that works in the read-only mode

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `signer` | [`EthereumSigner`](README.md#ethereumsigner) | The signer whose address should be resolved. |

#### Returns

`Promise`\<[`EthereumAddress`](classes/EthereumAddress.md) \| `undefined`\>

Ethereum address or undefined for read-only signers.

**`Throws`**

Throws an error if the address of the signer is not a proper
        Ethereum address.

#### Defined in

[lib/ethereum/index.ts:63](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/index.ts#L63)

___

### ethereumCrossChainContractsLoader

▸ **ethereumCrossChainContractsLoader**(`signer`, `chainId`): `Promise`\<[`CrossChainContractsLoader`](interfaces/CrossChainContractsLoader.md)\>

Creates the Ethereum implementation of tBTC cross-chain contracts loader.
The provided signer is attached to loaded L1 contracts. The given
Ethereum chain ID is used to load the L1 contracts and resolve the chain
mapping that provides corresponding L2 chains IDs.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `signer` | [`EthereumSigner`](README.md#ethereumsigner) | Ethereum L1 signer. |
| `chainId` | [`Ethereum`](enums/Chains.Ethereum.md) | Ethereum L1 chain ID. |

#### Returns

`Promise`\<[`CrossChainContractsLoader`](interfaces/CrossChainContractsLoader.md)\>

Loader for tBTC cross-chain contracts.

**`Throws`**

Throws an error if the signer's Ethereum chain ID is other than
        the one used to construct the loader.

#### Defined in

[lib/ethereum/index.ts:118](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/index.ts#L118)

___

### extractBitcoinRawTxVectors

▸ **extractBitcoinRawTxVectors**(`rawTransaction`): [`BitcoinRawTxVectors`](interfaces/BitcoinRawTxVectors.md)

Decomposes a transaction in the raw representation into version, vector of
inputs, vector of outputs and locktime.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `rawTransaction` | [`BitcoinRawTx`](interfaces/BitcoinRawTx.md) | Transaction in the raw format. |

#### Returns

[`BitcoinRawTxVectors`](interfaces/BitcoinRawTxVectors.md)

Transaction data with fields represented as un-prefixed hex strings.

#### Defined in

[lib/bitcoin/tx.ts:133](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/tx.ts#L133)

___

### loadArbitrumCrossChainContracts

▸ **loadArbitrumCrossChainContracts**(`signer`, `chainId`): `Promise`\<[`L2CrossChainContracts`](README.md#l2crosschaincontracts)\>

Loads Arbitrum implementation of tBTC cross-chain contracts for the given Arbitrum
chain ID and attaches the given signer there.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `signer` | [`EthereumSigner`](README.md#ethereumsigner) | Signer that should be attached to the contracts. |
| `chainId` | [`Arbitrum`](enums/Chains.Arbitrum.md) | Arbitrum chain ID. |

#### Returns

`Promise`\<[`L2CrossChainContracts`](README.md#l2crosschaincontracts)\>

Handle to the contracts.

**`Throws`**

Throws an error if the signer's Arbitrum chain ID is other than
        the one used to load contracts.

#### Defined in

[lib/arbitrum/index.ts:22](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/arbitrum/index.ts#L22)

___

### loadBaseCrossChainContracts

▸ **loadBaseCrossChainContracts**(`signer`, `chainId`): `Promise`\<[`L2CrossChainContracts`](README.md#l2crosschaincontracts)\>

Loads Base implementation of tBTC cross-chain contracts for the given Base
chain ID and attaches the given signer there.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `signer` | [`EthereumSigner`](README.md#ethereumsigner) | Signer that should be attached to the contracts. |
| `chainId` | [`Base`](enums/Chains.Base.md) | Base chain ID. |

#### Returns

`Promise`\<[`L2CrossChainContracts`](README.md#l2crosschaincontracts)\>

Handle to the contracts.

**`Throws`**

Throws an error if the signer's Base chain ID is other than
        the one used to load contracts.

#### Defined in

[lib/base/index.ts:22](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/base/index.ts#L22)

___

### loadEthereumCoreContracts

▸ **loadEthereumCoreContracts**(`signer`, `chainId`): `Promise`\<[`TBTCContracts`](README.md#tbtccontracts)\>

Loads Ethereum implementation of tBTC core contracts for the given Ethereum
chain ID and attaches the given signer there.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `signer` | [`EthereumSigner`](README.md#ethereumsigner) | Signer that should be attached to tBTC contracts. |
| `chainId` | [`Ethereum`](enums/Chains.Ethereum.md) | Ethereum chain ID. |

#### Returns

`Promise`\<[`TBTCContracts`](README.md#tbtccontracts)\>

Handle to tBTC core contracts.

**`Throws`**

Throws an error if the signer's Ethereum chain ID is other than
        the one used to load tBTC contracts.

#### Defined in

[lib/ethereum/index.ts:82](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/index.ts#L82)

___

### loadStarkNetCrossChainContracts

▸ **loadStarkNetCrossChainContracts**(`walletAddress`): `Promise`\<[`L2CrossChainContracts`](README.md#l2crosschaincontracts)\>

Loads StarkNet implementation of tBTC cross-chain contracts.
Since StarkNet doesn't have L2 contracts, this returns interface-only
implementations that throw errors for unsupported operations.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `walletAddress` | `string` | The StarkNet wallet address to use as deposit owner |

#### Returns

`Promise`\<[`L2CrossChainContracts`](README.md#l2crosschaincontracts)\>

Handle to the contracts

#### Defined in

[lib/starknet/index.ts:19](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/index.ts#L19)

___

### packRevealDepositParameters

▸ **packRevealDepositParameters**(`depositTx`, `depositOutputIndex`, `deposit`, `vault?`): `Object`

Packs deposit parameters to match the ABI of the revealDeposit and
revealDepositWithExtraData functions of the Ethereum Bridge contract.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositTx` | [`BitcoinRawTxVectors`](interfaces/BitcoinRawTxVectors.md) | Deposit transaction data |
| `depositOutputIndex` | `number` | Index of the deposit transaction output that funds the revealed deposit |
| `deposit` | [`DepositReceipt`](interfaces/DepositReceipt.md) | Data of the revealed deposit |
| `vault?` | [`ChainIdentifier`](interfaces/ChainIdentifier.md) | Optional parameter denoting the vault the given deposit should be routed to |

#### Returns

`Object`

Packed parameters.

| Name | Type |
| :------ | :------ |
| `extraData` | `undefined` \| `string` |
| `fundingTx` | \{ `inputVector`: `string` ; `locktime`: `string` ; `outputVector`: `string` ; `version`: `string`  } |
| `fundingTx.inputVector` | `string` |
| `fundingTx.locktime` | `string` |
| `fundingTx.outputVector` | `string` |
| `fundingTx.version` | `string` |
| `reveal` | \{ `blindingFactor`: `string` ; `fundingOutputIndex`: `number` = depositOutputIndex; `refundLocktime`: `string` ; `refundPubKeyHash`: `string` ; `vault`: `string` ; `walletPubKeyHash`: `string`  } |
| `reveal.blindingFactor` | `string` |
| `reveal.fundingOutputIndex` | `number` |
| `reveal.refundLocktime` | `string` |
| `reveal.refundPubKeyHash` | `string` |
| `reveal.vault` | `string` |
| `reveal.walletPubKeyHash` | `string` |

#### Defined in

[lib/ethereum/bridge.ts:714](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L714)

___

### retryAll

▸ **retryAll**(`error`): ``true``

A convenience matcher for withBackoffRetries that retries irrespective of
the error.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `error` | `any` | The error to match against. Not necessarily an Error instance, since the retriable function may throw a non-Error. |

#### Returns

``true``

Always returns true.

#### Defined in

[lib/utils/backoff.ts:9](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/backoff.ts#L9)

___

### skipRetryWhenMatched

▸ **skipRetryWhenMatched**(`matchers`): [`ErrorMatcherFn`](README.md#errormatcherfn)

A matcher to specify list of error messages that should abort the retry loop
and throw immediately.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `matchers` | (`string` \| `RegExp`)[] | List of patterns for error matching. |

#### Returns

[`ErrorMatcherFn`](README.md#errormatcherfn)

Matcher function that returns false if error matches one of the patterns.
         True is returned if no matches are found and retry loop should continue

#### Defined in

[lib/utils/backoff.ts:20](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/utils/backoff.ts#L20)

___

### toBitcoinJsLibNetwork

▸ **toBitcoinJsLibNetwork**(`bitcoinNetwork`): `networks.Network`

Converts the provided [BitcoinNetwork](enums/BitcoinNetwork-1.md) enumeration to a format expected
by the `bitcoinjs-lib` library.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `bitcoinNetwork` | [`BitcoinNetwork`](enums/BitcoinNetwork-1.md) | Specified Bitcoin network. |

#### Returns

`networks.Network`

Network representation compatible with the `bitcoinjs-lib` library.

**`Throws`**

An error if the network is not supported by `bitcoinjs-lib`.

#### Defined in

[lib/bitcoin/network.ts:55](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/network.ts#L55)

___

### validateBitcoinHeadersChain

▸ **validateBitcoinHeadersChain**(`headers`, `previousEpochDifficulty`, `currentEpochDifficulty`): `void`

Validates a chain of consecutive block headers by checking each header's
difficulty, hash, and continuity with the previous header. This function can
be used to validate a series of Bitcoin block headers for their validity.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `headers` | [`BitcoinHeader`](interfaces/BitcoinHeader.md)[] | An array of block headers that form the chain to be validated. |
| `previousEpochDifficulty` | `BigNumber` | The difficulty of the previous Bitcoin epoch. |
| `currentEpochDifficulty` | `BigNumber` | The difficulty of the current Bitcoin epoch. |

#### Returns

`void`

An empty return value.

**`Dev`**

The block headers must come from Bitcoin epochs with difficulties marked
     by the previous and current difficulties. If a Bitcoin difficulty relay
     is used to provide these values and the relay is up-to-date, only the
     recent block headers will pass validation. Block headers older than the
     current and previous Bitcoin epochs will fail.

**`Throws`**

If any of the block headers are invalid, or if the block
        header chain is not continuous.

#### Defined in

[lib/bitcoin/header.ts:132](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/header.ts#L132)

___

### validateBitcoinSpvProof

▸ **validateBitcoinSpvProof**(`transactionHash`, `requiredConfirmations`, `previousDifficulty`, `currentDifficulty`, `bitcoinClient`): `Promise`\<`void`\>

Proves that a transaction with the given hash is included in the Bitcoin
blockchain by validating the transaction's inclusion in the Merkle tree and
verifying that the block containing the transaction has enough confirmations.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `transactionHash` | [`BitcoinTxHash`](classes/BitcoinTxHash.md) | The hash of the transaction to be validated. |
| `requiredConfirmations` | `number` | The number of confirmations required for the transaction to be considered valid. The transaction has 1 confirmation when it is in the block at the current blockchain tip. Every subsequent block added to the blockchain is one additional confirmation. |
| `previousDifficulty` | `BigNumber` | The difficulty of the previous Bitcoin epoch. |
| `currentDifficulty` | `BigNumber` | The difficulty of the current Bitcoin epoch. |
| `bitcoinClient` | [`BitcoinClient`](interfaces/BitcoinClient.md) | The client for interacting with the Bitcoin blockchain. |

#### Returns

`Promise`\<`void`\>

An empty return value.

**`Throws`**

If the transaction is not included in the Bitcoin blockchain
       or if the block containing the transaction does not have enough
       confirmations.

**`Dev`**

The function should be used within a try-catch block.

#### Defined in

[lib/bitcoin/spv.ts:180](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/spv.ts#L180)

___

### validateDepositReceipt

▸ **validateDepositReceipt**(`receipt`): `void`

Validates the given deposit receipt. Throws in case of a validation error.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `receipt` | [`DepositReceipt`](interfaces/DepositReceipt.md) | The validated deposit receipt. |

#### Returns

`void`

**`Dev`**

This function does not validate the depositor's identifier as its
     validity is chain-specific. This parameter must be validated outside.

#### Defined in

[lib/contracts/bridge.ts:247](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/bridge.ts#L247)
