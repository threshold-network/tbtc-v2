# Interface: EthereumContractConfig

Represents a config set required to connect an Ethereum contract.

## Table of contents

### Properties

- [address](EthereumContractConfig.md#address)
- [deployedAtBlockNumber](EthereumContractConfig.md#deployedatblocknumber)
- [signerOrProvider](EthereumContractConfig.md#signerorprovider)

## Properties

### address

• `Optional` **address**: `string`

Address of the Ethereum contract as a 0x-prefixed hex string.
Optional parameter, if not provided the value will be resolved from the
contract artifact.

#### Defined in

[src/lib/ethereum/adapter.ts:68](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L68)

___

### deployedAtBlockNumber

• `Optional` **deployedAtBlockNumber**: `number`

Number of a block in which the contract was deployed.
Optional parameter, if not provided the value will be resolved from the
contract artifact.

#### Defined in

[src/lib/ethereum/adapter.ts:83](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L83)

___

### signerOrProvider

• **signerOrProvider**: [`EthereumSigner`](../README.md#ethereumsigner) \| [`EvmConnection`](EvmConnection.md)

Signer - will allow the contract handle to send write transactions on
behalf of that signer, besides read-only access.
Provider - will give the contract handle read-only access.
An already-normalized [EvmConnection](EvmConnection.md) may be passed as an internal
fast path (used by the contract loaders to normalize once per
initialization).

#### Defined in

[src/lib/ethereum/adapter.ts:77](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L77)
