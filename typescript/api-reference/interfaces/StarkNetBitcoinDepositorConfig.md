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

<<<<<<< HEAD
[src/lib/starknet/starknet-depositor.ts:146](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L146)
=======
[lib/starknet/starknet-depositor.ts:58](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L58)
>>>>>>> 686d5e70 (fix(sdk): harden cross-chain depositor inputs)

___

### defaultVault

• `Optional` **defaultVault**: `string`

#### Defined in

<<<<<<< HEAD
[src/lib/starknet/starknet-depositor.ts:156](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L156)

___

### relayerStatusUrl

• `Optional` **relayerStatusUrl**: `string`

Base path for the relayer's deposit-status endpoint. Must be a path
prefix (e.g. "https://relayer.example/api/Chain/deposit") - the SDK
appends "/<depositId>" to it. Trailing slashes are stripped
automatically; do not supply a templated URL containing "{depositId}"
or similar placeholders.

#### Defined in

[src/lib/starknet/starknet-depositor.ts:155](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L155)
=======
[lib/starknet/starknet-depositor.ts:60](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L60)
>>>>>>> 686d5e70 (fix(sdk): harden cross-chain depositor inputs)

___

### relayerUrl

• `Optional` **relayerUrl**: `string`

#### Defined in

<<<<<<< HEAD
[src/lib/starknet/starknet-depositor.ts:147](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L147)
=======
[lib/starknet/starknet-depositor.ts:59](https://github.com/threshold-network/tbtc-v2/blob/main/typescript/src/lib/starknet/starknet-depositor.ts#L59)
>>>>>>> 686d5e70 (fix(sdk): harden cross-chain depositor inputs)
