# Interface: EthereumActiveWalletIdentityQuorum

Two-provider quorum required before Ethereum state can select Bitcoin
deposit custody. Both providers must support Ethereum's `finalized` block
tag and the upgraded Bridge wallet-identity selectors.

## Table of contents

### Properties

- [canonicalProvider](EthereumActiveWalletIdentityQuorum.md#canonicalprovider)
- [sourceTrustDomainID](EthereumActiveWalletIdentityQuorum.md#sourcetrustdomainid)

## Properties

### canonicalProvider

• `Readonly` **canonicalProvider**: [`EthereumCanonicalActiveWalletIdentityProvider`](EthereumCanonicalActiveWalletIdentityProvider.md)

#### Defined in

[src/lib/ethereum/bridge.ts:96](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L96)

___

### sourceTrustDomainID

• `Readonly` **sourceTrustDomainID**: `string`

#### Defined in

[src/lib/ethereum/bridge.ts:95](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L95)
