# Reviewed Slither results

The [triage database](../slither.db.json) contains two exact Slither 0.9.0
report fingerprints for the deferred-refund recovery branch in
`AbstractL1BTCDepositor.finalizeDeposit`. Existing detector and path settings
are unchanged. Solidity sources are unchanged, preserving their bytecode and
compiler metadata.

## Failed deferred refund: reentrancy-no-eth

The reported write restores the saved `gasReimbursements[depositKey]` only
when the bounded low-level reimbursement call returns `success == false`.
That call's state changes and logs, including those of nested calls, have
reverted. Restoring the original unpaid reimbursement therefore cannot
overwrite a payment committed by that failed call.

The deposit is marked `Finalized` before the first external interaction.
`initializeDeposit` requires `Unknown` and `finalizeDeposit` requires
`Initialized`, preventing another initialization or finalization of that
deposit key during reimbursement. The deferred entry is also deleted before
the token-transfer call. Other deposit keys have separate state; this triage
does not assert that the whole contract is non-reentrant.

## Failed deferred refund: reentrancy-events

`DeferredReimbursementFailed` records the failed call's outcome and the
original deposit key, receiver and amount of gas. Emitting it after the call
is intentional. The failed call's nested logs have reverted, and the deposit
remains finalized. The event does not signal an additional payment.

## Evidence and maintenance

The tests in
[AbstractL1BTCDepositor.test.ts](../test/cross-chain/AbstractL1BTCDepositor.test.ts)
exercise an ordinary rejected refund and check the final deposit state,
restored reimbursement, clearing before token transfer, failure event and
rejection of a second finalization. Existing tests cover successful refunds
and their ordering.

Each triage entry records the reviewed source's SHA-256.
[slither-triage.test.ts](../test/deploy/slither-triage.test.ts) fails if that
source changes, requiring the findings to be reviewed again. Update an entry
only after reviewing the changed control flow and relevant tests; do not
refresh hashes merely to make CI pass.

To see the untriaged findings, use Slither's `--show-ignored-findings` option
or temporarily move `slither.db.json` out of the checkout. Slither documents
the database behavior in its
[triage guide](https://github.com/crytic/slither/wiki/Usage#triage-mode).
