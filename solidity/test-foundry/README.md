# Foundry tests

Deliberately empty of ported tests. Every existing suite stays in `test/` on
Hardhat.

This directory is for **new** property and fuzz tests where Foundry is a clear
win over the TypeScript suites — pure functions over bytes, where fuzzing finds
what example-based tests do not:

- Bitcoin script parsing and output-key derivation
- BIP-340 Schnorr verification
- BIP-341 sighash construction
- P2TR coverage-proof / Merkle maths

`forge-std` is not yet a dependency; add it when the first test lands.

See `../docs/foundry-evaluation.md` for the reasoning and for what is explicitly
not proposed.

## Running these

`forge-std` is vendored rather than installed from npm: the `forge-std` package
on npm is an unofficial mirror of a different repository and does not ship
`src/Test.sol`. Install the real one once:

```
forge install foundry-rs/forge-std
```

then

```
forge test
```

`lib/` is gitignored, so this is a one-time local step and a CI step whenever
these tests are wired into a workflow.
