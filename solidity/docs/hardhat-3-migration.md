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
scripts, 89 files under `test/` and `tasks/`.

That description was wrong, and it was the largest number in this document.
Measured across all 151 TypeScript files in `deploy`, `test` and `tasks`, plus
the config:

| CommonJS construct     | files  |
| ---------------------- | ------ |
| `require(`             | **2**  |
| `module.exports`       | **0**  |
| `__filename`           | **0**  |
| `import x = require()` | **0**  |
| `__dirname`            | **10** |

The package is CommonJS only by compilation target. Nearly every file already
uses `import`/`export`, because it is TypeScript. The whole ESM conversion is
`"type": "module"`, a `tsconfig` module setting, replacing `__dirname` in ten
files — six of which are deploy scripts, three marked DEPRECATED — with the
`import.meta.url` equivalent, and converting two runtime `require()` calls, in
`tasks/index.ts` and `test/deployment-artifacts.test.ts`, to dynamic
`import()`.

That is an afternoon, not a quarter. ESM is not the blocker; the plugins are.

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

Ordered by what actually costs something, which is not the order this document
had before:

1. Replace `@nomiclabs/hardhat-waffle` and the ethers v5 + typechain stack. This
   is the real body of work: `hardhat-ethers@4` is ready, the waffle matchers
   are not, so every assertion moves to `hardhat-chai-matchers` or the viem
   toolbox. 89 test files. Which of the two, and on what prerequisites, is
   settled below in "Replacing waffle: viem or ethers v6".
2. Port the deploy layer to `hardhat-deploy@2` / rocketh. 60 scripts and the
   tests that consume their fixtures.
3. Release `@keep-network/hardhat-helpers` for Hardhat 3. Ours, so it gates on
   our own cycle rather than anyone else's.
4. Whatever of `hardhat-gas-reporter`, `hardhat-contract-sizer`,
   `hardhat-dependency-compiler` and `solidity-docgen` still has no Hardhat 3
   line by then — drop, replace, or vendor.
5. ESM conversion. Listed last because it is the cheapest item, not the
   gate it was previously described as.

## Replacing waffle: viem or ethers v6

