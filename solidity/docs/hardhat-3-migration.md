# Hardhat 3 migration assessment

Status: **still blocked, but for fewer reasons than before.** This document
records what was measured, so the next attempt starts from facts rather than a
guess.

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

**ESM only.** Hardhat 3 refuses to load a CommonJS project:

```
Hardhat only supports ESM projects.
Please make sure you have `"type": "module"` in your package.json.
```

The `solidity` package is CommonJS throughout — `hardhat.config.ts`, 60 deploy
scripts, 70 test files and `tasks/`. Flipping `"type": "module"` changes
`require`/`__dirname` semantics and the extension rules for every relative
import in the package. This is the single largest item and nothing else can
start until it lands.

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

## Why it is not urgent

Nothing here blocks current work. The suite is green on hardhat 2.29 and Node 24,
the archived dependency is gone, and the fixture-loader defect that started this
line of investigation was fixed independently in
`test(solidity): verify the fixture snapshot before trusting it` with no
dependency change at all.

Hardhat 3's real draw for this repo is Solidity tests with `vm.mockCall` and the
other cheatcodes, which would suit the Bitcoin script, BIP-340/341 and sighash
code well. That capability is available from Foundry today without any of the
above — see `foundry-evaluation.md`.
