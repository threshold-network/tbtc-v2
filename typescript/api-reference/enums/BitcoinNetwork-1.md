# Enumeration: BitcoinNetwork

Bitcoin networks.

## Table of contents

### Enumeration Members

- [Mainnet](BitcoinNetwork-1.md#mainnet)
- [Testnet](BitcoinNetwork-1.md#testnet)
- [Testnet4](BitcoinNetwork-1.md#testnet4)
- [Unknown](BitcoinNetwork-1.md#unknown)

## Enumeration Members

### Mainnet

• **Mainnet** = ``"mainnet"``

Bitcoin Mainnet.

#### Defined in

[src/lib/bitcoin/network.ts:25](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/network.ts#L25)

___

### Testnet

• **Testnet** = ``"testnet"``

Bitcoin Testnet (testnet3).

#### Defined in

[src/lib/bitcoin/network.ts:16](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/network.ts#L16)

___

### Testnet4

• **Testnet4** = ``"testnet4"``

Bitcoin Testnet4. Shares testnet3's address parameters (same `tb` bech32
HRP and base58 versions); only the chain and genesis block differ.

#### Defined in

[src/lib/bitcoin/network.ts:21](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/network.ts#L21)

___

### Unknown

• **Unknown** = ``"unknown"``

Unknown network.

#### Defined in

[src/lib/bitcoin/network.ts:12](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/bitcoin/network.ts#L12)
