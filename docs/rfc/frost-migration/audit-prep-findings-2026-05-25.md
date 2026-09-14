# FROST migration audit-prep findings (2026-05-25)

> **Historical appendix (2026-08-14):** This document is a
> **dated findings sweep** from 2026-05-25, plus a 2026-05-27
> addendum and the original (May-2026) PR-status tracker
> references throughout. Per the 2026-08-14 multi-agent
> review, PR-status trackers and dated findings sweeps rot on
> contact and should not be the primary durable documentation
> for the FROST migration. The substantive design decisions
> are captured in
> [`scheme-preference-and-retirement-rfc.md`](./scheme-preference-and-retirement-rfc.md),
> [`d2-ecdsa-hard-retirement-plan.md`](./d2-ecdsa-hard-retirement-plan.md),
> and [`wallet-registry-trust-model-rfc.md`](./wallet-registry-trust-model-rfc.md)
> (each of which has been updated to reflect the canonical
> mirror as of 2026-08-14). The body of THIS document is
> preserved as a historical audit trail; treat it as
> point-in-time evidence of what the team thought was needed
> before the canonical-mirror reconciliation, not as the
> current source of truth. For activation gating, read
> `bridge-lifecycle-router-followup-plan.md` and the canonical
> activation runbook in `scheme-preference-and-retirement-rfc.md`.

Sweep of the merged FROST migration surface
(`solidity/contracts/frost-registry/`, `solidity/contracts/bridge/`,
`solidity/test/frost-registry/`, `solidity/test/integration/utils/`,
`docs/rfc/frost-migration/`) for residual hygiene issues prior to
external audit. Categorized by load-bearingness.
- grep for `EcdsaRetired`/`finalizeEcdsaRetirement`/
  `seedEcdsaWalletCount`/`requestNewWalletOfScheme` to verify
  references match shipped reality after the D-2.2 emit-drop
  - D-2 finalization-drop + C-2 seed-setter deferral.
- grep for `// removed`/`was removed`/`used to` markers for
  archaeology that should either be excised or accurately
  describe history.
- Scan `BridgeStub.sol` for test-only helpers that may no
  longer be used.
- Scan `c1-companion-services-plan.md` for cross-references
  to shipped/dropped phases.
- Cross-repo: `subgraph/`, `services/`, `data/tbtc-subgraph/`
  for off-chain consumers that may reference dropped events.

## Findings

### MUST-FIX — stale plan-doc claims that mislead readers

