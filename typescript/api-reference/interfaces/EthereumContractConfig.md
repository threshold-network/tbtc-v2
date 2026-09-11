# Interface: EthereumContractConfig

Represents a config set required to connect an Ethereum contract.

## Hierarchy

- `Omit`\<`EvmContractHandleConfig`, ``"signerOrProvider"``\>

  ↳ **`EthereumContractConfig`**

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

#### Inherited from

Omit.address

#### Defined in

[src/lib/ethereum/adapter.ts:87](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L87)

___

### deployedAtBlockNumber

• `Optional` **deployedAtBlockNumber**: `number`

Number of a block in which the contract was deployed.
Optional parameter, if not provided the value will be resolved from the
contract artifact.

#### Inherited from

Omit.deployedAtBlockNumber

#### Defined in

[src/lib/ethereum/adapter.ts:102](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L102)

___

### signerOrProvider

• **signerOrProvider**: [`EthereumSigner`](../README.md#ethereumsigner)

Signer - will allow the contract handle to send write transactions on
behalf of that signer, besides read-only access.
Provider - will give the contract handle read-only access.

#### Defined in

[src/lib/ethereum/adapter.ts:115](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L115)
