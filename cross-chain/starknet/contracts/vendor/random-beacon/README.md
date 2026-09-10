# Reimbursement compatibility sources

These two unmodified contracts come from `@keep-network/random-beacon@2.1.0-dev.18`,
the version previously resolved by this package. `VENDOR.json` records the npm
tarball and source hashes; the original GPL-3.0-only headers and license are kept.

The depositor inherits `Reimbursable` and calls `ReimbursementPool`. Keeping their
exact source preserves the existing inheritance/storage layout without installing
the entire legacy Beacon and sortition dependency graph. Updates must be explicit
and include a storage-layout review.
