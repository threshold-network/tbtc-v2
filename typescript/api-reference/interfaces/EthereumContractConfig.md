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

[src/lib/ethereum/adapter.ts:51](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L51)

___

### deployedAtBlockNumber

• `Optional` **deployedAtBlockNumber**: `number`

Number of a block in which the contract was deployed.
Optional parameter, if not provided the value will be resolved from the
contract artifact.

#### Defined in

[src/lib/ethereum/adapter.ts:62](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L62)

___

### signerOrProvider

• **signerOrProvider**: `Signer` \| `Provider`

Signer - will return a Contract which will act on behalf of that signer. The signer will sign all contract transactions.
Provider - will return a downgraded Contract which only has read-only access (i.e. constant calls)

#### Defined in

[src/lib/ethereum/adapter.ts:56](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L56)
