# Class: Deposit

Component representing an instance of the tBTC v2 deposit process.
Depositing is a complex process spanning both the Bitcoin and the target chain.
This component tries to abstract away that complexity.

## Table of contents

### Constructors

- [constructor](Deposit.md#constructor)

### Properties

- [bitcoinClient](Deposit.md#bitcoinclient)
- [bitcoinNetwork](Deposit.md#bitcoinnetwork)
- [depositorProxy](Deposit.md#depositorproxy)
- [script](Deposit.md#script)
- [tbtcContracts](Deposit.md#tbtccontracts)

### Methods

- [detectFunding](Deposit.md#detectfunding)
- [getBitcoinAddress](Deposit.md#getbitcoinaddress)
- [getReceipt](Deposit.md#getreceipt)
- [initiateMinting](Deposit.md#initiateminting)
- [fromReceipt](Deposit.md#fromreceipt)

## Constructors

### constructor

• **new Deposit**(`receipt`, `tbtcContracts`, `bitcoinClient`, `bitcoinNetwork`, `depositorProxy?`, `scriptOptions?`): [`Deposit`](Deposit.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `receipt` | [`DepositReceipt`](../interfaces/DepositReceipt.md) |
| `tbtcContracts` | [`TBTCContracts`](../README.md#tbtccontracts) |
| `bitcoinClient` | [`BitcoinClient`](../interfaces/BitcoinClient.md) |
| `bitcoinNetwork` | [`BitcoinNetwork`](../enums/BitcoinNetwork-1.md) |
| `depositorProxy?` | [`DepositorProxy`](../interfaces/DepositorProxy.md) |
| `scriptOptions?` | [`DepositScriptOptions`](../README.md#depositscriptoptions) |

#### Returns

[`Deposit`](Deposit.md)

#### Defined in

[tbtc-v2-m993/typescript/src/services/deposits/deposit.ts:66](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L66)

## Properties

### bitcoinClient

• `Private` `Readonly` **bitcoinClient**: [`BitcoinClient`](../interfaces/BitcoinClient.md)

Bitcoin client handle.

#### Defined in

[tbtc-v2-m993/typescript/src/services/deposits/deposit.ts:55](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L55)

___

### bitcoinNetwork

• `Readonly` **bitcoinNetwork**: [`BitcoinNetwork`](../enums/BitcoinNetwork-1.md)

Bitcoin network the deposit is relevant for. Has an impact on the
generated deposit address.

#### Defined in

[tbtc-v2-m993/typescript/src/services/deposits/deposit.ts:64](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L64)

___

### depositorProxy

• `Private` `Optional` `Readonly` **depositorProxy**: [`DepositorProxy`](../interfaces/DepositorProxy.md)

Optional depositor proxy used to initiate minting.

#### Defined in

[tbtc-v2-m993/typescript/src/services/deposits/deposit.ts:59](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L59)

___

### script

• `Private` `Readonly` **script**: [`DepositScript`](DepositScript.md)

Bitcoin script corresponding to this deposit.

#### Defined in

[tbtc-v2-m993/typescript/src/services/deposits/deposit.ts:47](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L47)

___

### tbtcContracts

• `Private` `Readonly` **tbtcContracts**: [`TBTCContracts`](../README.md#tbtccontracts)

Handle to tBTC contracts.

#### Defined in

[tbtc-v2-m993/typescript/src/services/deposits/deposit.ts:51](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L51)

## Methods

### detectFunding

▸ **detectFunding**(): `Promise`\<[`BitcoinUtxo`](../README.md#bitcoinutxo)[]\>

Detects Bitcoin funding transactions transferring BTC to this deposit.
The list includes UTXOs from both the blockchain and the mempool, sorted by
age with the newest ones first. Mempool UTXOs are listed at the beginning.

#### Returns

`Promise`\<[`BitcoinUtxo`](../README.md#bitcoinutxo)[]\>

Specific UTXOs targeting this deposit. Empty array in case
        there are no UTXOs referring this deposit.

#### Defined in

[tbtc-v2-m993/typescript/src/services/deposits/deposit.ts:121](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L121)

___

### getBitcoinAddress

▸ **getBitcoinAddress**(): `Promise`\<`string`\>

#### Returns

`Promise`\<`string`\>

Bitcoin address corresponding to this deposit.

#### Defined in

[tbtc-v2-m993/typescript/src/services/deposits/deposit.ts:110](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L110)

___

### getReceipt

▸ **getReceipt**(): [`DepositReceipt`](../interfaces/DepositReceipt.md)

#### Returns

[`DepositReceipt`](../interfaces/DepositReceipt.md)

Receipt corresponding to this deposit.

#### Defined in

[tbtc-v2-m993/typescript/src/services/deposits/deposit.ts:103](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L103)

___

### initiateMinting

▸ **initiateMinting**(`fundingOutpoint?`): `Promise`\<[`Hex`](Hex.md) \| `TransactionReceipt`\>

Initiates minting of the TBTC token, based on the Bitcoin funding
transaction outpoint targeting this deposit. By default, it detects and
uses the outpoint of the recent Bitcoin funding transaction and throws if
such a transaction does not exist. This behavior can be changed by pointing
a funding transaction explicitly, using the fundingOutpoint parameter.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `fundingOutpoint?` | [`BitcoinTxOutpoint`](../interfaces/BitcoinTxOutpoint.md) | Optional parameter. Can be used to point the funding transaction's outpoint manually. |

#### Returns

`Promise`\<[`Hex`](Hex.md) \| `TransactionReceipt`\>

Target chain hash of the initiate minting transaction.

**`Throws`**

Throws an error if there are no funding transactions while using
        the default funding detection mode.

**`Throws`**

Throws an error if the provided funding outpoint does not
        actually refer to this deposit while using the manual funding
        provision mode.

**`Throws`**

Throws an error if the funding outpoint was already used to
        initiate minting (both modes).

#### Defined in

[tbtc-v2-m993/typescript/src/services/deposits/deposit.ts:150](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L150)

___

### fromReceipt

▸ **fromReceipt**(`receipt`, `tbtcContracts`, `bitcoinClient`, `depositorProxy?`, `scriptOptions?`): `Promise`\<[`Deposit`](Deposit.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `receipt` | [`DepositReceipt`](../interfaces/DepositReceipt.md) |
| `tbtcContracts` | [`TBTCContracts`](../README.md#tbtccontracts) |
| `bitcoinClient` | [`BitcoinClient`](../interfaces/BitcoinClient.md) |
| `depositorProxy?` | [`DepositorProxy`](../interfaces/DepositorProxy.md) |
| `scriptOptions?` | [`DepositScriptOptions`](../README.md#depositscriptoptions) |

#### Returns

`Promise`\<[`Deposit`](Deposit.md)\>

#### Defined in

[tbtc-v2-m993/typescript/src/services/deposits/deposit.ts:81](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposit.ts#L81)
