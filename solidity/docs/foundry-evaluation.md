# Foundry evaluation

Status: **worth doing incrementally, not as a migration.** This document exists
so the option is costed rather than periodically re-litigated.

It is the third of three toolchain documents, and the only one that proposes
adding something rather than removing it. Read alongside
`hardhat-3-migration.md`.

## Why this keeps coming up

Three separate investigations converged on one dependency:

| finding                                       | consequence                              |
| --------------------------------------------- | ---------------------------------------- |
| `@defi-wonderland/smock` is archived upstream | no security patches, ever                |
| smock breaks on hardhat >= 2.20               | toolchain frozen below 2.20 (on 2.12.5)  |
| hardhat < ~2.20 cannot run Node 24            | CI capped at Node 22 until smock is gone |
| no maintained JS mocking library exists       | nothing to migrate _to_                  |

Rows 2 and 3 were measured rather than inferred, because the version numbers are
easy to get wrong. `hardhat: "^2.10.0"` resolves to **2.12.5** in `yarn.lock`. A
cold compile of this repo on Node 24 fails under 2.12.5 and 2.19.5 with `HH502`,
and succeeds under 2.29.0. The cause is dependency skew in the solc download
path — npm `undici@5.10.0` and Node 24's bundled undici share a global-dispatcher
symbol, so the request reaches Node's internal dispatcher, which no longer accepts
`maxRedirections`. Bumping only `undici` does not fix it; bumping hardhat does.
And smock 2.3.4 against hardhat 2.29.0 throws in `Sandbox.create` (verified on
Node 20, so Node is not a variable).

So Node 24 is gated on removing smock — 29 test files, 77 `smock.fake` call
sites, 15 distinct types.

The fourth row is the interesting one. `@ethereum-waffle/mock-contract` (2023),
`@gnosis.pm/mock-contract` (2022) and `@clrfund/waffle-mock-contract` (2024, and
requires ethers v6) are all dead or unusable. The category has no maintained
option because the ecosystem moved to Foundry, where mocking is native
(`vm.mockCall`) and needs no package.

So Foundry is not a preference question. It is where the mocking capability
this repo depends on actually lives now.

## What a full migration would cost

| surface                              | size  |
| ------------------------------------ | ----- |
| solidity test files (TypeScript)     | 71    |
| deploy scripts (hardhat-deploy)      | 60    |
| tests driving `deployments` fixtures | 17    |
| tests using smock                    | 29    |
| existing `.t.sol` tests              | **0** |

Two things make a wholesale port unattractive:

1. **The deploy layer is the hard part, not the tests.** 60 `hardhat-deploy`
   scripts and 17 tests that consume its fixtures have no Foundry equivalent.
   Foundry's `script/` is a different model, not a port target.
2. **The tests are not the expensive part to keep.** They pass, they are
   maintained, and TypeScript integration tests against ethers are a reasonable
   thing to own.

## What is actually worth doing

Foundry coexists with Hardhat — same `contracts/`, different runner. keep-core
already proves the setup is cheap: `solidity/ecdsa/foundry.toml` exists with
remappings and `solc_version = "0.8.17"`, though it has **zero `.t.sol` files
and no CI wiring**, so it was set up and never used.

The incremental version:

1. Add `foundry.toml` alongside the existing Hardhat config. No test moves.
2. Write **new** property/fuzz tests in `.t.sol` where Foundry is strongly
   better — Bitcoin script parsing, BIP-340/341 verification, sighash
   construction, the P2TR coverage-proof maths. These are pure functions over
   bytes, which is exactly where fuzzing pays and where JS round-tripping is
   awkward.
3. Leave every existing `.test.ts` alone.
4. Revisit only if the deploy layer independently moves off hardhat-deploy.

This is additive: no migration, no dual maintenance of the same test, no
dependency removed or added on the JS side.

## Coexistence is not quite free

Adding `foundry.toml` and changing nothing else broke the `contracts-slither`
job on this branch's first CI run:

```
Multiple frameworks detected: Foundry, Hardhat. Using Foundry (highest priority).
Use --compile-force-framework to override.
```

`crytic-compile` chooses a build system by looking for config files, and ranks
Foundry above Hardhat. `forge` is not installed on that runner, so slither
exited 255 without analysing anything — a security job turning red for a reason
unrelated to any contract. The fix is one flag,
`--compile-force-framework hardhat`, applied here.

Worth stating plainly because the obvious check does not catch it: Hardhat
itself compiles all 175 files with `foundry.toml` present. What breaks is
third-party tooling that _sniffs_ for a framework rather than being told which
one to use. Anything else in CI or in a contributor's editor that auto-detects
is a candidate for the same surprise.

## Relationship to the smock work

The smock replacement (Solidity stubs, see `ReimbursementPoolStub`) is a
prerequisite either way, and is **not** wasted effort if Foundry never happens:

- it unblocks hardhat >= 2.20, and therefore Node 24 and Hardhat 3
- hand-written Solidity stubs are consumable from `.t.sol` unchanged, because
  they are contracts rather than JavaScript

That is the argument for stubs over any JS mock library. Every JS option dies at
the next toolchain move; a stub contract does not.

## Not recommended

- Porting the 71 existing test files.
- Adopting Foundry to "fix" smock — the Solidity stubs do that on their own, at
  a fraction of the cost.
- Setting up `foundry.toml` and writing nothing, which is the state keep-core is
  in today.
