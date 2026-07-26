# Hardhat 3 migration assessment

Status: **still blocked, but on a clock.** This document records what was
measured, so the next attempt starts from facts rather than a guess.

Hardhat 2 has a stated end of life: the earlier of Hegota mainnet activation or
**1 June 2027**. It gets Glamsterdam support and bug and security fixes until
then. So this is not a question of whether the migration is worth it — it is a
question of when it is scheduled, and what has to be true first.

Re-measured after `@defi-wonderland/smock` was removed and the toolchain moved
to hardhat 2.29 on Node 24.

## What is no longer a blocker

Two of the three items previously called unanswerable have answers now.

**smock is gone.** It was archived upstream with no forward path and no Hardhat
3 version was ever going to exist. Every fake in the suite now runs on
`contracts/test/MockContract.sol` plus `test/helpers/mock.ts`, which depend on
nothing Hardhat can change underneath them.

**Node and hardhat are current.** Hardhat 3 requires Node >= 22.13.0; CI is on
Node 24. The 2.x line is at 2.29, so the gap to 3.x is a major version rather
than a major version plus four years.

## What still blocks it

**ESM, to an extent that needs measuring.** Hardhat 3 refuses to load a
CommonJS project:

```
Hardhat only supports ESM projects.
Please make sure you have `"type": "module"` in your package.json.
```

The `solidity` package is CommonJS throughout — `hardhat.config.ts`, 60 deploy
scripts, 70 test files and `tasks/`.

How much of that actually has to change is **unmeasured, and it is the largest
number in this document**. Hardhat 3's documentation says config files must be
ESM but that CommonJS is still supported in scripts and tests, which would make
this a matter of renaming to `.cts` rather than rewriting every relative import.
The spike above only established that the package needs `"type": "module"`; it
did not establish what happens to the files underneath once it has it.

Measure this before planning around it. The difference between "rename the
files" and "rewrite `require`/`__dirname` semantics across 130 files" is the
difference between a sprint and a quarter.

**Most plugins have no Hardhat 3 line.** Measured today:

| plugin                            | latest        | peer `hardhat` | HH3 |
| --------------------------------- | ------------- | -------------- | --- |
| `@nomicfoundation/hardhat-ethers` | 4.0.15        | `^3.8.0`       | yes |
| `@openzeppelin/hardhat-upgrades`  | 4.1.0         | `^3.6.0`       | yes |
| `hardhat-deploy`                  | 2.0.10        | `^3.4.5`       | yes |
| `hardhat-gas-reporter`            | 2.3.0         | `^2.16.0`      | no  |
| `@nomiclabs/hardhat-waffle`       | 2.0.6         | `^2.0.0`       | no  |
| `@typechain/hardhat`              | 9.1.0         | `^2.9.9`       | no  |
| `hardhat-contract-sizer`          | 2.10.1        | `^2.0.0`       | no  |
| `hardhat-dependency-compiler`     | 1.2.1         | `^2.0.0`       | no  |
| `solidity-docgen`                 | 0.6.0-beta.36 | `^2.8.0`       | no  |
| `@keep-network/hardhat-helpers`   | 0.7.2         | `^2.19.4`      | no  |
| `@tenderly/hardhat-tenderly`      | 2.5.2         | none declared  | ?   |

Three of eleven. `@keep-network/hardhat-helpers` is ours, so it gates on our own
release cycle rather than on anyone else.

**The deploy layer is a port, not a bump.** `hardhat-deploy@2` does support
Hardhat 3, which is new — but it is a rewrite on top of `rocketh` with a
different API, against 60 deploy scripts and the tests that consume their
fixtures.

## Order of work

1. ESM conversion of the `solidity` package. Nothing else can start first.
2. Replace `@nomiclabs/hardhat-waffle` and the ethers v5 + typechain stack.
   `hardhat-ethers@4` is ready; the waffle matchers are not, so assertions move
   to `hardhat-chai-matchers` or the viem toolbox.
3. Port the deploy layer to `hardhat-deploy@2` / rocketh.
4. Release `@keep-network/hardhat-helpers` for Hardhat 3.
5. Whatever of `hardhat-gas-reporter`, `hardhat-contract-sizer`,
   `hardhat-dependency-compiler` and `solidity-docgen` still has no Hardhat 3
   line by then — drop, replace, or vendor.

## What Hardhat 3 is actually worth here

Not urgent this week, but not optional either, and worth being accurate about
which parts are real gains:

**Multichain simulation.** Hardhat 2's development network always behaves like
Ethereum mainnet. Hardhat 3 allows several simulated networks with different
chain types, shipping with OP Mainnet. This repo tests `L1BTCDepositorWormhole`
V2 Base and V2 Arbitrum and `L2BTCRedeemerWormhole` against a network pretending
to be mainnet, so this is a real gap rather than a nicety.

**Build profiles.** Different compilation settings per workflow.
`hardhat.config.ts` already hand-rolls this: `bridgeGovernanceCompilerConfig`
drops `runs` to 1 for one contract so it fits under EIP-170. That is the problem
build profiles exist to solve.

**Solidity tests with cheatcodes**, which would suit the Bitcoin script,
BIP-340/341 and sighash code. Worth noting this is the one item not exclusive to
Hardhat 3 — Foundry provides it today, with no ESM conversion and no plugin
ecosystem to wait on. See `foundry-evaluation.md`.

**Not a reason:** EDR. The Rust execution engine was backported to Hardhat 2 in
2.21.0, so it is already in use here at 2.29. Performance is not part of the
case.

Nothing here blocks current work. The suite is green on hardhat 2.29 and Node 24,
the archived dependency is gone, and the fixture-loader defect that started this
line of investigation was fixed independently with no dependency change at all.
