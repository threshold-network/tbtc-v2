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
