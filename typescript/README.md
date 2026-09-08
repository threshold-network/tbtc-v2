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

SDK 4.x requires Node.js **22.12.0 or newer**. Earlier Node 22 releases
cannot load the ESM dependencies used by the SDK's CommonJS entrypoints
without experimental flags. Upgrade Node.js before installing SDK 4.x.

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

// Create an instance of ethers signer.
const signer = (...)

// Initialize the SDK.
const sdk = await TBTC.initializeMainnet(signer)

// Access SDK features.
sdk.deposits.(...)
sdk.redemptions.(...)

// Access tBTC smart contracts directly.
sdk.tbtcContracts.(...)

// Access Bitcoin client directly.
sdk.bitcoinClient.(...)
```

## Contributing

Contributions are always welcome! Feel free to open any issue or send a pull request.
Please refer the repository-level
[CONTRIBUTING.adoc](https://github.com/keep-network/tbtc-v2/blob/main/CONTRIBUTING.adoc)
document for general contribution guidelines. Below, you can find how to set up
the SDK module for development.

### Prerequisites

Please make sure you have the following prerequisites installed on your machine:

- [Node.js](https://nodejs.org) >=22.12.0
- [Yarn](https://yarnpkg.com) 4.12.0, selected by Corepack from `package.json`

Enable Corepack before installing dependencies:

```bash
corepack enable
```

The commands below use the repository's Yarn lockfile. npm is also needed
for the package consumer test.

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

To check the package as a consumer would install it, build the SDK and run:

```bash
yarn build
yarn test:package
```

This packs the SDK with npm, installs the tarball in a temporary project
with engine checks enabled, and loads every public entrypoint with both
`require()` and `import()`. It also checks that the installed Electrum dependency
negotiates the protocol version first and delivers subscription notifications.
Dependencies are resolved without the repository's Yarn lockfile or overrides,
and install scripts run with the same error handling as CI. This check requires
network access and runs in CI on Node.js 22.12.0 and the latest Node.js 22 release.

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
import { normalizeNttRecipient } from "@keep-network/tbtc-v2"

// EVM recipients are left-padded to bytes32 for Wormhole NTT.
const recipient = normalizeNttRecipient(
  "0x1234567890123456789012345678901234567890"
)
```

NTT direct depositors use a fixed destination chain per deployed contract. Do not pack a chain ID into the deposit recipient; the recipient remains the full bytes32 deposit extra data.

For more details, see the [NTT Utilities documentation](./src/lib/utils/README.md).

## Documentation

This README provides just a basic guidance. Comprehensive documentation for
this SDK can be found on the
[Threshold Network Docs website](https://docs.threshold.network/app-development/tbtc-v2/tbtc-sdk).
