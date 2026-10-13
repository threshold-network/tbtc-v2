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

## Reservations

The SDK supports the tBTC v2 UTXO-reservation flow through
`sdk.reservations` (`ReservationsService`). A reservation routes a
deposit to the reservation vault so that a tBTC wallet anchors the
funds in its own UTXO instead of the shared pool, protecting the
wallet from sweep-capacity races.

Typical flow:

```typescript
// 1. Pre-funding go/no-go check for a reserved deposit.
const feasibility = await sdk.reservations.checkReserveFeasibility({
  amount: 500_000n,
  // walletPublicKeyHash: optional - when omitted, any Live wallet with
  // free reservation capacity is considered.
})
if (!feasibility.go) {
  console.error("Cannot reserve right now:", feasibility.reasons)
  // reasons are machine-readable, e.g. "reservations-disabled",
  // "amount-below-minimum", "wallet-count-cap-exceeded", "no-free-wallet".
}

// 2. Initiate the reserved deposit with the intended amount in satoshis.
//    The receipt refund locktime is chosen inside the on-chain window
//    with a default 30-day reveal slack, so the depositor has days of
//    margin between address generation and reveal. The amount selects a
//    Live wallet with room for it (preferring the active wallet when it
//    is eligible) and gates the receipt on every admission rule; pass
//    { walletPublicKeyHash } to validate an explicitly chosen wallet
//    against the same rules instead.
const { deposit, receipt, walletPublicKeyHash } =
  await sdk.reservations.initiateReservedDeposit(
    bitcoinRecoveryAddress,
    500_000
  )

// 3. Fund the Bitcoin deposit address, then reveal to the reservation vault.
await deposit.detectFunding()
await sdk.reservations.revealReservedDeposit(deposit)

// 4. Request acceptance (only the depositor may do this). The preflight
//    explains which rule would fail without submitting the transaction.
const preflight = await sdk.reservations.checkAcceptancePreflight(
  depositKey,
  walletPublicKeyHash
)
if (!preflight.ok) {
  console.error("Acceptance blocked:", preflight.failures)
}
await sdk.reservations.requestAcceptance(depositKey, walletPublicKeyHash)

// 5. If the wallet never anchors, the depositor can release the deposit
//    back to the pool so ordinary sweeps accept it again.
await sdk.reservations.releaseToPool(depositKey)
```

Notes for integrators:

- **Reveal deadline.** `checkReserveFeasibility` reports a `revealBy`
  timestamp (refund locktime minus the reveal-ahead period). The reveal
  must be mined by that timestamp. A later reveal reverts ("Deposit refund
  locktime is too close"), and the BTC can then only be refunded on
  Bitcoin after the refund locktime.
- **No-go reasons.** The go/no-go check reports a machine-readable
  `reasons` array: `reservations-disabled`,
  `locktime-window-infeasible`, `locktime-slack-insufficient`,
  `amount-below-minimum`, `amount-below-dust`, `amount-above-single-cap`,
  `global-amount-cap-exceeded`, `wallet-not-live`,
  `wallet-count-cap-exceeded`, `wallet-amount-cap-exceeded`,
  `global-count-cap-exceeded`, `handoff-reserve-exceeded`, `no-free-wallet`.
- **Hand-off reserve.** The Bridge holds back a governance-configured
  number of Live wallets from acceptance capacity (`reservationHandoffReserveWallets`).
  An acceptance is admitted only while
  `activeReservationsCount + 1 <= max(0, liveWalletsCount - handoffReserveWallets) * maxReservationsPerWallet`;
  otherwise the on-chain request reverts with "Hand-off reserve exceeded".
  The gate checks **admission at acceptance time only**: it does not
  reserve a specific wallet or slot, and neither `checkReserveFeasibility`
  nor `checkAcceptancePreflight` can make the funding or the acceptance
  itself race-free. A check that passes can be overtaken by concurrent
  acceptances, rotating or retiring wallets, late proof delivery or a
  cap change. `handoff-reserve-exceeded` (pre-funding) and the matching
  failure entry (acceptance preflight) report that the next acceptance
  would be refused by the gate even though the ordinary global and
  per-wallet caps still have room.
- **Minimum amount.** A reservation needs a deposit amount strictly above
  `minAmount + 2 * txMaxFee` (from `reservationParameters`). Below that,
  `checkReserveFeasibility` reports `amount-below-minimum` and the
  acceptance request reverts.
- **Release to pool.** `releaseToPool` is only valid for a reserved
  deposit that never received an acceptance request; the vault target is
  the zero address or a trusted vault other than the reservation vault.
  The ordinary sweep charges the treasury fee recorded at reveal and its
  Bitcoin miner fee. The reservation initiation fee does not apply after
  release. Reserved reveals do not claim a treasury-fee rebate, so release
  does not retroactively apply one.
- **Refunds.** A reserved deposit refunds through a Bitcoin script path
  (OP_IF/OP_ELSE with the refund public key and locktime). The depositor
  must control a Bitcoin wallet that can sign the script-path refund; a
  plain P2WPKH address that cannot produce the witness for the script
  cannot refund it.

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
