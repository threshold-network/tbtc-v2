# Decision: How the fixes are delivered and which fuzz failures stay visible

Date: 2026-10-13 | Status: accepted

## Context

The audit produced fixes, Foundry proofs of concept, a fuzz harness and reports. Only part of this belongs in the public draft PR #1116. Some findings also fail fuzz properties that could be hidden on a known-failures list.

## Options Considered

1. **Push fixes and Hardhat regression tests into PR #1116; keep audit material private (chosen)**
   - Pros: authors review fixes next to their own code; no audit detail leaks.
   - Cons: authors get a branch update they did not request; the PR conflicts with `dev`.
2. **Send a separate PR from a fork**
   - Pros: no change to the authors' branch.
   - Cons: slower to merge; two copies of the same code.
3. **Report only, no code**
   - Pros: no public change.
   - Cons: leaves the fixes undelivered.

## Decision

- Deliver production fixes, `deploy/98`, Hardhat tests, test helpers and two snapshots in PR #1116. Never add `.solidity-auditor/`, PoCs, fuzz or mutation material, scripts or `foundry.toml` (H6).
- The RebateStaking setter bounds are reported to the maintainers outside this PR and are not part of it (H5).
- SP-65 and SP-94 stay OFF `known-failures.txt` (H8): the fix branch must make SP-65 pass, and SP-94 must keep showing the open R-01 relay gap.
- The audit branch and the fix branch are backed up as refs in a private repository, so the record survives the delivery.

## Rationale

The human approved this scope in decision round 11 (H5, H6, H8) and the backup in round 12. A known-failures entry hides a signal, so it is used only for properties that cannot pass by design.

## Consequences

- Positive: reviewers see the fixes; fuzz keeps flagging SP-94 (the open R-01 relay gap).
- Negative: long fuzz runs report known open items every time; they need a triage table (`C10` and `C12` verdicts).
- Neutral: merging `dev` into the PR needs an ethers v6 port of its Hardhat tests (round 12 decision, local only).

## References

- PR: threshold-network/tbtc-v2#1116 (comment 6162994445)
- Register rows: see `REGISTER.md` (kept with the maintainers, not published).
