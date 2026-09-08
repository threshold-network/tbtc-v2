# Solidity toolchain upgrades

This records the September 2026 follow-up to the July assessment in
[hardhat-3-migration.md](hardhat-3-migration.md). The measurements in that
assessment describe its historical baseline.

## TypeScript and published deployment scripts

The package now enables `strict` for its deployment scripts, tasks, helpers,
tests and generated contract bindings. TypeChain 8 and the ethers-v6 bindings
come from [PR #1067](https://github.com/threshold-network/tbtc-v2/pull/1067).
Fixtures have explicit types; missing receipts, blocks and ABI fragments fail
with context instead of being asserted away. The existing CI typecheck enforces
these settings.

`tsconfig.export.json` emits ES2020 **CommonJS**. Consumers execute the
published `export/deploy/*.js` files through hardhat-deploy v1's `require()`
loader. ES2020 fits within this package's declared Node >=22 runtime and its
Node 24 CI toolchain. Changing the syntax target does not make the exports ESM.
`downlevelIteration` is removed because native iteration is available at this
target. The TypeScript 6 deprecation opt-out is removed as well.

Runtime declarations follow the installed runtime: Node 24, Chai 4 and Mocha 11. `@types/mocha` 10.0.10 is the latest published declaration release, including
for Mocha 11; `@types/chai` stays on 4.x until the Chai runtime is migrated.

These changes address [#1072](https://github.com/threshold-network/tbtc-v2/issues/1072),
[#1073](https://github.com/threshold-network/tbtc-v2/issues/1073) and
[#1078](https://github.com/threshold-network/tbtc-v2/issues/1078). PR #1067 also
replaces the three legacy Hardhat plugins and upgrades TypeChain, covering
[#1074](https://github.com/threshold-network/tbtc-v2/issues/1074) and
[#1076](https://github.com/threshold-network/tbtc-v2/issues/1076). These are
stacked changes. PR #1067 now uses the documented two-exception
[compatibility policy](ethers-v6-parity.md); its original raw byte comparison
still fails. That policy is pinned to #1067 and is not expanded by this
TypeScript/export migration.
Strict checking also covers the inherited parity scripts. The capture config
now declares its provider request type and checks the required Hardhat network
configuration explicitly. Its source hash therefore differs from #1067; old
snapshots are deliberately rejected by this version of the checker. Use the
immutable #1067 revision to reproduce that historical result. This change
does not revise the checked-in policy, regenerate evidence or claim compatibility
for the additional TypeScript/export changes.

Raising the export target to ES2020 additionally invalidates the checked-in
policy on its own, independent of the capture-config-hash rejection above:
the emit (and therefore the pinned candidate hash) of all 19
`compiledDeployScripts` entries in `pr1067-parity-policy.json` changes; the
~42 unpinned `export/deploy/*.js` modules the checker also compares now
differ from the es5 baseline; and this package's `package.json`/`yarn.lock`
hashes, also pinned by the policy, change from the `@types/mocha`/
`@types/chai` bumps above. No fresh capture taken from this branch can
satisfy `compare-pr1067-parity.ts`. No `for…of` loop in `deploy/` or
`tasks/` iterates a non-array iterable -- the one semantic risk
`downlevelIteration` removal could have introduced -- so dropping it while
raising the target is semantics-preserving for this package's actual code;
that source-level reasoning is offered in place of a full before/after
emit capture, which this repository's current tooling cannot produce.

The stack incorporates [#1127](https://github.com/threshold-network/tbtc-v2/pull/1127)
to include its deployment validation patch and regression coverage.

## Migrations that remain blocked

The following are coordinated deployment migrations, not compatible dependency
bumps. Registry peer ranges were checked on 2026-09-07.

| Issue                                                                                         | Required next step                                                                                                                                                                |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#1071: Hardhat 3](https://github.com/threshold-network/tbtc-v2/issues/1071)                  | Land the ethers-v6 prerequisite under its reviewed compatibility policy and finish the deployment-layer and ESM migrations. Chai 5+ must move with the runtime and matcher stack. |
| [#1075: OpenZeppelin upgrades 4](https://github.com/threshold-network/tbtc-v2/issues/1075)    | Version 4.1.0 requires Hardhat ^3.6.0 and foundation ethers ^4.0.0. Decide and verify the proxy/admin model before replacing the transitional 2.5.1 plugin.                       |
| [#1128: hardhat-deploy 2 / rocketh](https://github.com/threshold-network/tbtc-v2/issues/1128) | Establish the external deployment loader and export-format compatibility, then port scripts and fixtures together with the upstream deployment packages.                          |

OpenZeppelin's [migration guide](https://docs.openzeppelin.com/upgrades-plugins/migrate-from-hardhat-2)
requires Hardhat 3 first and replaces `hre.upgrades` with an async factory tied
to a shared network connection. Updating just the package version would break
our deployment API. This work does not alter production network manifests or
select a new proxy/admin model.

The current deploy-v2 [package metadata](https://registry.npmjs.org/hardhat-deploy/2.0.26)
requires Hardhat ^3.6.0 and rocketh/@rocketh/node ^0.21.0.
`@keep-network/hardhat-helpers` 0.7.2 still declares Hardhat 2 peers. The three
upstream packages selected by `external.contracts` publish v1-shaped CommonJS
deploy scripts. Before replacing that loader, validate all those scripts and
both published formats (`export/` and `export.json`) against an explicit
consumer compatibility contract. Keep these three issues open until their
runtime migrations and acceptance checks are complete.

## Lint policy

The ESLint 10 flat configuration uses typescript-eslint 8 and import-x.
`eslint.rules.cjs` preserves the active non-formatting rules resolved from
`@thesis-co/eslint-config` 0.1.0; removed TypeScript rules use their current
replacements. Prettier owns formatting, and unused React/JSX configuration is
omitted. JavaScript keeps both the correctness rules provided by TypeScript's
compiler and the applicable core counterparts of the inherited TypeScript
extension rules, including unused expressions, shadowing and loop closures.
The existing deployment overrides still apply to JavaScript deployment patches.
The import-x TypeScript preset supplies export-map traversal settings as well
as module resolution, so dependency-cycle analysis follows TypeScript imports.
`tsconfig.eslint.json` is checked in so fresh
installs do not depend on the old shared package generating one.

The existing test overrides and the prohibition on `waffle.loadFixture` remain.
Focused tests (`describe.only` / `it.only`) are errors. Unused disable comments
are errors, including the obsolete `no-extra-semi` suppressions removed in this
migration. `npm run test:lint-policy` checks actual cyclic and acyclic TypeScript
modules, JavaScript correctness violations and accepted deployment overrides.
It runs as part of `lint:eslint`, including the existing formatting CI job.
Node 22.13+ or Node 24+ is required by ESLint 10.

The existing warning debt stays visible with a ceiling of 321 in both ESLint
commands: 263 console uses, 31 unnamed functions, 19 unused variables, five
explicit `any` types and three non-null assertions. Reduce the ceiling when
fixing these warnings; do not increase it to accommodate new warnings. This
records the warning baseline for the migration without disabling those checks.