All four are in `docs/rfc/frost-migration/d2-ecdsa-hard-retirement-plan.md`
(the D-2.1 plan doc). After D-2.2 slice 1 (PR #447), several
claims in this doc are factually wrong about runtime behavior:

1. **L29-33** — "Bridge.retireEcdsa()`. Writes `self.ecdsaRetired = true`and emits`EcdsaRetired`. Idempotent (re-calls are warm SSTORE no-ops that re-emit the event)." D-2.2 dropped the `emit EcdsaRetired()`in`retireEcdsa()`to fit the public getter under EIP-170. The`re-emit the event` claim is wrong.

2. **L33-34** — "`event EcdsaRetired()` — declared on
   BridgeState (library) and mirrored on Bridge for ABI
   visibility." The mirror declaration on Bridge IS
   preserved (`Bridge.sol` still declares
   `event EcdsaRetired();` for ABI back-compat). D-2.2
   dropped only the `emit EcdsaRetired()` in `retireEcdsa()`;
   the event therefore stays in the Bridge ABI but never
   fires. Reconciliation should clarify "declaration
   preserved, emit dropped" rather than implying the mirror
   was removed.

3. **L43-49** — "Public `Bridge.ecdsaRetired()` getter.
   Adding it pushed the Bridge implementation back over
   EIP-170. Off-chain consumers observe the transition via
   the `EcdsaRetired` event." D-2.2 slice 1 SHIPPED the
   getter (PR #447) AND dropped the event. Both halves of
   this bullet are now wrong.

4. **L140-149** — activation runbook step 6 says calling
   `retireEcdsa()` "emit `EcdsaRetired`" and parenthetically
   "no public getter — see §'What this PR did NOT ship'".
   Both stale post-D-2.2.

**Recommended fix**: single PR adding a "**Updated post-D-2.2:**"
callout block at the top of each affected section, or a
single banner at the doc top with pointers to the four
spots. Per the pattern already used in `scheme-preference-and-retirement-rfc.md`'s
v7 superseded markers — preserve original text as historical
record, add reconciliation notes inline.

### NICE-TO-HAVE — minor cosmetic / non-blocking

5. **`c1-companion-services-plan.md` L226** — out-of-scope
   list says C-1 defers "D-1 / D-2 retirement events
   (`EcdsaRetired`, `EcdsaFinalized` or similar)". Two
   accuracy issues:

   - `EcdsaRetired` shipped its event declaration in D-2.1
     but D-2.2 dropped the emit; the event no longer fires.
   - `EcdsaFinalized` never shipped (it would have been
     emitted by the v6 `finalizeEcdsaRetirement` which was
     dropped entirely; see v7 RFC reconciliation).
     Doc was written before the v7 architecture stabilized.
     Single-line clarification: "the C-1 indexer is not
     responsible for these events; D-1 ships only the storage
     flag, D-2 ships the optional retireEcdsa() audit-trail
     marker (no event post-D-2.2; query `Bridge.ecdsaRetired()`
     view instead). `EcdsaFinalized` was dropped from the
     shipped design."

6. **Review-trace comments throughout shipped contracts** —
   10 occurrences of `Codex P1`/`Codex P2`/`Codex P3` and 1
   `Gemini PR-#441 review optimization` across
   `frost-registry/` and `bridge/` source. These explain
   WHY specific design choices were made (load-bearing for
   maintenance) but bind the documentation to a specific
   review process. External auditors may find them
   informative ("see, the team was thorough") or noisy
   ("who is Codex?"). Reasonable to either:
   - Leave as-is (small annotations explaining design rationale).
   - Strip review-tool names but keep the rationale text
     ("Codex P1 review on PR #443" → "(load-bearing fix; see
     PR #443 review)").
     No blocker either way; flag for the team's preference.

### INTENTIONAL — verified, not findings

The following appear like potential drift but are correctly
deferred per the D-2.2 plan or intentional historical
markers:

- `currentNewWalletScheme` enum + scheme-dispatch branch in
  `Wallets.requestNewWallet` — present but always-reverts
  on Ecdsa; D-2.2 slice 3 will clean up (deferred on
  governance-commit prerequisite). Plan doc accurate.
- `__ecdsaWalletHeartbeatFailedCallback` preserved as
  standalone external — drain-dependent removal in D-2.2
  slice 4. Plan doc accurate.
- `BridgeState.Storage.ecdsaWalletCount` (uint128) — added
  in C-2.1a; the companion `seedEcdsaWalletCount` setter
  was deferred indefinitely per v7 RFC §"C-2 implementation
  deltas". Storage layout test comment (`BridgeStorageLayout.test.ts`
  L232-236) accurately describes the deferral.
- `BridgeStub.__ecdsaWalletCreatedCallbackForTest` +
  `setEcdsaRetiredForTest` — test-only helpers, still
  actively used by the D-1/D-2 test suite.
- `FrostDkg.sol` L20 "offchainDkgTimeout was removed" — a
  historical annotation of the ECDSA→FROST port. Accurate.
- No subgraph / services / data/tbtc-subgraph references to
  `EcdsaRetired` or `finalizeEcdsaRetirement` — off-chain
  consumers don't depend on the dropped surface. D-2.2's
  emit-drop has zero off-chain blast radius.

## Recommended PR plan

### 2026-05-27 addendum

Follow-up review of the canonical PR #971 mirror found additional
audit-readiness items not covered by the original 2026-05-25 sweep:

1. **BridgeLifecycleRouter implementation missing from canonical
   mirror.** PR #971 ships Bridge-side hooks and
   `IBridgeLifecycleRouter`, but no deployable router contract. This
   is resolved at the planning layer by
   [`bridge-lifecycle-router-followup-plan.md`](./bridge-lifecycle-router-followup-plan.md).
   External audit kickoff should treat that router plan as in-scope
   and should not assume FROST wallet creation can be activated before
   the router follow-up lands.

2. **Storage-layout documentation drift.** The pinned snapshot places
   `frostWalletRegistry` at slot 32, `lifecycleRouter` at slot 35,
   and the packed `currentNewWalletScheme` / `ecdsaWalletCount` /
   `ecdsaRetired` fields at slot 37. Older plan text and inline
   comments claimed slots 33/36/38 and referred to the dropped
   `ecdsaWalletCountSeeded` flag. The canonical comments and
   `wallet-lifecycle-migration-plan.md` must match
   `Bridge.storage-layout.json`.

3. **ECDSA fraud unit coverage gap.** The deleted legacy
   `Bridge.Frauds.test.ts` suite left the extracted
   `EcdsaFraudRouter` without comparable unit coverage. The canonical
   follow-up adds `EcdsaFraudRouter.test.ts`, including submit,
   duplicate, defeat, timeout, FROST-wallet rejection, and
   reverting-challenger refund self-grief coverage.

4. **D-2.2 slice 2 drain enforcement.** The plan now distinguishes the
   on-chain unresolved-challenge check
   (`EcdsaFraudRouter.openFraudChallengeCount() == 0`) from the
   runbook-only wallet-state drain proof. Because Bridge registered
   wallets are mapping-backed, enumerating all challengeable ECDSA
   wallets remains an off-chain/subgraph governance proof unless the
   slice 2 implementation adds a separate index or freeze mode.

If shipping cleanup PRs:

1. **Single PR for findings #1-#4** (`d2-ecdsa-hard-retirement-plan.md`
   post-D-2.2 reconciliation). Self-contained, doc-only,
   ~30-40 line diff. High value — without this, an auditor
   reading the D-2.1 plan doc would believe behaviors that
   no longer exist.

2. **Optional separate PR for finding #5**
   (`c1-companion-services-plan.md` clarification on the
   event story). Single-line edit. Low value — the C-1
   indexer is already shipped + working; the misclaim only
   affects future readers trying to understand event
   contracts.

3. **Defer finding #6** (review-trace comments) pending team
   preference. Could be a 30-second sed pass before audit
   delivery or left as-is.

## Audit-readiness summary

The merged FROST migration is in good shape. Findings are
all documentation drift rather than code bugs — the shipped
contracts are internally consistent (verified by tests),
self-documenting via NatSpec, and structurally hardened
against the failure modes Codex reviewed. The drift comes
from the rapid iteration of plan docs through multiple
review rounds where v6-vs-shipped reconciliation was
applied in batches; #447's D-2.2 slice 1 added a final
small drift to `d2-ecdsa-hard-retirement-plan.md` that
this audit-prep sweep caught.

After PR-ing finding #1 (the d2-plan reconciliation),
recommend external audit kickoff.
