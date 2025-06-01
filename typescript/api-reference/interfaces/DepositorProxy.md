# Interface: DepositorProxy

Interface representing a depositor proxy contract. A depositor proxy
is used to reveal deposits to the Bridge, on behalf of the user
(i.e. original depositor). It receives minted TBTC tokens and can provide
additional services to the user, such as routing the minted TBTC tokens to
another protocols, in an automated way. Depositor proxy is responsible for
attributing the deposit and minted TBTC tokens to the user (e.g. using the
optional 32-byte extra data field of the deposit script).

## Implemented by

- [`CrossChainDepositor`](../classes/CrossChainDepositor.md)
- [`EthereumDepositorProxy`](../classes/EthereumDepositorProxy.md)

## Table of contents

### Methods

- [getChainIdentifier](DepositorProxy.md#getchainidentifier)
- [revealDeposit](DepositorProxy.md#revealdeposit)

## Methods

### getChainIdentifier

▸ **getChainIdentifier**(): [`ChainIdentifier`](ChainIdentifier.md)

Gets the chain-specific identifier of this contract.

#### Returns

[`ChainIdentifier`](ChainIdentifier.md)

#### Defined in

[lib/contracts/depositor-proxy.ts:19](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/depositor-proxy.ts#L19)

___

### revealDeposit

▸ **revealDeposit**(`depositTx`, `depositOutputIndex`, `deposit`, `vault?`): `Promise`\<[`Hex`](../classes/Hex.md)\>

Reveals a given deposit to the on-chain Bridge contract.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `depositTx` | [`BitcoinRawTxVectors`](BitcoinRawTxVectors.md) | Deposit transaction data |
| `depositOutputIndex` | `number` | Index of the deposit transaction output that funds the revealed deposit |
| `deposit` | [`DepositReceipt`](DepositReceipt.md) | Data of the revealed deposit |
| `vault?` | [`ChainIdentifier`](ChainIdentifier.md) | Optional parameter denoting the vault the given deposit should be routed to |

#### Returns

`Promise`\<[`Hex`](../classes/Hex.md)\>

Transaction hash of the reveal deposit transaction.

#### Defined in

[lib/contracts/depositor-proxy.ts:31](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/contracts/depositor-proxy.ts#L31)
