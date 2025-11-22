# Interface: GaslessDepositResult

Result of initiating a gasless deposit where the relayer backend pays all
gas fees.

This structure contains both the Deposit object for Bitcoin operations and
serializable data that can be stored (e.g., in localStorage) for later use
in building the relay payload.

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

[services/deposits/deposits-service.ts:47](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L47)

___

### destinationChainName

• **destinationChainName**: [`GaslessDestination`](../README.md#gaslessdestination)

Target chain name for the deposit.
Can be "L1" or any L2 chain name (e.g., "Arbitrum", "Base", "Optimism").

#### Defined in

[services/deposits/deposits-service.ts:59](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L59)

___

### receipt

• **receipt**: [`DepositReceipt`](DepositReceipt.md)

Deposit receipt containing all deposit parameters.
This is serializable and can be stored for later payload construction.

#### Defined in

[services/deposits/deposits-service.ts:53](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/services/deposits/deposits-service.ts#L53)
