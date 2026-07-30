# tBTC v2 SDK

[![build](https://img.shields.io/github/actions/workflow/status/keep-network/tbtc-v2/typescript.yml?branch=main&event=push&label=build)](https://github.com/keep-network/tbtc-v2/actions/workflows/typescript.yml)
[![npm](https://img.shields.io/npm/v/%40keep-network%2Ftbtc-v2.ts)](https://www.npmjs.com/package/@keep-network/tbtc-v2.ts)
[![documentation](https://badgen.net/static/GitBook/Documentation/yellow)](https://docs.threshold.network/app-development/tbtc-v2/tbtc-sdk)

tBTC SDK is a TypeScript library that provides effortless access to the
fundamental features of the tBTC Bitcoin bridge. The SDK allows developers
to integrate tBTC into their own applications and offer the power of
trustless tokenized Bitcoin to their users.

**Table of contents:**

- [Quickstart](#quickstart)
  - [Installation](#installation)
  - [Usage](#usage)
- [Contributing](#contributing)
  - [Prerequisites](#prerequisites)
  - [Install dependencies](#install-dependencies)
  - [Build](#build)
  - [Test](#test)
  - [Format](#format)
  - [Auto-generated API reference](#auto-generated-api-reference)
- [Documentation](#documentation)

## Quickstart

Here you can find instructions explaining how to use the SDK in your own
project.

### Installation

To install the tBTC SDK in your project using `yarn`, run:

```bash
yarn add @keep-network/tbtc-v2.ts
```

If you prefer to use `npm`, do:

```bash
npm i @keep-network/tbtc-v2.ts
```

Please note that you will also need to install the
[ethers v5](https://docs.ethers.org/v5) library to initialize
a signer or provider. To do so using `yarn`, invoke:

```bash
yarn add ethers@legacy-v5
```

To do the same using `npm`, run:

```bash
npm i ethers@legacy-v5
```

> The SDK depends on ethers v5. Proper support for newer ethers versions
> is not guaranteed right now.

### Usage

Here is a short example demonstrating SDK usage:

```typescript
// Import SDK entrypoint component.
import { TBTC } from "@keep-network/tbtc-v2.ts"
import { providers } from "ethers"

// Create an instance of an ethers signer backed by the primary provider.
const signer = (...)

// Use a second provider operated in a different trust domain. Both providers
// must support the Ethereum `finalized` block tag.
const canonicalProvider = new providers.JsonRpcProvider(...)

// Initialize the SDK with the finalized-state quorum required for deposits.
const sdk = await TBTC.initializeMainnet(signer, {
  sourceTrustDomainID: "primary-provider-operator",
  canonicalProvider: {
    trustDomainID: "independent-provider-operator",
    provider: canonicalProvider,
  },
})

// Access SDK features.
sdk.deposits.(...)
sdk.redemptions.(...)

// Access tBTC smart contracts directly.
sdk.tbtcContracts.(...)

// Access Bitcoin client directly.
sdk.bitcoinClient.(...)
```

Deposit creation fails closed unless the two providers have different
non-empty trust-domain IDs and are different provider instances on the same
Ethereum chain. The SDK reads the active wallet hash, canonical wallet ID, and
both forward and reverse identity mappings at each provider's own authenticated
finalized head, then requires both fully bound identities to match. This rejects
a stale provider that reports a genuine but retired wallet and prevents a
compromised provider from downgrading a FROST wallet to a legacy deposit script.
Trust-domain IDs are operator assertions: integrations must use providers with
genuinely independent infrastructure, administration, and upstream failure
domains. Wrapping one provider object or using two URLs operated by the same
organization does not provide an independent quorum.

Applications enabling cross-chain support pass the quorum as the third
argument: `TBTC.initializeMainnet(signer, true, quorum)`. Ordinary contract
reads remain available without a quorum, but `initiateDeposit`,
`initiateTaprootDeposit`, proxy deposits, and cross-chain deposits will reject
before deriving a custody address.

This is a coordinated activation requirement for every SDK deposit path. The
Bridge deployment must expose `activeWalletID`, `walletID`, and
`walletPubKeyHashForWalletID` before applications enable this SDK version, and
applications must configure both finalized-capable providers at the same time.
If either the selectors or quorum configuration are missing, deposits stop
before producing an address; there is no legacy fallback. Rollouts should verify
the upgraded Bridge selectors and both provider trust domains before directing
users to the new client.

## Contributing

Contributions are always welcome! Feel free to open any issue or send a pull request.
Please refer the repository-level
[CONTRIBUTING.adoc](https://github.com/keep-network/tbtc-v2/blob/main/CONTRIBUTING.adoc)
document for general contribution guidelines. Below, you can find how to set up
the SDK module for development.

### Prerequisites

Please make sure you have the following prerequisites installed on your machine:

- [node.js](https://nodejs.org) >=16
- [yarn](https://classic.yarnpkg.com) >=1.22 or [npm](https://github.com/npm/cli) >=8.11

> Although the below commands use `yarn` you can easily use `npm` instead.

### Install dependencies

To install dependencies, run:

```bash
yarn install
```

### Build

To build the library, invoke:

```bash
yarn build
```

A `dist` directory containing the resulting artifacts will be created.

### Test

To run unit tests, do:

```bash
yarn test
```

### Format

To format code automatically, invoke:

```bash
yarn format:fix
```

### Auto-generated API reference

There is an auto-generated API reference documentation that must be
re-generated in case of modifications in the source code. This can be
done automatically using a pre-commit hook or manually using:

```bash
yarn docs
```

Generated API reference in form of Markdown files is saved
to the [`api-reference`](./api-reference) directory.

## NTT Utilities

The SDK includes utility functions for NTT (Native Token Transfer) bridges:

```typescript
import {
  encodeDestinationReceiver,
  decodeDestinationReceiver,
} from "@keep-network/tbtc-v2"

// Encode destination chain and recipient
const encoded = encodeDestinationReceiver(
  10002,
  "0x1234567890123456789012345678901234567890"
)

// Decode back to original values
const { chainId, recipient } = decodeDestinationReceiver(encoded)
```

These utilities were removed from on-chain contracts to reduce bytecode size but are available off-chain for encoding and decoding destination chain and recipient data.

For more details, see the [NTT Utilities documentation](./src/lib/utils/README.md).

## Documentation

This README provides just a basic guidance. Comprehensive documentation for
this SDK can be found on the
[Threshold Network Docs website](https://docs.threshold.network/app-development/tbtc-v2/tbtc-sdk).
