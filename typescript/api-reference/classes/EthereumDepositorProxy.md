# Class: EthereumDepositorProxy

Abstract class representing a depositor proxy contract on Ethereum.
It implements some common logic that is meant to facilitate creation
of concrete depositor proxy handles for Ethereum.

**`See`**

for reference.

## Implements

- [`DepositorProxy`](../interfaces/DepositorProxy.md)

## Table of contents

### Constructors

- [constructor](EthereumDepositorProxy.md#constructor)

### Properties

- [address](EthereumDepositorProxy.md#address)

### Methods

- [getChainIdentifier](EthereumDepositorProxy.md#getchainidentifier)
- [packRevealDepositParameters](EthereumDepositorProxy.md#packrevealdepositparameters)
- [revealDeposit](EthereumDepositorProxy.md#revealdeposit)

## Constructors

### constructor

• **new EthereumDepositorProxy**(`address`): [`EthereumDepositorProxy`](EthereumDepositorProxy.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `address` | `string` \| [`EthereumAddress`](EthereumAddress.md) |

#### Returns

[`EthereumDepositorProxy`](EthereumDepositorProxy.md)

#### Defined in

[lib/ethereum/depositor-proxy.ts:16](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/depositor-proxy.ts#L16)

## Properties

### address

• `Protected` `Readonly` **address**: [`EthereumAddress`](EthereumAddress.md)

#### Defined in

[lib/ethereum/depositor-proxy.ts:14](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/depositor-proxy.ts#L14)

## Methods

### getChainIdentifier

▸ **getChainIdentifier**(): [`ChainIdentifier`](../interfaces/ChainIdentifier.md)

#### Returns

[`ChainIdentifier`](../interfaces/ChainIdentifier.md)

**`See`**

#### Implementation of

[DepositorProxy](../interfaces/DepositorProxy.md).[getChainIdentifier](../interfaces/DepositorProxy.md#getchainidentifier)

#### Defined in

[lib/ethereum/depositor-proxy.ts:28](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/depositor-proxy.ts#L28)

___

### packRevealDepositParameters

▸ **packRevealDepositParameters**(`depositTx`, `depositOutputIndex`, `deposit`, `vault?`): `Object`

Packs deposit parameters to match the ABI of the revealDeposit and
revealDepositWithExtraData functions of the Ethereum Bridge contract.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositTx` | [`BitcoinRawTxVectors`](../interfaces/BitcoinRawTxVectors.md) | Deposit transaction data |
| `depositOutputIndex` | `number` | Index of the deposit transaction output that funds the revealed deposit |
| `deposit` | [`DepositReceipt`](../interfaces/DepositReceipt.md) | Data of the revealed deposit |
| `vault?` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) | Optional parameter denoting the vault the given deposit should be routed to |

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

[lib/ethereum/depositor-proxy.ts:44](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/depositor-proxy.ts#L44)

___

### revealDeposit

▸ **revealDeposit**(`depositTx`, `depositOutputIndex`, `deposit`, `vault?`): `Promise`\<[`Hex`](Hex.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `depositTx` | [`BitcoinRawTxVectors`](../interfaces/BitcoinRawTxVectors.md) |
| `depositOutputIndex` | `number` |
| `deposit` | [`DepositReceipt`](../interfaces/DepositReceipt.md) |
| `vault?` | [`ChainIdentifier`](../interfaces/ChainIdentifier.md) |

#### Returns

`Promise`\<[`Hex`](Hex.md)\>

**`See`**

#### Implementation of

[DepositorProxy](../interfaces/DepositorProxy.md).[revealDeposit](../interfaces/DepositorProxy.md#revealdeposit)

#### Defined in

[lib/ethereum/depositor-proxy.ts:62](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/depositor-proxy.ts#L62)
