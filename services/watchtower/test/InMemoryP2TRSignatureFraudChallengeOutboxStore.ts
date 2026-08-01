/**
 * Shared in-memory `P2TRSignatureFraudChallengeOutboxStore` test double.
 *
 * The dispatcher unit tests and the PostgreSQL adapter parity tests both bind
 * to this class so a divergence between the process-local double and the
 * durable adapter is caught by an executable test instead of only in
 * production.
 */
import {
  Hex,
  inspectP2TRSignatureFraudPreparedTransactionEnvelope,
  recoverP2TRSignatureFraudSignedTransactionEnvelope,
} from "@keep-network/tbtc-v2.ts"

import {
  P2TRSignatureFraudAmbiguousNonceReleaseInvocation,
  P2TRSignatureFraudCanonicalProvenanceBinding,
  P2TRSignatureFraudCanonicalProvenanceInvalidationEvidence,
  P2TRSignatureFraudChallengeOutboxEligibilitySnapshot,
  P2TRSignatureFraudChallengeOutboxPage,
  P2TRSignatureFraudChallengeOutboxPageRequest,
  P2TRSignatureFraudChallengeOutboxRecord,
  P2TRSignatureFraudChallengeOutboxStore,
  P2TRSignatureFraudIndependentNonceReleaseResolution,
  P2TRSignatureFraudIndependentSignerBoundaryResolution,
  P2TRSignatureFraudNormalizedSignerBoundaryResolution,
  P2TRSignatureFraudLegacySubmissionQuarantine,
  P2TRSignatureFraudNonceReleaseAttempt,
  P2TRSignatureFraudNonceReleaseAttemptResult,
  P2TRSignatureFraudNonceReleasePage,
  P2TRSignatureFraudNonceReleasePageRequest,
  P2TRSignatureFraudNonceReleaseRequest,
  P2TRSignatureFraudOutboxCriticalAlert,
  P2TRSignatureFraudSignerQuarantine,
  computeP2TRSignatureFraudNonceReleaseRequestID,
  computeP2TRSignatureFraudNonceReleaseResolutionEvidenceDigest,
  assertP2TRSignatureFraudOrphanedSignerBoundaryOwnership,
  validateP2TRSignatureFraudIndependentSignerBoundaryResolution,
} from "../src/P2TRSignatureFraudChallengeOutbox.js"

/** Mirrors the PostgreSQL adapter's tolerance for an unprefixed `Hex` render. */
const prefixedReservationID = (value: string): string =>
  normalizeKey(value.startsWith("0x") ? value : `0x${value}`)

/**
 * Stable identity for a signer quarantine. The PostgreSQL adapter hashes the
 * whole structure; the double only needs the same equivalence classes.
 */
const signerQuarantineIdentity = (
  quarantine: P2TRSignatureFraudSignerQuarantine
): string =>
  JSON.stringify(
    Object.keys(quarantine)
      .sort()
      .map((name) => [
        name,
        (quarantine as unknown as Record<string, unknown>)[name],
      ])
  )

export const normalizeKey = (value: Hex | string): string =>
  value instanceof Hex
    ? value.toPrefixedString().toLowerCase()
    : value.toLowerCase()

const nonceLaneKey = (chainID: number, sender: string): string =>
  `${chainID}:${sender.toLowerCase()}`

const hexByteLength = (value: Hex | string): number => {
  const rendered =
    value instanceof Hex ? value.toPrefixedString() : value.toLowerCase()
  return (rendered.startsWith("0x") ? rendered.length - 2 : rendered.length) / 2
}

export const normalizeOwner = (value: string): string => {
  const normalized = value.trim()
  if (
    normalized.length === 0 ||
    normalized.length > 128 ||
    !/^[\x21-\x7e](?:[\x20-\x7e]{0,126}[\x21-\x7e])?$/.test(normalized)
  ) {
    throw new Error("nonce-release owner is invalid")
  }
  return normalized
}

