# Interface: GaslessDepositResult

Result of initiating a gasless deposit where the relayer backend pays all
gas fees.

This structure contains both the Deposit object for Bitcoin operations and
the typed deposit receipt needed to build the relay payload once the
funding transaction is confirmed.

**`See`**

for the payload structure needed after funding

## Table of contents

### Properties

- [deposit](GaslessDepositResult.md#deposit)
- [destinationChainName](GaslessDepositResult.md#destinationchainname)
- [receipt](GaslessDepositResult.md#receipt)

## Properties

### deposit

• **deposit**: [`Deposit`](../classes/Deposit.md)

Deposit object for Bitcoin address generation and funding detection.
Use `deposit.getBitcoinAddress()` to get the deposit address.
Use `deposit.detectFunding()` to monitor for Bitcoin transactions.

#### Defined in

[src/services/deposits/deposits-service.ts:54](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L54)

___

### destinationChainName

• **destinationChainName**: ``"Base"`` \| ``"Arbitrum"`` \| ``"L1"``

Can be "L1" or any L2 chain name (e.g., "Arbitrum", "Base").

#### Defined in

[src/services/deposits/deposits-service.ts:69](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L69)

___

### receipt

• **receipt**: [`DepositReceipt`](DepositReceipt.md)

Deposit receipt containing all deposit parameters.
Contains `Hex`/`ChainIdentifier` class instances, not plain JSON — a
`JSON.parse(JSON.stringify(receipt))` round trip does NOT reproduce a
usable receipt. Callers needing to persist this across page reloads
must implement their own serialize/deserialize step that reconstructs
these class instances.

#### Defined in

[src/services/deposits/deposits-service.ts:64](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L64)
