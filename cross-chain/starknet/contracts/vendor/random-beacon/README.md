# Reimbursement compatibility sources

These two unmodified contracts come from `@keep-network/random-beacon@2.1.0-dev.18`,
the version previously resolved by this package. `VENDOR.json` records the npm
tarball and source hashes; the original GPL-3.0-only headers and license are kept.

The depositor inherits `Reimbursable` and calls `ReimbursementPool`. Keeping their
exact source preserves the existing inheritance/storage layout without installing
the entire legacy Beacon and sortition dependency graph. Updates must be explicit
and include a storage-layout review.

On the next real upgrade, the `.openzeppelin/{mainnet,sepolia}.json` layout
entries for `Reimbursable` will have their `src` rewritten from
`@keep-network/random-beacon/contracts/Reimbursable.sol` to
`contracts/vendor/random-beacon/Reimbursable.sol` (`src` is inert
error-report metadata; OpenZeppelin's storage-layout comparison keys on
label/type/slot, not `src`). Expect this diff in the manifest — it is not a
layout change.