export class InMemoryOutboxStore
  implements P2TRSignatureFraudChallengeOutboxStore
{
  constructor(
    private readonly assertIndependentSignerBoundaryResolution: (
      record: P2TRSignatureFraudChallengeOutboxRecord,
      resolution: P2TRSignatureFraudNormalizedSignerBoundaryResolution
    ) => true | Promise<true> = () => true
  ) {}

  readonly p2trSignatureFraudWatchtowerStoreProfile =
    "transactional-production" as const
  readonly p2trSignatureFraudWatchtowerTransactionalStoreID = "outbox.test"
  readonly records = new Map<string, P2TRSignatureFraudChallengeOutboxRecord>()
  readonly quarantines: P2TRSignatureFraudLegacySubmissionQuarantine[] = []
  readonly criticalAlerts: P2TRSignatureFraudOutboxCriticalAlert[] = []
  /** Append-only retirement evidence, mirroring the PostgreSQL table. */
  readonly retiredProvenanceIncidents: {
    recordID: string
    boundaryStartedAtUnixMs: number
    preparationAttempts: number
    nonceReservationID: string
    resolvedAtUnixMs: number
  }[] = []
  readonly nonceReleaseRequests = new Map<
    string,
    P2TRSignatureFraudNonceReleaseRequest
  >()
  readonly nonceReleaseAttempts = new Map<
    string,
    P2TRSignatureFraudNonceReleaseAttempt[]
  >()
  readonly nonceReleaseResults = new Map<
    string,
    Map<number, "acknowledged" | "ambiguous">
  >()
  readonly nonceReleaseInvocations = new Set<string>()
  readonly nonceReleaseInvocationTimes = new Map<string, number>()
  readonly nonceReleaseAmbiguousResponseDigests = new Map<string, string>()
  readonly unsafeNonceReleaseInvocations = new Set<string>()
  readonly nonceReleaseResolutions = new Map<
    string,
    "released" | "already-released" | "terminal-unsafe"
  >()
  /** Append-only orphaned-boundary evidence, mirroring the PostgreSQL table. */
  readonly signerBoundaryResolutions = new Map<
    string,
    {
      outcome: "never-invoked" | "signed" | "terminal-unsafe"
      evidenceDigest: string
      signedTransactionHash?: string
      providerTombstone?: {
        invocationID: string
        tombstonedAtUnixMs: number
        receiptDigest: string
      }
      resolvedAtUnixMs: number
    }
  >()
  readonly nonceReleaseContractMismatchBlockedLanes = new Set<string>()
  eligibilitySnapshot?: P2TRSignatureFraudChallengeOutboxEligibilitySnapshot
  readonly invalidatedProvenanceFingerprints = new Set<string>()
  beforeProvenanceCAS?: (
    current: P2TRSignatureFraudChallengeOutboxRecord,
    next: P2TRSignatureFraudChallengeOutboxRecord
  ) => Promise<void>

  assertExternalIOTransactionBoundary(): void {}

  async insertGenerationIfAbsent(
    record: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    const key = normalizeKey(record.recordID)
    const existing = this.records.get(key)
    if (existing !== undefined) return existing
    for (const durable of this.records.values()) {
      if (
        normalizeKey(durable.seriesID) === normalizeKey(record.seriesID) &&
        durable.generation === record.generation
      ) {
        return durable
      }
    }
    if (this.hasLaneConflict(key, record)) {
      throw new Error("sender lane conflict")
    }
    this.records.set(key, record)
    return record
  }

  async get(
    recordID: string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord | undefined> {
    return this.records.get(normalizeKey(recordID))
  }

  async getLatest(
    seriesID: string
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord | undefined> {
    return [...this.records.values()]
      .filter(
        (record) => normalizeKey(record.seriesID) === normalizeKey(seriesID)
      )
      .sort((left, right) => right.generation - left.generation)[0]
  }

  async isSignerQuarantined(
    chainID: number,
    signerIdentity: string
  ): Promise<boolean> {
    return [...this.records.values()].some(
      (record) =>
        record.intent.chainID === chainID &&
        (record.signerQuarantines ?? []).some(
          (quarantine) => quarantine.signerIdentity === signerIdentity
        )
    )
  }

  async hasExpiredPreparationLeases(nowUnixMs: number): Promise<boolean> {
    return [...this.records.values()].some(
      (record) =>
        record.status === "preparing" &&
        record.preparationLease !== undefined &&
        record.preparationLease.expiresAtUnixMs <= nowUnixMs
    )
  }

  async hasPendingNonceReleases(): Promise<boolean> {
    return [...this.nonceReleaseRequests.keys()].some(
      (id) => !this.releaseAcknowledged(id)
    )
  }

  async hasExpiredPreparationLeasesForLane(
    chainID: number,
    sender: string,
    nowUnixMs: number
  ): Promise<boolean> {
    const lane = nonceLaneKey(chainID, sender)
    return [...this.records.values()].some(
      (record) =>
        record.status === "preparing" &&
        record.preparationLease !== undefined &&
        record.preparationLease.expiresAtUnixMs <= nowUnixMs &&
        record.preparationSender !== undefined &&
        nonceLaneKey(record.intent.chainID, record.preparationSender) === lane
    )
  }

  async hasPendingNonceReleasesForLane(
    chainID: number,
    sender: string
  ): Promise<boolean> {
    const lane = nonceLaneKey(chainID, sender)
    return [...this.nonceReleaseRequests.entries()].some(
      ([id, request]) =>
        !this.releaseAcknowledged(id) &&
        this.nonceReleaseLaneKey(request) === lane
    )
  }

  async getNonceReleaseRequest(
    releaseRequestID: string
  ): Promise<P2TRSignatureFraudNonceReleaseRequest | undefined> {
    return this.currentReleaseRequest(normalizeKey(releaseRequestID))
  }

  async listPendingNonceReleases(
    request: P2TRSignatureFraudNonceReleasePageRequest
  ): Promise<P2TRSignatureFraudNonceReleasePage> {
    const pending = [...this.nonceReleaseRequests.keys()]
      .filter((id) => !this.releaseAcknowledged(id))
      .sort()
      .filter(
        (id) =>
          request.cursor === undefined || id > normalizeKey(request.cursor)
      )
    const ids = pending.slice(0, request.limit)
    return {
      requests: ids.map((id) => this.currentReleaseRequest(id)!),
      nextCursor:
        pending.length > request.limit ? ids[ids.length - 1] : undefined,
    }
  }

  async getActiveAmbiguousNonceReleaseInvocation(
    nowUnixMs: number
  ): Promise<P2TRSignatureFraudAmbiguousNonceReleaseInvocation | undefined> {
    const candidates: P2TRSignatureFraudAmbiguousNonceReleaseInvocation[] = []
    for (const [id] of this.nonceReleaseRequests) {
      const attempts = this.nonceReleaseAttempts.get(id) ?? []
      const attempt = attempts[attempts.length - 1]
      if (attempt === undefined) continue
      const key = `${id}:${attempt.attemptSequence}`
      const invokedAtUnixMs = this.nonceReleaseInvocationTimes.get(key)
      if (
        invokedAtUnixMs === undefined ||
        this.nonceReleaseResolutions.has(key) ||
        this.releaseAcknowledged(id)
      ) {
        continue
      }
      const result = this.nonceReleaseResults
        .get(id)
        ?.get(attempt.attemptSequence)
      const ambiguousError = this.unsafeNonceReleaseInvocations.has(key)
      if (
        (result === undefined && attempt.expiresAtUnixMs > nowUnixMs) ||
        (result !== undefined && !ambiguousError)
      ) {
        continue
      }
      const request = this.currentReleaseRequest(id)
      if (request === undefined) {
        throw new Error("active nonce-release invocation lacks its request")
      }
      candidates.push({
        request,
        attempt,
        invokedAtUnixMs,
        ambiguousResponseDigest:
          this.nonceReleaseAmbiguousResponseDigests.get(key),
      })
    }
    return candidates.sort((left, right) =>
      left.request.releaseRequestID.localeCompare(
        right.request.releaseRequestID
      )
    )[0]
  }

  async claimNonceReleaseAttempt(
    releaseRequestID: string,
    owner: string,
    startedAtUnixMs: number,
    expiresAtUnixMs: number
  ): Promise<P2TRSignatureFraudNonceReleaseAttempt | undefined> {
    const id = normalizeKey(releaseRequestID)
    const normalizedOwner = normalizeOwner(owner)
    const request = this.nonceReleaseRequests.get(id)
    if (
      request === undefined ||
      this.nonceReleaseContractMismatchBlockedLanes.has(
        this.nonceReleaseLaneKey(request) ?? ""
      ) ||
      this.releaseAcknowledged(id)
    ) {
      return undefined
    }
    const attempts = this.nonceReleaseAttempts.get(id) ?? []
    const latest = attempts[attempts.length - 1]
    if (latest !== undefined) {
      const completed = this.nonceReleaseResults
        .get(id)
        ?.has(latest.attemptSequence)
      if (
        !completed &&
        (this.nonceReleaseInvocations.has(`${id}:${latest.attemptSequence}`) ||
          latest.expiresAtUnixMs > startedAtUnixMs)
      ) {
        if (
          !this.nonceReleaseInvocations.has(
            `${id}:${latest.attemptSequence}`
          ) &&
          latest.owner === normalizedOwner
        ) {
          return latest
        }
        return undefined
      }
      if (
        this.unsafeNonceReleaseInvocations.has(
          `${id}:${latest.attemptSequence}`
        )
      ) {
        return undefined
      }
    }
    const attempt = {
      releaseRequestID: id,
      attemptSequence: attempts.length + 1,
      owner: normalizedOwner,
      startedAtUnixMs,
      expiresAtUnixMs,
    }
    this.nonceReleaseAttempts.set(id, [...attempts, attempt])
    return attempt
  }

  async beginNonceReleaseAttempt(
    attempt: P2TRSignatureFraudNonceReleaseAttempt,
    invokedAtUnixMs: number
  ): Promise<boolean> {
    const id = normalizeKey(attempt.releaseRequestID)
    const attempts = this.nonceReleaseAttempts.get(id) ?? []
    const latest = attempts[attempts.length - 1]
    const key = `${id}:${attempt.attemptSequence}`
    const attemptOwner = normalizeOwner(attempt.owner)
    const request = this.nonceReleaseRequests.get(id)
    const lane =
      request === undefined
        ? undefined
        : this.nonceReleaseLaneKey(request)
    const laneHasActiveSigner =
      lane !== undefined &&
      [...this.records.values()].some(
        (record) =>
          record.activeSignerInvocationStartedAtUnixMs !== undefined &&
          record.preparationSender !== undefined &&
          nonceLaneKey(record.intent.chainID, record.preparationSender) === lane
      )
    const laneHasActiveRelease =
      lane !== undefined &&
      [...this.nonceReleaseInvocations].some((invocationKey) => {
        const [releaseID] = invocationKey.split(":")
        const activeRequest = this.nonceReleaseRequests.get(releaseID)
        return (
          activeRequest !== undefined &&
          !this.releaseAcknowledged(releaseID) &&
          this.nonceReleaseLaneKey(activeRequest) === lane
        )
      })
    if (
      request === undefined ||
      laneHasActiveSigner ||
      laneHasActiveRelease ||
      latest === undefined ||
      latest.attemptSequence !== attempt.attemptSequence ||
      latest.owner !== attemptOwner ||
      latest.startedAtUnixMs !== attempt.startedAtUnixMs ||
      latest.expiresAtUnixMs !== attempt.expiresAtUnixMs ||
      invokedAtUnixMs < attempt.startedAtUnixMs ||
      invokedAtUnixMs > attempt.expiresAtUnixMs ||
      this.nonceReleaseResults.get(id)?.has(attempt.attemptSequence) ||
      this.nonceReleaseInvocations.has(key)
    ) {
      return false
    }
    this.nonceReleaseInvocations.add(key)
    this.nonceReleaseInvocationTimes.set(key, invokedAtUnixMs)
    return true
  }

  async recordNonceReleaseAttemptResult(
    attempt: P2TRSignatureFraudNonceReleaseAttempt,
    result: P2TRSignatureFraudNonceReleaseAttemptResult
  ): Promise<"acknowledged" | "ambiguous"> {
    const id = normalizeKey(attempt.releaseRequestID)
    const attemptOwner = normalizeOwner(attempt.owner)
    const attempts = this.nonceReleaseAttempts.get(id) ?? []
    const durable = attempts.find(
      (candidate) => candidate.attemptSequence === attempt.attemptSequence
    )
    if (
      durable === undefined ||
      durable.owner !== attemptOwner ||
      durable.startedAtUnixMs !== attempt.startedAtUnixMs ||
      durable.expiresAtUnixMs !== attempt.expiresAtUnixMs
    ) {
      throw new Error("nonce-release attempt token mismatch")
    }
    const currentAndOnTime =
      attempts[attempts.length - 1].attemptSequence ===
        attempt.attemptSequence &&
      this.nonceReleaseInvocations.has(`${id}:${attempt.attemptSequence}`) &&
      result.recordedAtUnixMs >= attempt.startedAtUnixMs &&
      result.recordedAtUnixMs <= attempt.expiresAtUnixMs
    const acknowledged =
      (result.kind === "released" || result.kind === "already-released") &&
      currentAndOnTime
    const results = this.nonceReleaseResults.get(id) ?? new Map()
    if (!results.has(attempt.attemptSequence)) {
      results.set(
        attempt.attemptSequence,
        acknowledged ? "acknowledged" : "ambiguous"
      )
      this.nonceReleaseResults.set(id, results)
      if (
        result.kind === "ambiguous-error" &&
        this.nonceReleaseInvocations.has(`${id}:${attempt.attemptSequence}`)
      ) {
        this.unsafeNonceReleaseInvocations.add(
          `${id}:${attempt.attemptSequence}`
        )
        this.nonceReleaseAmbiguousResponseDigests.set(
          `${id}:${attempt.attemptSequence}`,
          normalizeKey(result.responseDigest)
        )
      }
    }
    if (result.kind === "contract-mismatch") {
      const request = this.nonceReleaseRequests.get(id)
      const lane =
        request === undefined ? undefined : this.nonceReleaseLaneKey(request)
      if (lane !== undefined) {
        this.nonceReleaseContractMismatchBlockedLanes.add(lane)
      }
      const record =
        request === undefined
          ? undefined
          : this.records.get(normalizeKey(request.recordID))
      if (request !== undefined && record !== undefined) {
        const quarantine: P2TRSignatureFraudSignerQuarantine = {
          laneID: request.reservation.laneID,
          signerIdentity: request.reservation.signerIdentity,
          expectedSender: request.reservation.sender,
          reasonCode: "reservation-provider-failure",
          quarantinedAtUnixMs: result.recordedAtUnixMs,
          reason: result.detail,
          detailsDigest: result.responseDigest,
        }
        this.records.set(normalizeKey(record.recordID), {
          ...record,
          signerQuarantines: [...(record.signerQuarantines ?? []), quarantine],
        })
        if (
          !this.criticalAlerts.some(
            (alert) =>
              alert.recordID === record.recordID &&
              alert.generation === record.generation &&
              alert.code === "reservation-release-failed"
          )
        ) {
          this.criticalAlerts.push({
            code: "reservation-release-failed",
            seriesID: record.seriesID,
            recordID: record.recordID,
            generation: record.generation,
            activationBlocking: true,
            createdAtUnixMs: result.recordedAtUnixMs,
            detail: result.detail,
          })
        }
      }
    }
    return results.get(attempt.attemptSequence)!
  }

  async resolveAmbiguousNonceRelease(
    resolution: P2TRSignatureFraudIndependentNonceReleaseResolution
  ): Promise<"acknowledged" | "unsafe"> {
    const id = normalizeKey(resolution.releaseRequestID)
    const key = `${id}:${resolution.attemptSequence}`
    const attemptOwner = normalizeOwner(resolution.attemptOwner)
    const attempt = (this.nonceReleaseAttempts.get(id) ?? []).find(
      (candidate) => candidate.attemptSequence === resolution.attemptSequence
    )
    if (
      attempt === undefined ||
      !this.nonceReleaseInvocations.has(key) ||
      attempt.owner !== attemptOwner ||
      attempt.startedAtUnixMs !== resolution.attemptStartedAtUnixMs ||
      attempt.expiresAtUnixMs !== resolution.attemptExpiresAtUnixMs ||
      computeP2TRSignatureFraudNonceReleaseResolutionEvidenceDigest({
        releaseRequestID: id,
        attemptSequence: resolution.attemptSequence,
        attemptOwner,
        attemptStartedAtUnixMs: resolution.attemptStartedAtUnixMs,
        attemptExpiresAtUnixMs: resolution.attemptExpiresAtUnixMs,
        invokedAtUnixMs: resolution.invokedAtUnixMs,
        outcome: resolution.outcome,
        providerEvidenceDigest: resolution.providerEvidenceDigest,
      }) !== normalizeKey(resolution.evidenceDigest) ||
      this.nonceReleaseInvocationTimes.get(key) !==
        resolution.invokedAtUnixMs ||
      resolution.canonicalAttestations.length !== 2 ||
      resolution.canonicalAttestations[0].trustDomainID ===
        resolution.canonicalAttestations[1].trustDomainID ||
      resolution.canonicalAttestations[0].independenceDomainID ===
        resolution.canonicalAttestations[1].independenceDomainID ||
      resolution.canonicalAttestations.some(
        (attestation) =>
          normalizeKey(attestation.evidenceDigest) !==
          normalizeKey(resolution.evidenceDigest)
      )
    ) {
      throw new Error("independent nonce-release resolution is invalid")
    }
    const existing = this.nonceReleaseResolutions.get(key)
    if (existing !== undefined && existing !== resolution.outcome) {
      throw new Error("independent nonce-release resolution conflicts")
    }
    this.nonceReleaseResolutions.set(key, resolution.outcome)
    if (resolution.outcome === "terminal-unsafe") {
      const request = this.nonceReleaseRequests.get(id)
      const lane =
        request === undefined ? undefined : this.nonceReleaseLaneKey(request)
      if (lane !== undefined) {
        this.nonceReleaseContractMismatchBlockedLanes.add(lane)
      }
      return "unsafe"
    }
    return "acknowledged"
  }

  /**
   * Mirrors `PostgresP2TRSignatureFraudChallengeOutboxStore`'s orphaned-boundary
   * resolver. Both stores share one validator and one durable-state predicate,
   * so their rejection messages are identical rather than merely similar, and
   * both perform exactly the same effects for each outcome.
   */
  async resolveOrphanedSignerBoundary(
    resolution: P2TRSignatureFraudIndependentSignerBoundaryResolution
  ): Promise<"acknowledged" | "unsafe"> {
    const normalized =
      validateP2TRSignatureFraudIndependentSignerBoundaryResolution(resolution)
    const current = this.records.get(normalizeKey(normalized.recordID))
    if (current === undefined) {
      throw new Error(
        "Orphaned signer boundary resolution names an absent outbox record"
      )
    }
    const key = [
      normalizeKey(normalized.recordID),
      normalized.boundaryStartedAtUnixMs,
      normalized.preparationAttempts,
      normalized.nonceReservationID,
    ].join(":")
    const existing = this.signerBoundaryResolutions.get(key)
    if (existing !== undefined) {
      if (
        existing.outcome !== normalized.outcome ||
        existing.evidenceDigest !== normalized.evidenceDigest
      ) {
        throw new Error("Independent signer-boundary resolution conflicts")
      }
      return normalized.outcome === "terminal-unsafe"
        ? "unsafe"
        : "acknowledged"
    }
    assertP2TRSignatureFraudOrphanedSignerBoundaryOwnership(current, normalized)
    if (
      (await this.assertIndependentSignerBoundaryResolution(
        current,
        normalized
      )) !== true
    ) {
      throw new Error(
        "Independent signer-boundary resolution authentication failed"
      )
    }
    // The adapter's evidence insert and its effects share one transaction, so
    // this double must never retain evidence for effects that did not land.
    const appendEvidence = (): void => {
      this.signerBoundaryResolutions.set(key, {
        outcome: normalized.outcome,
        evidenceDigest: normalized.evidenceDigest,
        signedTransactionHash: normalized.signedTransactionHash,
        providerTombstone: normalized.providerTombstone,
        resolvedAtUnixMs: normalized.resolvedAtUnixMs,
      })
    }
    if (normalized.outcome === "never-invoked") {
      const cleared: P2TRSignatureFraudChallengeOutboxRecord = {
        ...current,
        version: current.version + 1,
        activeSignerInvocationStartedAtUnixMs: undefined,
        updatedAtUnixMs: Math.max(
          current.updatedAtUnixMs,
          normalized.resolvedAtUnixMs
        ),
        lastError:
          "Independent attestation proved the orphaned signer boundary never reached the signer",
      }
      if (
        !(await this.compareAndSwapRetiringUninvokedSignerBoundary(
          normalized.recordID,
          current.version,
          cleared,
          {
            startedAtUnixMs: normalized.boundaryStartedAtUnixMs,
            preparationAttempts: normalized.preparationAttempts,
            nonceReservationID: normalized.nonceReservationID,
          },
          normalized.resolvedAtUnixMs
        ))
      ) {
        throw new Error(
          "Orphaned signer boundary resolution lost its barrier-clearing swap"
        )
      }
      appendEvidence()
      return "acknowledged"
    }
    if (normalized.outcome === "terminal-unsafe") {
      appendEvidence()
      await this.saveCriticalAlert({
        code: "signer-boundary-terminal-unsafe",
        seriesID: current.seriesID,
        recordID: current.recordID,
        generation: current.generation,
        activationBlocking: true,
        createdAtUnixMs: normalized.resolvedAtUnixMs,
        detail:
          "Independent reconciliation proved a terminal unsafe orphaned signer boundary outcome",
      })
      return "unsafe"
    }
    // `signed` deliberately retains the boundary: it is what still authorizes
    // `captureEscapedSignedArtifact` to quarantine the escaped bytes.
    appendEvidence()
    return "acknowledged"
  }

  async compareAndSwap(
    recordID: string,
    expectedVersion: number,
    next: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<boolean> {
    const key = normalizeKey(recordID)
    const current = this.records.get(key)
    if (
      current === undefined ||
      current.version !== expectedVersion ||
      next.version !== expectedVersion + 1 ||
      normalizeKey(next.recordID) !== key ||
      this.hasLaneConflict(key, next) ||
      !this.preservesSignedVariantIdentities(current, next)
    ) {
      return false
    }
    for (const transaction of [
      next.preparedTransaction,
      ...(next.preparedTransactionVariants ?? []).map(
        (variant) => variant.preparedTransaction
      ),
      ...(next.unexpectedSignedArtifacts ?? []).map(
        (artifact) => artifact.preparedTransaction
      ),
    ]) {
      if (
        transaction !== undefined &&
        hexByteLength(transaction.rawTransaction) > 4_096
      ) {
        throw new Error("Signed Ethereum transaction exceeds the durable bound")
      }
    }
    this.records.set(key, next)
    this.syncNonceReleaseRequests(current, next)
    const priorQuarantines = current.signerQuarantines ?? []
    const addedQuarantine = (next.signerQuarantines ?? []).find(
      (candidate) =>
        !priorQuarantines.some(
          (prior) =>
            prior.detailsDigest === candidate.detailsDigest &&
            prior.quarantinedAtUnixMs === candidate.quarantinedAtUnixMs
        ) &&
        candidate.reservationID !== undefined &&
        candidate.reasonCode !== "reservation-binding-mismatch" &&
        candidate.reasonCode !== "reservation-provider-failure"
    )
    if (addedQuarantine !== undefined) {
      await this.saveCriticalAlert({
        code: "signed-state-quarantined",
        seriesID: next.seriesID,
        recordID: next.recordID,
        generation: next.generation,
        activationBlocking: true,
        createdAtUnixMs: addedQuarantine.quarantinedAtUnixMs,
        detail: addedQuarantine.reason,
      })
    }
    return true
  }

  /**
   * Mirrors the PostgreSQL adapter: the swap that clears the boundary marker
   * and the retirement of the incidents raised over that exact boundary happen
   * together, and retirement is refused outright when the durable record
   * carries any signer escape evidence.
   */
  async compareAndSwapRetiringUninvokedSignerBoundary(
    recordID: string,
    expectedVersion: number,
    next: P2TRSignatureFraudChallengeOutboxRecord,
    boundary: {
      startedAtUnixMs: number
      preparationAttempts: number
      nonceReservationID: string
    },
    resolvedAtUnixMs: number
  ): Promise<boolean> {
    const key = normalizeKey(recordID)
    const durable = this.records.get(key)
    if (durable === undefined) return false
    // The same predicate the database trigger enforces. A caller must never be
    // able to retire an incident for a boundary that may have escaped.
    if (
      durable.signerInvocationStartedAtUnixMs !== undefined ||
      (durable.preparedTransactionVariants?.length ?? 0) > 0 ||
      (durable.unexpectedSignedArtifacts?.length ?? 0) > 0 ||
      durable.broadcastAttempts > 0
    ) {
      throw new Error(
        "provenance incident resolution requires a boundary with no signer escape evidence"
      )
    }
    if (
      durable.activeSignerInvocationStartedAtUnixMs !==
        boundary.startedAtUnixMs ||
      durable.preparationAttempts !== boundary.preparationAttempts ||
      durable.reservedNonce === undefined ||
      prefixedReservationID(durable.reservedNonce.reservationID.toString()) !==
        prefixedReservationID(boundary.nonceReservationID)
    ) {
      throw new Error(
        "provenance incident resolution does not name the durable boundary"
      )
    }
    if (!(await this.compareAndSwap(recordID, expectedVersion, next))) {
      return false
    }
    this.retiredProvenanceIncidents.push({
      recordID: next.recordID,
      boundaryStartedAtUnixMs: boundary.startedAtUnixMs,
      preparationAttempts: boundary.preparationAttempts,
      nonceReservationID: boundary.nonceReservationID,
      resolvedAtUnixMs,
    })
    return true
  }

  async compareAndSwapWithCurrentCanonicalProvenance(
    recordID: string,
    expectedVersion: number,
    expectedProvenance: P2TRSignatureFraudCanonicalProvenanceBinding,
    next: P2TRSignatureFraudChallengeOutboxRecord
  ): Promise<boolean> {
    const current = await this.get(recordID)
    if (current !== undefined) {
      await this.beforeProvenanceCAS?.(current, next)
    }
    const durable = await this.get(recordID)
    const expectedFingerprint = normalizeKey(
      expectedProvenance.provenanceFingerprint
    )
    if (
      durable === undefined ||
      normalizeKey(durable.canonicalProvenance.provenanceFingerprint) !==
        expectedFingerprint ||
      this.invalidatedProvenanceFingerprints.has(expectedFingerprint)
    ) {
      return false
    }
    return this.compareAndSwap(recordID, expectedVersion, next)
  }

  /**
   * Mirrors `PostgresP2TRSignatureFraudChallengeOutboxStore`'s late-artifact
   * capture. The durable adapter rejects a capture that cannot name the exact
   * retained signer boundary and reservation, distinguishes an expected-lane
   * artifact from an escaped wrong-lane envelope, and emits its alerts only
   * for a first capture. A looser double would let the dispatcher tests pass
   * on transitions the database refuses, so every check below is deliberately
   * ordered and worded to match the adapter.
   */
  async captureEscapedSignedArtifact(
    recordID: string,
    expectedProvenanceFingerprint: string,
    artifact: NonNullable<
      P2TRSignatureFraudChallengeOutboxRecord["unexpectedSignedArtifacts"]
    >[number],
    signerQuarantine?: P2TRSignatureFraudSignerQuarantine
  ): Promise<P2TRSignatureFraudChallengeOutboxRecord> {
    const key = normalizeKey(recordID)
    const current = this.records.get(key)
    if (current === undefined) {
      throw new Error("Outbox record does not exist")
    }
    if (
      normalizeKey(current.canonicalProvenance.provenanceFingerprint) !==
      normalizeKey(expectedProvenanceFingerprint)
    ) {
      throw new Error("Escaped signed artifact provenance mismatch")
    }
    const reservation = current.reservedNonce
    if (
      reservation === undefined ||
      normalizeKey(reservation.reservationID) !==
        normalizeKey(artifact.expectedReservationID)
    ) {
      throw new Error(
        "Late signed artifact has no retained durable signer boundary"
      )
    }
    const recovered = recoverP2TRSignatureFraudSignedTransactionEnvelope(
      artifact.preparedTransaction.rawTransaction
    )
    if (
      normalizeKey(artifact.preparedTransaction.intentID) !==
        normalizeKey(current.intent.intentID) ||
      normalizeKey(artifact.preparedTransaction.transactionHash) !==
        normalizeKey(recovered.transactionHash) ||
      normalizeKey(artifact.preparedTransaction.sender) !==
        normalizeKey(recovered.sender) ||
      artifact.preparedTransaction.nonce !== recovered.nonce
    ) {
      throw new Error(
        "Unexpected signed artifact metadata does not match its raw envelope"
      )
    }
    const envelope = inspectP2TRSignatureFraudPreparedTransactionEnvelope(
      recovered.rawTransaction
    )
    const normalizedArtifact = {
      ...artifact,
      preparedTransaction: {
        intentID: current.intent.intentID,
        ...recovered,
        ...(envelope.transactionType === 2 ? { eip1559: envelope } : {}),
      },
    }
    if (
      typeof artifact.reason !== "string" ||
      artifact.reason.length === 0 ||
      artifact.reason.length > 1024
    ) {
      throw new Error(
        "Late artifact reason must contain between 1 and 1024 characters"
      )
    }
    const artifacts = current.unexpectedSignedArtifacts ?? []
    const capturedHash = normalizeKey(recovered.transactionHash)
    // The adapter's idempotency covers persisted variants as well as prior
    // late artifacts.
    const alreadyCaptured =
      artifacts.some(
        (existing) =>
          normalizeKey(existing.preparedTransaction.transactionHash) ===
          capturedHash
      ) ||
      (current.preparedTransactionVariants ?? []).some(
        (variant) =>
          normalizeKey(variant.preparedTransaction.transactionHash) ===
          capturedHash
      )
    if (
      alreadyCaptured &&
      current.activeSignerInvocationStartedAtUnixMs === undefined
    ) {
      return current
    }
    if (current.activeSignerInvocationStartedAtUnixMs === undefined) {
      throw new Error(
        "Late signed artifact has no retained durable signer boundary"
      )
    }
    const signedResolution = this.signerBoundaryResolutions.get(
      [
        key,
        current.activeSignerInvocationStartedAtUnixMs,
        current.preparationAttempts,
        normalizeKey(reservation.reservationID),
      ].join(":")
    )
    if (
      signedResolution?.outcome === "signed" &&
      normalizeKey(signedResolution.signedTransactionHash!) !== capturedHash
    ) {
      throw new Error(
        "Escaped signed artifact does not match the authenticated orphan resolution"
      )
    }
    const expectedLaneArtifact =
      recovered.chainID === current.intent.chainID &&
      normalizeKey(recovered.sender) === normalizeKey(reservation.sender) &&
      recovered.nonce === reservation.nonce
    const metadataOnlyCapture =
      hexByteLength(normalizedArtifact.preparedTransaction.calldata) > 4_096 ||
      hexByteLength(normalizedArtifact.preparedTransaction.rawTransaction) >
        4_096
    const priorQuarantines = current.signerQuarantines ?? []
    let addedQuarantine =
      signerQuarantine !== undefined &&
      !priorQuarantines.some(
        (existing) =>
          signerQuarantineIdentity(existing) ===
          signerQuarantineIdentity(signerQuarantine)
      )
        ? signerQuarantine
        : undefined
    if (
      metadataOnlyCapture &&
      addedQuarantine === undefined &&
      !priorQuarantines.some(
        (candidate) =>
          candidate.reservationID !== undefined &&
          normalizeKey(candidate.reservationID) ===
            normalizeKey(reservation.reservationID)
      )
    ) {
      addedQuarantine = {
        laneID: reservation.laneID,
        signerIdentity: reservation.signerIdentity,
        expectedSender: reservation.sender,
        expectedNonce: reservation.nonce,
        reservationID: prefixedReservationID(
          reservation.reservationID.toString()
        ),
        reasonCode: "oversized-signed-envelope",
        quarantinedAtUnixMs: artifact.capturedAtUnixMs,
        reason:
          "Signer returned a parseable envelope that exceeded the durable signed-transaction bound; only authenticated metadata was retained",
        detailsDigest: normalizeKey(recovered.transactionHash),
      }
    }
    const signerQuarantines =
      addedQuarantine === undefined
        ? current.signerQuarantines
        : [...priorQuarantines, addedQuarantine]
    if (
      !alreadyCaptured &&
      !expectedLaneArtifact &&
      ![...(signerQuarantines ?? [])]
        .reverse()
        .some(
          (candidate) =>
            candidate.reasonCode === "wrong-chain" ||
            candidate.reasonCode === "wrong-sender" ||
            candidate.reasonCode === "wrong-nonce" ||
            candidate.reasonCode === "ambiguous-signer-invocation"
        )
    ) {
      throw new Error(
        "Escaped wrong-lane envelope lacks signer quarantine evidence"
      )
    }
    const next = {
      ...current,
      version: current.version + 1,
      status:
        current.provenanceInvalidationEvidence !== undefined
          ? "provenance-invalidated-awaiting-reconciliation"
          : metadataOnlyCapture && current.preparationResumeStatus === undefined
          ? "quarantined"
          : metadataOnlyCapture
          ? current.preparationResumeStatus ?? current.status
          : current.status,
      preparationLease:
        current.provenanceInvalidationEvidence === undefined &&
        !metadataOnlyCapture
          ? current.preparationLease
          : undefined,
      preparationResumeStatus:
        current.provenanceInvalidationEvidence === undefined &&
        !metadataOnlyCapture
          ? current.preparationResumeStatus
          : undefined,
      activeSignerInvocationStartedAtUnixMs: undefined,
      signerInvocationStartedAtUnixMs:
        current.signerInvocationStartedAtUnixMs ??
        current.activeSignerInvocationStartedAtUnixMs,
      signerQuarantines,
      unexpectedSignedArtifacts:
        alreadyCaptured || metadataOnlyCapture
          ? artifacts
          : [...artifacts, normalizedArtifact],
      updatedAtUnixMs: Math.max(
        current.updatedAtUnixMs,
        artifact.capturedAtUnixMs
      ),
      lastError: metadataOnlyCapture
        ? "Signer returned an oversized signed envelope; authenticated metadata was retained and the signer lane was quarantined"
        : current.lastError,
    }
    this.records.set(key, next)
    if (
      !alreadyCaptured &&
      current.provenanceInvalidationEvidence !== undefined
    ) {
      await this.saveCriticalAlert({
        code: "provenance-reconciliation-incident",
        seriesID: next.seriesID,
        recordID: next.recordID,
        generation: next.generation,
        activationBlocking: true,
        createdAtUnixMs: artifact.capturedAtUnixMs,
        detail: artifact.reason,
      })
    }
    if (
      addedQuarantine !== undefined &&
      addedQuarantine.reservationID !== undefined &&
      addedQuarantine.reasonCode !== "reservation-binding-mismatch" &&
      addedQuarantine.reasonCode !== "reservation-provider-failure"
    ) {
      await this.saveCriticalAlert({
        code: "signed-state-quarantined",
        seriesID: next.seriesID,
        recordID: next.recordID,
        generation: next.generation,
        activationBlocking: true,
        createdAtUnixMs: addedQuarantine.quarantinedAtUnixMs,
        detail: addedQuarantine.reason,
      })
    }
    if (!alreadyCaptured) {
      await this.saveCriticalAlert({
        code: expectedLaneArtifact
          ? "late-signed-artifact-captured"
          : "escaped-signed-envelope-captured",
        seriesID: next.seriesID,
        recordID: next.recordID,
        generation: next.generation,
        activationBlocking: true,
        createdAtUnixMs: artifact.capturedAtUnixMs,
        detail: artifact.reason,
      })
    }
    return next
  }

  async invalidateCanonicalProvenance(
    evidence: P2TRSignatureFraudCanonicalProvenanceInvalidationEvidence
  ): Promise<readonly P2TRSignatureFraudChallengeOutboxRecord[]> {
    const fingerprint = normalizeKey(evidence.provenanceFingerprint)
    this.invalidatedProvenanceFingerprints.add(fingerprint)
    const transitioned: P2TRSignatureFraudChallengeOutboxRecord[] = []
    for (const [key, current] of this.records) {
      if (
        normalizeKey(current.canonicalProvenance.provenanceFingerprint) !==
          fingerprint ||
        normalizeKey(current.canonicalProvenance.candidateDigest) !==
          normalizeKey(evidence.candidateDigest) ||
        current.canonicalProvenance.candidateProvenanceGeneration !==
          evidence.candidateProvenanceGeneration
      ) {
        continue
      }
      const unsignedPreparationInFlight =
        current.status === "preparing" &&
        current.selectedLaneID !== undefined &&
        current.selectedSignerIdentity !== undefined &&
        current.preparationSender !== undefined &&
        current.signerInvocationStartedAtUnixMs === undefined &&
        (current.preparedTransactionVariants?.length ?? 0) === 0 &&
        (current.unexpectedSignedArtifacts?.length ?? 0) === 0 &&
        current.broadcastAttempts === 0
      const activePreparationInFlight =
        current.status === "preparing" &&
        current.preparationLease !== undefined &&
        current.activeSignerInvocationStartedAtUnixMs !== undefined
      const preservePreparationClaim =
        unsignedPreparationInFlight || activePreparationInFlight
      const escaped =
        current.signerInvocationStartedAtUnixMs !== undefined ||
        (current.preparedTransactionVariants?.length ?? 0) > 0 ||
        (current.unexpectedSignedArtifacts?.length ?? 0) > 0 ||
        current.broadcastAttempts > 0
      const terminal = [
        "accepted-own",
        "satisfied-external",
        "cancelled-before-broadcast",
        "cancelled-honest-spend",
        "cancelled-reorg",
      ].includes(current.status)
      const next: P2TRSignatureFraudChallengeOutboxRecord = {
        ...current,
        status: preservePreparationClaim
          ? "preparing"
          : terminal
          ? current.status
          : escaped
          ? "provenance-invalidated-awaiting-reconciliation"
          : "cancelled-provenance-invalidated",
        version: current.version + 1,
        provenanceInvalidationEvidence: evidence,
        preparationLease: preservePreparationClaim
          ? current.preparationLease
          : undefined,
        preparationResumeStatus: preservePreparationClaim
          ? current.preparationResumeStatus
          : undefined,
        activeSignerInvocationStartedAtUnixMs:
          current.activeSignerInvocationStartedAtUnixMs,
        updatedAtUnixMs: evidence.invalidatedAtUnixMs,
        lastError: evidence.reason,
      }
      this.records.set(key, next)
      transitioned.push(next)
      // NOTE: the PostgreSQL adapter and migration 003's manifest-rotation
      // trigger also preserve an activation-blocking incident for
      // `activePreparationInFlight`, because at invalidation time the store
      // cannot know whether the issued signer RPC crossed its boundary. This
      // double deliberately does not, so that
      // "recovers an invalidated initial authorization without inventing
      // signer I/O" keeps asserting that a rejected authorization raises no
      // reconciliation incident. Reconciling the two is a design decision
      // about whether an uninvoked boundary may retire its own incident.
      if (escaped || current.broadcastAttempts > 0 || terminal) {
        await this.saveCriticalAlert({
          code: "provenance-reconciliation-incident",
          seriesID: next.seriesID,
          recordID: next.recordID,
          generation: next.generation,
          activationBlocking: true,
          createdAtUnixMs: evidence.invalidatedAtUnixMs,
          detail: evidence.reason,
        })
      }
    }
    return transitioned
  }

  async listPage(
    request: P2TRSignatureFraudChallengeOutboxPageRequest
  ): Promise<P2TRSignatureFraudChallengeOutboxPage> {
    const records = [...this.records.values()]
      .filter((record) => request.statuses.includes(record.status))
      .sort((left, right) =>
        normalizeKey(left.recordID).localeCompare(normalizeKey(right.recordID))
      )
      .filter(
        (record) =>
          request.cursor === undefined ||
          normalizeKey(record.recordID) > request.cursor
      )
    const page = records.slice(0, request.limit)
    return {
      records: page,
      nextCursor:
        records.length > request.limit
          ? normalizeKey(page[page.length - 1].recordID)
          : undefined,
    }
  }

  async saveLegacyQuarantine(
    quarantine: P2TRSignatureFraudLegacySubmissionQuarantine
  ): Promise<void> {
    this.quarantines.push(quarantine)
  }

  async saveCriticalAlert(
    alert: P2TRSignatureFraudOutboxCriticalAlert
  ): Promise<void> {
    if (
      !this.criticalAlerts.some(
        (existing) =>
          existing.recordID === alert.recordID && existing.code === alert.code
      )
    ) {
      this.criticalAlerts.push(alert)
    }
  }

  async runInEligibilityTransaction<T>(
    observationID: string,
    operation: (
      snapshot: P2TRSignatureFraudChallengeOutboxEligibilitySnapshot
    ) => Promise<T>
  ): Promise<T> {
    if (
      this.eligibilitySnapshot === undefined ||
      normalizeKey(this.eligibilitySnapshot.challengeRecord.observationID) !==
        normalizeKey(observationID)
    ) {
      throw new Error("authoritative eligibility snapshot is absent")
    }
    return operation(this.eligibilitySnapshot)
  }

  private syncNonceReleaseRequests(
    current: P2TRSignatureFraudChallengeOutboxRecord,
    next: P2TRSignatureFraudChallengeOutboxRecord
  ): void {
    const existing = new Set(
      (current.voidedNonceReservations ?? []).map((item) =>
        normalizeKey(item.reservation.reservationID)
      )
    )
    for (const item of next.voidedNonceReservations ?? []) {
      if (existing.has(normalizeKey(item.reservation.reservationID))) continue
      const aliasOfActiveNonce =
        current.reservedNonce !== undefined &&
        normalizeKey(current.reservedNonce.reservationID) !==
          normalizeKey(item.reservation.reservationID) &&
        current.reservedNonce.sender.toLowerCase() ===
          item.reservation.sender.toLowerCase() &&
        current.reservedNonce.nonce === item.reservation.nonce
      if (aliasOfActiveNonce) continue
      const releaseRequestID = normalizeKey(
        computeP2TRSignatureFraudNonceReleaseRequestID(
          next.recordID,
          item.reservation.reservationID,
          item.evidenceDigest
        )
      )
      this.nonceReleaseRequests.set(releaseRequestID, {
        releaseRequestID,
        recordID: next.recordID,
        generation: next.generation,
        reservation: item.reservation,
        voidEvidenceDigest: item.evidenceDigest,
        requestedAtUnixMs: item.voidedAtUnixMs,
        attemptCount: 0,
        ambiguous: false,
      })
    }
  }

  private releaseAcknowledged(releaseRequestID: string): boolean {
    return (
      [
        ...(this.nonceReleaseResults.get(releaseRequestID)?.values() ?? []),
      ].some((result) => result === "acknowledged") ||
      [...this.nonceReleaseResolutions.entries()].some(
        ([key, outcome]) =>
          key.startsWith(`${releaseRequestID}:`) &&
          (outcome === "released" || outcome === "already-released")
      )
    )
  }

  private currentReleaseRequest(
    releaseRequestID: string
  ): P2TRSignatureFraudNonceReleaseRequest | undefined {
    const request = this.nonceReleaseRequests.get(releaseRequestID)
    if (request === undefined) return undefined
    const attempts = this.nonceReleaseAttempts.get(releaseRequestID) ?? []
    const results = this.nonceReleaseResults.get(releaseRequestID)
    return {
      ...request,
      attemptCount: attempts.length,
      ambiguous: attempts.some(
        (attempt) => results?.get(attempt.attemptSequence) !== "acknowledged"
      ),
    }
  }

  private nonceReleaseLaneKey(
    request: P2TRSignatureFraudNonceReleaseRequest
  ): string | undefined {
    const record = this.records.get(normalizeKey(request.recordID))
    return record === undefined
      ? undefined
      : nonceLaneKey(record.intent.chainID, request.reservation.sender)
  }

  private hasLaneConflict(
    key: string,
    next: P2TRSignatureFraudChallengeOutboxRecord
  ): boolean {
    if (next.preparationSender === undefined) {
      return false
    }
    return [...this.records.entries()].some(
      ([otherKey, other]) =>
        otherKey !== key &&
        other.preparationSender !== undefined &&
        other.intent.chainID === next.intent.chainID &&
        other.preparationSender?.toLowerCase() ===
          next.preparationSender?.toLowerCase()
    )
  }

  private preservesSignedVariantIdentities(
    current: P2TRSignatureFraudChallengeOutboxRecord,
    next: P2TRSignatureFraudChallengeOutboxRecord
  ): boolean {
    const previous = current.preparedTransactionVariants ?? []
    const following = next.preparedTransactionVariants ?? []
    if (
      following.length < previous.length ||
      following.length > previous.length + 1
    ) {
      return false
    }
    return previous.every((variant, index) => {
      const candidate = following[index]
      return (
        candidate !== undefined &&
        candidate.sequence === variant.sequence &&
        candidate.signedAtUnixMs === variant.signedAtUnixMs &&
        candidate.preparedTransaction.rawTransaction ===
          variant.preparedTransaction.rawTransaction &&
        normalizeKey(candidate.preparedTransaction.transactionHash) ===
          normalizeKey(variant.preparedTransaction.transactionHash) &&
        candidate.preparedTransaction.sender.toLowerCase() ===
          variant.preparedTransaction.sender.toLowerCase() &&
        candidate.preparedTransaction.nonce ===
          variant.preparedTransaction.nonce
      )
    })
  }
}

export class RollbackAwareInMemoryOutboxStore extends InMemoryOutboxStore {
  override async runInEligibilityTransaction<T>(
    observationID: string,
    operation: (
      snapshot: P2TRSignatureFraudChallengeOutboxEligibilitySnapshot
    ) => Promise<T>
  ): Promise<T> {
    const alertCount = this.criticalAlerts.length
    try {
      return await super.runInEligibilityTransaction(observationID, operation)
    } catch (error) {
      this.criticalAlerts.splice(alertCount)
      throw error
    }
  }
}
