# Interface: EthereumBridgeConfig

Ethereum Bridge configuration.

## Hierarchy

- [`EthereumContractConfig`](EthereumContractConfig.md)

  ↳ **`EthereumBridgeConfig`**

## Table of contents

### Properties

- [activeWalletIdentityQuorum](EthereumBridgeConfig.md#activewalletidentityquorum)
- [address](EthereumBridgeConfig.md#address)
- [deployedAtBlockNumber](EthereumBridgeConfig.md#deployedatblocknumber)
- [signerOrProvider](EthereumBridgeConfig.md#signerorprovider)

## Properties

### activeWalletIdentityQuorum

• `Optional` `Readonly` **activeWalletIdentityQuorum**: [`EthereumActiveWalletIdentityQuorum`](EthereumActiveWalletIdentityQuorum.md)

Independent finalized-state verifier for deposit wallet identities.
Ordinary read APIs remain available without this option, but deposit
creation fails closed.

#### Defined in

[src/lib/ethereum/bridge.ts:106](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L106)

___

### address

• `Optional` **address**: `string`

Address of the Ethereum contract as a 0x-prefixed hex string.
Optional parameter, if not provided the value will be resolved from the
contract artifact.

#### Inherited from

[EthereumContractConfig](EthereumContractConfig.md).[address](EthereumContractConfig.md#address)

#### Defined in

[src/lib/ethereum/adapter.ts:53](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L53)

___

### deployedAtBlockNumber

• `Optional` **deployedAtBlockNumber**: `number`

Number of a block in which the contract was deployed.
Optional parameter, if not provided the value will be resolved from the
contract artifact.

#### Inherited from

[EthereumContractConfig](EthereumContractConfig.md).[deployedAtBlockNumber](EthereumContractConfig.md#deployedatblocknumber)

#### Defined in

[src/lib/ethereum/adapter.ts:64](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L64)

___

### signerOrProvider

• **signerOrProvider**: `Signer` \| `Provider`

Signer - will return a Contract which will act on behalf of that signer. The signer will sign all contract transactions.
Provider - will return a downgraded Contract which only has read-only access (i.e. constant calls)

#### Inherited from

[EthereumContractConfig](EthereumContractConfig.md).[signerOrProvider](EthereumContractConfig.md#signerorprovider)

#### Defined in

[src/lib/ethereum/adapter.ts:58](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/adapter.ts#L58)
