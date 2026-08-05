# Interface: StarkNetBitcoinDepositorConfig

Configuration for StarkNetBitcoinDepositor

## Table of contents

### Properties

- [chainId](StarkNetBitcoinDepositorConfig.md#chainid)
- [defaultVault](StarkNetBitcoinDepositorConfig.md#defaultvault)
- [relayerStatusUrl](StarkNetBitcoinDepositorConfig.md#relayerstatusurl)
- [relayerUrl](StarkNetBitcoinDepositorConfig.md#relayerurl)

## Properties

### chainId

• **chainId**: `string`

#### Defined in

[src/lib/starknet/starknet-depositor.ts:137](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L137)

___

### defaultVault

• `Optional` **defaultVault**: `string`

#### Defined in

[src/lib/starknet/starknet-depositor.ts:147](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L147)

___

### relayerStatusUrl

• `Optional` **relayerStatusUrl**: `string`

Base path for the relayer's deposit-status endpoint. Must be a path
prefix (e.g. "https://relayer.example/api/Chain/deposit") - the SDK
appends "/<depositId>" to it. Trailing slashes are stripped
automatically; do not supply a templated URL containing "{depositId}"
or similar placeholders.

#### Defined in

[src/lib/starknet/starknet-depositor.ts:146](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L146)

___

### relayerUrl

• `Optional` **relayerUrl**: `string`

#### Defined in

[src/lib/starknet/starknet-depositor.ts:138](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L138)