Item 1 above is the expensive one, and it forks. This section records a spike
that migrated one real test file to viem so the fork could be priced instead of
argued. The evidence is preserved in the immutable
[`3cfc4e4`](https://github.com/threshold-network/tbtc-v2/commit/3cfc4e4e0b9d87f40ee12474f3a361ee1084366f)
commit from [`#1066`](https://github.com/threshold-network/tbtc-v2/pull/1066);
the live branch was later reset.

### A premise worth correcting first

The case for viem has been made partly on the grounds that the repo is already
adopting it, so the contract suite would be following rather than leading. That
is true of the repo and false of this package. Measured against the open PRs:

| PR      | files | in `typescript/` | in `solidity/` |
| ------- | ----- | ---------------- | -------------- |
| `#1033` | 60    | 60               | **0**          |
| `#1036` | 177   | 177              | **0**          |

Both are entirely inside the SDK, and `#1036` — the viem migration proper — is
a draft. So there is no head start to inherit: no helper, no fixture, no
matcher from that work is reachable from `solidity/`. Consistency across the
repo is still a fair argument for viem. Reuse is not one.

### What the spike migrated

`test/relay/LightRelayMaintainerProxy.test.ts`, 24 tests, chosen for surface
rather than size. `deployments.fixture()` has five call sites: two shared
fixture helpers and three test files. The other two test files assert
deployment shape and use the waffle matchers once between them; this one uses
them 22 times, and also exercises `waffle.provider` and a gas-refund
assertion. So it is the only place the real deploy chain and a real assertion
surface meet.

|                     | before     | after                       |
| ------------------- | ---------- | --------------------------- |
| whole suite passing | 2690       | 2706                        |
| whole suite pending | 31         | 31                          |
| whole suite failing | 102        | 102 — identical, same order |
| the migrated file   | 24 passing | 24 passing                  |

The sixteen extra tests are `test/helpers/mock.viem-interop.test.ts` and
`test/helpers/viem.test.ts`, both described below. `@nomicfoundation/hardhat-viem` loaded alongside waffle, typechain,
`hardhat-deploy`, ethers v5 and `@openzeppelin/hardhat-upgrades` with no
runtime conflict, which is what makes a file-by-file migration — and therefore
a reversible decision — possible at all.

### What it cost

**The matchers, because there are none on Hardhat 2.** The prerelease
`@nomicfoundation/hardhat-viem-matchers` was renamed:
`@nomicfoundation/hardhat-viem-assertions` went stable as `3.0.0` on 13 August
2025 and is at `3.1.2` today. It is maintained, not abandoned — it simply
peer-depends on `hardhat@^3.8.0`, so there is nothing installable here. So
`revertedWith`, `emit`, `withArgs` and `not.emit` are hand-written:
`test/helpers/viem.ts`, 295 lines, once for the suite. Two matchers the suite
uses are still missing — `changeEtherBalance` (17 sites) and the bare
`to.be.reverted` with no reason (2 sites).

Writing the negative controls found a soundness bug in the first draft.
Arguments were normalised by JavaScript runtime type, rendering every numeric
as its decimal string, which let the string `"100"` satisfy a `uint256`
carrying `100` and the number `100` satisfy a `string` parameter carrying
`"100"`. Normalisation is now keyed on the declared ABI type and tagged with
it, so coercion still happens within a type and cannot happen across two.
`test/helpers/viem.test.ts` is the fourteen cases that hold that line, checked
in rather than run once and described — a matcher that cannot fail is worse
than no matcher, because it makes every test using it pass unconditionally.

The migrated file went from 532 to 647 lines: 310 added, 195 removed.

**Not `test/helpers/mock.ts`.** It is ethers v5 throughout, which reads like a
blocker and is not one. The mock keeps its configuration and its call log in
contract storage, reached over ordinary RPC, so the helper hands back a control
surface rather than a binding. `test/helpers/mock.viem-interop.test.ts` asserts
both directions: a viem `read` returns what the ethers helper configured, and a
`write` sent by viem lands in the ethers-side call log with its arguments
decoded. No port needed.

**Some of the hardhat-helpers.** `helpers.snapshot` survives untouched — it is
`evm_snapshot`/`evm_revert` over the provider, with nothing ethers-shaped in
it. `helpers.signers` and `helpers.contracts.getContract` do not: both return
ethers objects. Their replacement is `getNamedAccounts()` plus
`viem.getWalletClient`, and `deployments.get(name).address` plus
`viem.getContractAt(name, address)`. `waffle.loadFixture`, 55 sites across the
suite, has no viem equivalent either; this file calls its fixture directly
because it calls it once, but that does not generalise.

**Not the codegen step.** `hardhat-viem` is itself a code generator. Compiling
with the plugin loaded emitted **368** `.d.ts` files into `paths.artifacts`
against typechain's **305** generated `.ts` files in `typechain/` — 154 contract
modules plus 151 factories; both directories are gitignored and regenerated on
build. Replacing typechain with viem does not remove a
generation step, it swaps one for another. Five contract names are duplicated
across the tree — `BytesLib`, `Wallets`, `INttManager`, `BitcoinTx`,
`MockTBTCVault` — and the generator types those `never`, so they cannot be
reached by name at all.

**And it reaches the npm package.** `paths.artifacts` is `./build` and the
`files` array publishes `build/contracts/`, so importing the plugin silently
added 195 declaration files to the tarball — 89 of them augmenting Hardhat's
own module types with references to `viem`, for consumers who have no reason to
have it installed. `npm pack --dry-run` shows 195 before and zero after the
`!build/contracts/**/*.d.ts` exclusion this branch adds, with all 212 JSON
artifacts still shipped. Nothing about that is viem-specific — any codegen
plugin writing into `paths.artifacts` would do it — but it was not obvious.

### The part that does not work yet

`@nomicfoundation/hardhat-viem@2.1.4` is current for the Hardhat 2 line and was
published on 21 July 2026 — five days before this measurement — so the Hardhat
2 support is maintained, not abandoned. It runs correctly here. What does not
work is the types, and it takes four changes to fix, not one.

**TypeScript 4.6 cannot parse viem's declarations.** The package is pinned at
`^4.5.4`. viem and `abitype` require `>=5.0.4` and `ox` requires `>=5.4.0`;
all three use syntax 4.6 rejects outright:

| `tsc` invocation          | before | after adding the plugin |
| ------------------------- | ------ | ----------------------- |
| `-p tsconfig.json`        | 40     | **4167**                |
| `-p tsconfig.export.json` | 1      | **4167**                |

The second matters more than the first: `tsconfig.export.json` excludes
`./test` but still compiles `hardhat.config.ts`, and it is what `yarn prepack`
runs before `npm publish`. Importing the plugin is enough to break it. (That it
already reports one error is a separate pre-existing defect, in
`deploy/82_deploy_rebate_and_prepare_txs_DEPRECATED.ts`.)

**TypeScript 5 alone is not enough.** On 5.9.3 the 4167 drop to 87, but the
survivors include viem's own `parseEventLogs.d.ts` and — the one that matters —
`@nomicfoundation/hardhat-viem/types.d.ts`, where `Required<KeyedClient>` fails
viem's constraint and `GetContractReturnType` collapses to `never`. The
practical effect is that every contract loses `.read` and `.write`: 33 errors
in the one migrated file. Two remedies were tried and neither worked. There are
three copies of `abitype` in the tree (0.9.10 hoisted for the plugin, 1.2.3 for
viem, 1.3.0 for `ox`); forcing them to one did not help. Pinning viem back to
2.45.0, six months older, did not either.

**What does work is `strict`.** viem documents it as a requirement and means
it: with `"strict": true` and `"skipLibCheck": true`, `.read` and `.write`
reappear and the contract types become real. The negative controls confirm they
are load-bearing — a `string` passed where the ABI says `uint256`, and a
misspelled function name, are both caught. `paths.artifacts` also has to join
the tsconfig `include`, or the generated `ContractTypesMap` is not in the
program and every handle falls back to an untyped index signature.

So the prerequisite chain for a typed viem suite is: **TypeScript 5.x**,
`skipLibCheck: true`, `strict: true`, and `./build` in `include`. With all four,
the three files from the spike typecheck clean. Without them the tests still
_run_ — `ts-node` is transpile-only here — but nothing is checked.

`strict` is the expensive one. Turning it on raises **378** errors in the 151
TypeScript files that predate the spike — concentrated in 34 of them, six in
`test/helpers/mock.ts`, the rest in code written years before the flag was
considered.

### What ethers v6 costs instead

The comparison is not viem against the status quo, it is viem against the other
replacement. `@nomicfoundation/hardhat-chai-matchers` is a drop-in for the
waffle matchers and is published in three lines:

| package                                         | version | peer `ethers` | peer `hardhat` |
| ----------------------------------------------- | ------- | ------------- | -------------- |
| `@nomicfoundation/hardhat-chai-matchers`        | 1.0.6   | `^5.0.0`      | `^2.9.4`       |
| `@nomicfoundation/hardhat-chai-matchers`        | 2.1.2   | `^6.14.0`     | `^2.26.0`      |
| `@nomicfoundation/hardhat-ethers-chai-matchers` | 3.0.11  | `^6.14.0`     | `^3.8.0`       |

All stable. Read the `hh2` dist-tag rather than `latest` when judging Hardhat 2
support: Nomic renamed several plugins at Hardhat 3 and left a stub behind, and
`hardhat-chai-matchers@3.0.0` — what `latest` resolves to — is a 3.7 kB package
that warns and exits. The usable Hardhat 2 release is `2.1.2`, on the `hh2` tag.

The asymmetry with viem is narrower than it first looks, and worth stating
precisely. Both assertion libraries were renamed at Hardhat 3 and both shipped
stable successors on the same day, 13 August 2025, both peering
`hardhat@^3.8.0`. The difference is entirely on Hardhat 2: ethers has a
supported line there and viem has none. That is the whole of it — but it is the
version we have to ship on for as long as the Hardhat 3 migration takes.

Beyond that, ethers v6 needs no `strict` and no new code generator, and
`revertedWith`/`emit`/`withArgs` keep working, so the 931 + 571 + 522 existing
assertion sites move rather than being rewritten.

It does need TypeScript 5, though, and an earlier revision of this document said
it did not — listing the bump as a viem-only cost. Measured while doing the
migration: typechain v6 types a contract method as `TypedContractMethod`, and on
the pinned TypeScript 4.6 a conditional type cannot resolve against it, so the
mock helper's whole configuration surface stays invisible.

|                  | errors | `reset` / `returns` / `whenCalledWith` |
| ---------------- | ------ | -------------------------------------- |
| TypeScript 4.6.2 | 2741   | 343 / 228 / 174                        |
| TypeScript 5.9.3 | 1910   | 0 / 0 / 0                              |

So TypeScript 5 is a shared prerequisite of both paths rather than a
differentiator. What still separates them is `strict` — viem's contract types
collapse to `never` without it, ethers v6 does not care — and that is the
expensive half, at 378 errors in files that predate it.

### The two paths differ in shape, not only in cost

This was measured after the decision below was first written, and it does not
reverse it — but it is the thing most likely to surprise whoever does the work,
so it belongs above the decision rather than in a footnote.

**viem coexists with waffle. ethers v6 does not.**

`@nomicfoundation/hardhat-chai-matchers` refuses to load beside
`@nomiclabs/hardhat-waffle`, by design, at config-load time:

```
Error: You are using both @nomicfoundation/hardhat-chai-matchers and
@nomiclabs/hardhat-waffle. They don't work correctly together, so please
make sure you only use one.
  at hardhatWaffleIncompatibilityCheck (hardhat-chai-matchers/src/index.ts:8:34)
```

It is a deliberate check, not a subtle interaction. And the dependency cannot
be halved either: `hardhat-chai-matchers@2` peer-depends on `ethers@^6.14.0`
through `@nomicfoundation/hardhat-ethers@3`, while waffle needs v5, and a
package alias does not satisfy a peer range. So there is no configuration in
which some files are on ethers v6 and the rest still run.

|                       | viem                                                           | ethers v6                             |
| --------------------- | -------------------------------------------------------------- | ------------------------------------- |
| coexists with waffle  | yes — 26 tests green beside 2971 waffle tests                  | **no**                                |
| migration shape       | file by file, reversible at any point                          | 92 files in one commit                |
| call sites            | one file at a time                                             | ~5000, measured below                 |
| matchers on Hardhat 2 | none; 295 hand-written lines                                   | `hardhat-chai-matchers@2.1.2`, stable |
| prerequisites         | TypeScript 5, `strict`, `skipLibCheck`, `./build` in `include` | none                                  |

The ethers v6 surface across the 92 files in `test/`:

| construct                                          | sites |
| -------------------------------------------------- | ----- |
| `.address`                                         | 2478  |
| `ContractTransaction`                              | 504   |
| `ethers.utils.*`                                   | 440   |
| `ethers.constants.*`                               | 413   |
| `BigNumber`                                        | 411   |
| BigNumber arithmetic (`.add`/`.sub`/`.mul`/`.div`) | 401   |
| `SignerWithAddress`                                | 267   |
| `.deployed()`                                      | 51    |

The destination is verified working — ethers v6.17 with
`hardhat-chai-matchers@2.1.2` on hardhat 2.29, with `revertedWith`, `emit` and
`withArgs` all biting on their negative controls. What is not available is a
half-way state.

**Why this does not change the decision.** Almost all of that surface is
mechanical and, unlike the viem path, a type checker can find it: swap the
dependency and `tsc` flags nearly every broken call site. The viem path trades a
big mechanical change for a long series of semantic ones, plus matchers we own
until Hardhat 3. But the plan has to say big-bang out loud, because "migrate a
few files and evaluate" — which is what made the viem spike possible — is not
on offer here.

### Decision

**Migrate `solidity/` to ethers v6 with `@nomicfoundation/hardhat-chai-matchers`,
and keep viem to `typescript/`, where `#1036` is already taking it.**

The spike does not say viem is unworkable — it works, at runtime, today, next
to everything else. It says the two paths are not comparable in cost. viem
carries a four-item prerequisite chain whose expensive link, `strict`, is 378
errors of unrelated cleanup, and its assertion layer would be ours to maintain on Hardhat 2
until Hardhat 3, where Nomic's `hardhat-viem-assertions` takes over.
ethers v6 carries none of that and lands on a library with a released Hardhat 3
version.

Two things follow that are worth doing regardless of which way this goes:

- The TypeScript 5 and `strict` work is worth scheduling on its own merits.
  If it lands first, this decision is worth revisiting — most of viem's cost
  is that chain, not viem.
- `test/helpers/viem.ts` and the interop test are preserved in the immutable
  [`3cfc4e4`](https://github.com/threshold-network/tbtc-v2/commit/3cfc4e4e0b9d87f40ee12474f3a361ee1084366f)
  spike commit. If the decision is revisited, the matchers and the proof that
  the mock needs no port are the two things that would otherwise be redone.
- The incomplete ethers v6 migration is preserved at
  [`c367c63`](https://github.com/threshold-network/tbtc-v2/commit/c367c63c00ddfaed91d6f14bb3c34714a02bad95)
  from [`#1067`](https://github.com/threshold-network/tbtc-v2/pull/1067). It
  reduced the compiler error count from 1,922 to 536 but never completed the
  typecheck or ran the test suite; use it as migration evidence, not as a merge
  candidate.

## What Hardhat 3 is actually worth here

Not urgent this week, but not optional either, and worth being accurate about
which parts are real gains:

**Multichain simulation.** Hardhat 2's development network always behaves like
Ethereum mainnet. Hardhat 3 allows several simulated networks with different
chain types, shipping with OP Mainnet. This repo tests `L1BTCDepositorWormhole`
V2 Base and V2 Arbitrum and `L2BTCRedeemerWormhole` against a network pretending
to be mainnet, so this is a real gap rather than a nicety.

**Build profiles.** Different compilation settings per workflow.
`hardhat.config.ts` already hand-rolls this: the project compiles at
`runs: 1000`, `bridgeGovernanceCompilerConfig` drops `BridgeGovernance.sol` to
200, and a second override drops `L1BTCDepositorNttWithExecutor.sol` to 1 to
keep it under EIP-170. That is the problem
build profiles exist to solve.

**Solidity tests with cheatcodes**, which would suit the Bitcoin script,
BIP-340/341 and sighash code. Worth noting this is the one item not exclusive to
Hardhat 3 — Foundry provides it today, with no ESM conversion and no plugin
ecosystem to wait on. See `foundry-evaluation.md`.

**Not a reason:** EDR. The Rust execution engine was backported to Hardhat 2 in
2.21.0, so it is already in use here at 2.29. Performance is not part of the
case.

Nothing here blocks current work. The archived dependency is gone, and the
fixture-loader defect that started this line of investigation was fixed
independently with no dependency change at all.

## The suite was not green, and this document said it was

An earlier revision closed by calling the suite green on hardhat 2.29 and
Node 24. It was not, and CI had been saying so for as long as the stack existed:

| PR      | Node | CI before                               |
| ------- | ---- | --------------------------------------- |
| `#1062` | 20   | green                                   |
| `#1063` | 20   | 2466 passing / 31 pending / 188 failing |
| `#1064` | 24   | 2690 / 31 / **102**                     |
| `#1065` | 24   | 2690 / 31 / **102**                     |

Not the 23 previously recorded, and not the same failures — none of the 102 was
the `deployed ReimbursementPool contract not found` error that accounted for
all 23. The regression entered at `#1063`, the smock removal itself; `#1064`'s
toolchain bump repaired 86 of the 188 rather than causing any.

It is fixed, in three commits on `#1063`. **2971 passing, 31 pending, 0
failing**, three consecutive runs. The four defects, and what each was:

**A `deployments.fixture()` rollback un-installed the fixture's mocks — 43.**
`test/fixtures/bridge.ts` ran `deployments.fixture()` and only then installed
MockContract bytecode over the real `WalletRegistry` and `LightRelay` addresses
with `hardhat_setCode`. A bare `deployments.fixture()` later in the run, in
`test/bridge/Deployment.test.ts`, reverted to hardhat-deploy's snapshot from
_below_ those mocks and invalidated every snapshot id taken after it. waffle's
`loadFixture` discards the boolean `evm_revert` returns, so from that file
onward it handed back stale handles over unmocked state and every
`relay.getX.returns(...)` became a call to a real `LightRelay` with neither the
selector nor a fallback — the 28 `function selector was not recognized` errors,
all of them after that file and none before. hardhat-deploy's `createFixture`
checks that boolean and re-runs the fixture, so the fixture is built with it
now and the 20 consumers call it directly.

This one was older than the migration. waffle has always discarded that result;
it was harmless only while smock's fakes lived in process memory where no
`evm_revert` could reach them. Eight suites had been running on leaked state
rather than a fresh fixture for years.

**`allowBlocksWithSameTimestamp: true` removed a second the tests relied on — 51.** Hardhat defaults the flag to `false`, which forces a block whose computed
timestamp equals its parent's to become parent + 1. `increaseTime` is
`evm_setNextBlockTimestamp(last + t)` then `evm_mine` — absolute, no slack — so
`increaseTime(D)` landed exactly on `anchor + D` and the transaction under test
shared that timestamp instead of getting the free extra second. Every guard
involved is strict, so "advance by exactly D" described a state the contract
calls not elapsed.

The tests were always wrong about the precondition and the node default was
silently correcting them. The fix is 57 edits that say what the setup always
meant, each monotone-safe — drift can now only add margin — and each paired
negative test deliberately untouched, so every boundary stays bracketed from
both sides with a second of slack instead of sitting on top of it.

The flag stays: `test/helpers/mock.ts` pins the next block to the current
timestamp, so with the flag off the suite dies in its first hook. Configuring
mocks through `hardhat_setStorageAt` so configuration costs no block — which
would let the flag be deleted — is the real cure and is left as a follow-up.

**`expectCalledOnceWith` compared representation, not value — 6.** It
normalised `BigNumber` to a string on each side independently and only at the
top level, so a `uint256` argument failed against a `uint32` getter's plain
number, and numbers nested inside an array were never normalised at all. smock
compared `BigNumberish` numerically at any depth.

**The `Mock` handle had no `.connect` — 2.** smock's `FakeContract` extended
`ethers.Contract`; the proxy resolves only the mocked ABI plus its own keys.

Three things found on the way, worth knowing:

- **A pinned mock was configured at the wrong address.** The base zero-return
  layer and the non-recording flags were installed on the temporary deployment
  address and the bytecode was moved afterwards with `hardhat_setCode`, which
  copies code and not storage. So `relay` and `walletRegistry` ran with
  neither. Masked by MockContract's 2048-zero-byte last resort and the
  `try`/`catch` around the recording self-call.
- **The clock failures were racy, and CI showed it.**
  `Bridge - Redemption > notifyRedemptionTimeout > … > when wallet state is Closed` failed on the `#1065` run and passed on the `#1066` one — same code,
  different runner. Landing exactly on a boundary a strict guard rejects is a
  coin flip weighted by runner load, which is why the count was 102 on five
  runs and 101 on a sixth.
- **One refund ceiling had to move**, and it is the only assertion changed
  rather than the setup around it. MaintainerProxy's "pending requested
  redemptions and reported timed out requested redemptions" refunds 0,0073848
  ETH deterministically against a 0,007 cap. The relay is a `MockContract` now,
  so the difficulty reads inside the proof cost real gas where smock's fakes
  cost none, and the refund tracks gas used — the same change that made `#1064`
  raise `blockGasLimit`. `#1062` was green with that cap and smock in place, so
  the migration is what raised it. It is the only one of 34 refund ceilings in
  that file without the headroom to absorb the difference, and it went
  unnoticed because its `before` hook was failing. The other 33 now measure
  MockContract's dispatch cost too and are worth revisiting as a group.

`#1063` itself remains red — 2624 passing, 119 failing, down from 188. What is
left there is fixed by `#1064`'s toolchain bump and by nothing else, because
`#1063` deliberately pins hardhat 2.19.5 and `#1064` removes the pin. From
`#1064` onward the stack is green.
