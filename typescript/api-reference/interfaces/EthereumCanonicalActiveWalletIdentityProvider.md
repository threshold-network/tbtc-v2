# Interface: EthereumCanonicalActiveWalletIdentityProvider

Independently operated provider used to verify the primary provider's active
wallet identity. Trust-domain IDs must describe real operational failure
domains, not merely different URLs backed by the same provider organization.

## Table of contents

### Properties

- [provider](EthereumCanonicalActiveWalletIdentityProvider.md#provider)
- [trustDomainID](EthereumCanonicalActiveWalletIdentityProvider.md#trustdomainid)

## Properties

### provider

• `Readonly` **provider**: `Provider`

#### Defined in

[src/lib/ethereum/bridge.ts:86](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L86)

___

### trustDomainID

• `Readonly` **trustDomainID**: `string`

#### Defined in

[src/lib/ethereum/bridge.ts:85](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/ethereum/bridge.ts#L85)
