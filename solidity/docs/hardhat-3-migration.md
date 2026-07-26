# Hardhat 3 migration assessment

Status: **blocked**. This document records what was measured, so the next
attempt starts from facts rather than a guess.

The `package.json` change on this branch bumps `hardhat` to `^3.11.1`. It
installs, and then stops on the first two blockers below. It is here to make the
attempt reproducible, not because it is close to landing.

## What stops it immediately

Both of these appear before a single contract compiles.

**1. Node version.** Hardhat 3 requires Node >= 22.13.0:

```
ERROR: You are using Node.js 18.20.8 which is not supported by Hardhat.
Please upgrade to Node.js 22.13.0 or later.
```

This repo builds and tests on Node 18.

**2. ESM only.** Hardhat 3 refuses to load a CommonJS project:

```
Hardhat only supports ESM projects.
Please make sure you have `"type": "module"` in your package.json.
```

The `solidity` package is CommonJS throughout: `hardhat.config.ts`, 60 deploy
scripts, 70 test files and the `tasks/` directory. Flipping `"type": "module"`
is not a one-line change — it changes `require`/`__dirname` semantics and the
extension rules for every relative import in the package.

## Plugin support

Every plugin `hardhat.config.ts` loads is Hardhat 2 only. None has a Hardhat 3
release:

| plugin | latest | peer `hardhat` |
| --- | --- | --- |
| `@nomiclabs/hardhat-waffle` | 2.0.6 | `^2.0.0` |
| `@nomiclabs/hardhat-etherscan` | 3.1.8 | `^2.0.4` |
| `@typechain/hardhat` | 9.1.0 | `^2.9.9` |
| `hardhat-gas-reporter` | 2.3.0 | `^2.16.0` |
| `hardhat-contract-sizer` | 2.10.1 | `^2.0.0` |
| `hardhat-dependency-compiler` | 1.2.1 | `^2.0.0` |
| `solidity-docgen` | 0.6.0-beta.36 | `^2.8.0` |
| `@keep-network/hardhat-helpers` | 0.7.2 | `^2.19.4` |
| `@keep-network/hardhat-local-networks-config` | 0.1.0-pre.4 | `^2.0.8` |
| `@tenderly/hardhat-tenderly` | 2.5.2 | none declared |

Two of these are ours, so they gate on our own release cycle.

Replacements exist for some, but they are replacements, not upgrades:
`@nomicfoundation/hardhat-ethers@4` (peer `^3.8.0`),
`@openzeppelin/hardhat-upgrades@4.1.0` (peer `^3.6.0`),
`hardhat-deploy@2.0.10` (peer `^3.4.5`).

## The two that have no answer at all

**`@defi-wonderland/smock`** — used by 29 test files. There is no Hardhat 3
version, and no viem equivalent. It works by reaching into Hardhat's provider
internals, which is also why it breaks on Hardhat >= 2.20 (see
`build(solidity): pin the toolchain to the versions smock actually works with`).
Every fake in the suite would have to be rebuilt on something else.

**`hardhat-deploy`** — the Hardhat 3 line is `2.x`, which is a rewrite on top of
`rocketh` with a different API. The repo has **60 deploy scripts** plus 28 test
files driving `deployments`. This is not a version bump; it is a port.

## Surface to convert

Measured over `solidity/test` and `solidity/deploy`:

| surface | files |
| --- | --- |
| deploy scripts (hardhat-deploy) | 60 |
| test files using ethers v5 API | 75 |
| test files using typechain-generated types | 72 |
| test files using waffle matchers (`revertedWith`, `.to.emit`) | 53 |
| test files using smock | 29 |
| total solidity test files | 70 |

## Reading

This is a project, not a follow-up PR. The prerequisites are, in order:

1. Node 22+ across local and CI.
2. Decide the mocking story — smock has no forward path. This is the single
   hardest item and it should be settled before anything else is touched.
3. ESM conversion of the `solidity` package.
4. Port the deploy layer to `hardhat-deploy@2` / rocketh.
5. Replace ethers v5 + typechain + waffle matchers with the chosen stack
   (`hardhat-ethers@4` + `hardhat-chai-matchers`, or the viem toolbox).
6. Update the two `@keep-network` plugins.

Nothing here blocks current work. The suite is green on the pinned toolchain,
and the fixture-loader defect that motivated looking at waffle in the first
place has been fixed independently in
`test(solidity): verify the fixture snapshot before trusting it` — no dependency
change required.
