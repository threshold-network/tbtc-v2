# OpenZeppelin upgrades-core bytecode matching

The patch for `@openzeppelin/upgrades-core` 1.46.0 fixes the bytecode matching
failure tracked in [OpenZeppelin issue #1227](https://github.com/OpenZeppelin/openzeppelin-upgrades/issues/1227).
`getUnlinkedBytecode` tries each cached contract's library references against the
input bytecode. An unrelated candidate can place a library placeholder across a
metadata boundary, causing `getVersion` to reject valid input while computing a
metadata-free hash that matching does not use.

Use `hashBytecode` for this comparison, which only needs `withMetadata`. Exact
hash matching and subsequent version, upgrade-safety, and storage checks remain
in place; validation errors are not caught or ignored. Both the TypeScript source
and the distributed JavaScript are patched.

`test/upgrades-bytecode.test.ts` covers the affected `BTCDepositorWormhole`
artifact, actual library linking, unknown bytecode, and malformed bytecode. The
existing Wormhole tests also exercise proxy deployment through the upgrade plugin.
After building, run:

```sh
yarn test test/upgrades-bytecode.test.ts test/cross-chain/wormhole/BTCDepositorWormhole.test.ts --no-compile
```

Remove this patch when an upstream release fixes candidate matching and these
regressions pass without it.

This repo also carries two `postinstall` shell scripts under `scripts/` that
patch other dependencies in place (`apply-solidity-contracts-export-deploy-patch.sh`,
`patch-hardhat-undici-connect-timeout.sh`). For any future npm-published
dependency patch, prefer this Yarn `patch:` protocol: it is lockfile-checksummed
and verifies that the patch applies. Of the two legacy scripts, the deploy-script
copier overwrites files without checking their original contents, while the
Hardhat timeout patch exits successfully if its expected pattern is absent.

A third legacy postinstall script, `patch-upgrades-core-unlinked-bytecode.sh`,
was removed because this Yarn patch fully supersedes it.
