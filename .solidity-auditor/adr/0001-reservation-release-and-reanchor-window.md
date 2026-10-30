# Decision: Release path and re-anchor window for reservation positions

Date: 2026-10-13 | Status: accepted

## Context

A reservation position on a Live wallet that passed `dissolutionEligibleAt` held wallet and global capacity forever, because `notifyReservationStranded` refused Live wallets and milestone 1 had no other release path for a position. Separately, anyone could push such a wallet into Closing and strand the position in the same transaction, ahead of the owner's re-anchor right. See `FIXES.md` (R-12, R-07).

## Options Considered

1. **Permissionless release on Live wallets after `dissolutionEligibleAt` (chosen for R-12)**
   - Pros: capacity is released without governance; no new role.
   - Cons: anyone can strand an expired Live position; the owner keeps the minted tBTC but the anchor stops being tracked.
2. **Governance-only release**
   - Pros: no griefing surface.
   - Cons: needs an operator action for every expired position. Not implemented.
3. **Reuse `walletClosingPeriod` as the re-anchor window on Closing wallets (chosen for R-07)**
   - Pros: no new parameter or storage.
   - Cons: window length is tied to a wallet-lifecycle parameter.
4. **New dedicated re-anchor window parameter**
   - Pros: independent tuning.
   - Cons: new storage and governance setter. Possible later; flagged for the PR authors.

## Decision

Allow anyone to strand a Live-wallet position once `block.timestamp >= dissolutionEligibleAt` (`Reservation.sol` strand guard). For Closing wallets require `closingStartedAt + walletClosingPeriod` as well.

## Rationale

Both choices fix the capacity leak and the race without new storage or roles. The human confirmed both in decision round 11 (H3, H4).

## Consequences

- Positive: expired positions free their capacity; every position gets at least one closing period to re-anchor.
- Negative: permissionless strand of an expired Live position; the window length cannot be tuned alone.
- Neutral: the fuzz properties SP-66 and SP-95 model both rules (`Properties.sol`).

## References

- Fix commits on the public branch: `ebc07b1a`, `2df6ff0e`
- Open points for the PR authors: `FIXES.md`, section "Open points for the authors"
- Mutant check that SP-95 still detects a missing R-12: `fizz_data/triage/C12-fix-branch.verdict.md`
