#!/usr/bin/env node

import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import {
  requireEvidenceManifestSchema,
  textIncludes,
} from "./_evidence_manifest_lib.mjs"

const REQUIRED_SPEND_TYPES = [
  "unclassified",
  "deposit-sweep",
  "moving-funds",
  "moved-funds-sweep",
  "redemption",
  "wallet-closing",
  "heartbeat",
]

const FAIL_CLOSED_SPEND_TYPES = new Set([
  "unclassified",
  "wallet-closing",
  "heartbeat",
])

const SHARED_BRIDGE_STATE_GATE_SPEND_TYPES = new Set([
  "moving-funds",
  "redemption",
])

const DRAFT_POLICIES = new Set([
  "draft-seeded-not-production-approved",
  "fail-closed",
])
const FLOW_SHAPED_DRAFT_EVIDENCE_LEVEL = "flow-shaped-draft-vector-seed"
const FLOW_PROOF_CORRELATION_REQUIRED = "required-not-present"

const EXCLUDED_SCOPE_TERMS = ["account-control", "ac-watchdog", "covenant"]

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(scriptDir, "../../..")
const manifestPath = path.join(
  rootDir,
  "docs/test-vectors/p2tr-signature-fraud-spend-type-closure.json"
)
const vectorsPath = path.join(
  rootDir,
  "docs/test-vectors/p2tr-signature-fraud-v0.json"
)
const sdkWatchtowerPath = path.join(
  rootDir,
  "typescript/src/services/maintenance/p2tr-signature-fraud.ts"
)
const sdkWatchtowerTestPath = path.join(
  rootDir,
  "typescript/test/services/p2tr-signature-fraud.test.ts"
)
const watchtowerServicePath = path.join(
  rootDir,
  "services/watchtower/src/P2TRSignatureFraudWatchtowerService.ts"
)
const watchtowerServiceTestPath = path.join(
  rootDir,
  "services/watchtower/test/P2TRSignatureFraudWatchtowerService.test.ts"
)

const fail = (message) => {
  console.error(`[p2tr-spend-type-closure] ${message}`)
  process.exit(1)
}

const readJson = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"))
  } catch (error) {
    fail(`failed to read ${path.relative(rootDir, filePath)}: ${error.message}`)
  }
}

const readText = (filePath) => {
  try {
    return fs.readFileSync(filePath, "utf8")
  } catch (error) {
    fail(`failed to read ${path.relative(rootDir, filePath)}: ${error.message}`)
  }
}

const requireArray = (value, label) => {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array`)
  }

  return value
}

const requireObject = (value, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`)
  }

  return value
}

const manifest = readJson(manifestPath)
const vectors = readJson(vectorsPath)
const sdkWatchtower = readText(sdkWatchtowerPath)
const sdkWatchtowerTests = readText(sdkWatchtowerTestPath)
const watchtowerService = readText(watchtowerServicePath)
const watchtowerServiceTests = readText(watchtowerServiceTestPath)

requireEvidenceManifestSchema(
  manifest,
  "P2TR spend-type closure manifest",
  fail
)

for (const phrase of [
  "failClosedP2TRSignatureFraudSubmissionSpendTypes",
  "P2TR_SIGNATURE_FRAUD_SPEND_TYPE_UNCLASSIFIED",
  "P2TR_SIGNATURE_FRAUD_SPEND_TYPE_WALLET_CLOSING",
  "P2TR_SIGNATURE_FRAUD_SPEND_TYPE_HEARTBEAT",
  "is fail-closed for challenge submission",
]) {
  if (!textIncludes(sdkWatchtower, phrase)) {
    fail(`SDK watchtower source is missing spend-type closure guard ${phrase}`)
  }
}

for (const phrase of [
  "fails closed for unapproved spend types before submission",
  "rejects fail-closed spend types in submission policies",
  "P2TR-SPEND-TYPE-NOT-APPROVED",
  "expect(submitter.submissionCount).to.equal(0)",
]) {
  if (!textIncludes(sdkWatchtowerTests, phrase)) {
    fail(`SDK watchtower tests are missing spend-type closure guard ${phrase}`)
  }
}

for (const phrase of [
  "failClosedSubmissionSpendTypes",
  "rejectFailClosedSubmissionSpendTypes",
  "P2TR_SIGNATURE_FRAUD_SPEND_TYPE_UNCLASSIFIED",
  "P2TR_SIGNATURE_FRAUD_SPEND_TYPE_WALLET_CLOSING",
  "P2TR_SIGNATURE_FRAUD_SPEND_TYPE_HEARTBEAT",
]) {
  if (!textIncludes(watchtowerService, phrase)) {
    fail(`watchtower service is missing spend-type closure guard ${phrase}`)
  }
}

for (const phrase of [
  "requires an approved spend-type policy when submissions are enabled",
  "keeps unresolved spend types fail-closed for submissions",
  "P2TR_SIGNATURE_FRAUD_SPEND_TYPE_UNCLASSIFIED",
  "P2TR_SIGNATURE_FRAUD_SPEND_TYPE_WALLET_CLOSING",
  "P2TR_SIGNATURE_FRAUD_SPEND_TYPE_HEARTBEAT",
]) {
  if (!textIncludes(watchtowerServiceTests, phrase)) {
    fail(
      `watchtower service tests are missing spend-type closure guard ${phrase}`
    )
  }
}

if (manifest.name !== "p2tr-signature-fraud-spend-type-closure-v0") {
  fail("unexpected manifest name")
}

if (manifest.status !== "draft-no-go") {
  fail("manifest must remain draft-no-go until production approval is recorded")
}

if (manifest.appliesTo !== "schnorr-frost-roast-p2tr-signature-fraud") {
  fail("manifest appliesTo must stay scoped to Schnorr/FROST/ROAST fraud work")
}

const excludedScopes = new Set(
  requireArray(manifest.excludedScopes, "excludedScopes")
)
for (const term of EXCLUDED_SCOPE_TERMS) {
  if (!excludedScopes.has(term)) {
    fail(`excludedScopes must include ${term}`)
  }
}

const spendTypes = requireArray(manifest.spendTypes, "spendTypes")
const bySpendType = new Map()

for (const entry of spendTypes) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    fail("each spendTypes entry must be an object")
  }

  if (typeof entry.id !== "string") {
    fail("each spendTypes entry must include an id")
  }

  if (bySpendType.has(entry.id)) {
    fail(`duplicate spend type ${entry.id}`)
  }

  bySpendType.set(entry.id, entry)
}

const actualSpendTypes = [...bySpendType.keys()].sort()
const expectedSpendTypes = [...REQUIRED_SPEND_TYPES].sort()
if (JSON.stringify(actualSpendTypes) !== JSON.stringify(expectedSpendTypes)) {
  fail(`manifest spend types must be exactly ${expectedSpendTypes.join(", ")}`)
}

for (const spendType of REQUIRED_SPEND_TYPES) {
  const entry = bySpendType.get(spendType)

  if (!DRAFT_POLICIES.has(entry.submissionPolicy)) {
    fail(
      `${spendType} has unsupported submissionPolicy ${entry.submissionPolicy}`
    )
  }

  if (entry.productionApproved !== false) {
    fail(
      `${spendType} must not be productionApproved while status is draft-no-go`
    )
  }

  const evidenceRefs = requireArray(
    entry.evidenceRefs,
    `${spendType}.evidenceRefs`
  )
  if (evidenceRefs.length === 0) {
    fail(`${spendType} must include evidenceRefs`)
  }

  for (const ref of evidenceRefs) {
    if (typeof ref !== "string" || ref.length === 0) {
      fail(`${spendType}.evidenceRefs must contain non-empty strings`)
    }

    if (EXCLUDED_SCOPE_TERMS.some((term) => ref.includes(term))) {
      fail(`${spendType} evidenceRefs must not point at out-of-scope ${ref}`)
    }
  }

  const openGaps = requireArray(entry.openGaps, `${spendType}.openGaps`)
  if (openGaps.length === 0) {
    fail(`${spendType} must list remaining openGaps`)
  }

  if (FAIL_CLOSED_SPEND_TYPES.has(spendType)) {
    if (entry.submissionPolicy !== "fail-closed") {
      fail(`${spendType} must remain fail-closed`)
    }
    if (entry.bridgeStateGate !== null) {
      fail(`${spendType} must not claim a Bridge state gate`)
    }
  } else if (entry.bridgeStateGate === null) {
    fail(`${spendType} must name the seeded Bridge state gate`)
  }
}

const coverageGaps = requireArray(
  vectors.openCoverageGaps,
  "vector openCoverageGaps"
)
if (!coverageGaps.includes("all tBTC spend-type vectors")) {
  fail(
    "vector corpus must continue to list all tBTC spend-type vectors as open"
  )
}

const spendTypeCoverage = requireArray(
  vectors.spendTypeCoverage,
  "vector spendTypeCoverage"
)
const coverageBySpendType = new Map()
const vectorCasesById = new Map()

for (const vector of requireArray(vectors.cases, "vector cases")) {
  requireObject(vector, "vector case")

  if (typeof vector.id !== "string" || vector.id.length === 0) {
    fail("vector cases must include non-empty ids")
  }

  if (vectorCasesById.has(vector.id)) {
    fail(`duplicate vector case ${vector.id}`)
  }

  vectorCasesById.set(vector.id, vector)
}

for (const entry of spendTypeCoverage) {
  requireObject(entry, "vector spendTypeCoverage entry")

  if (typeof entry.id !== "string") {
    fail("vector spendTypeCoverage entries must include an id")
  }

  if (coverageBySpendType.has(entry.id)) {
    fail(`duplicate vector spendTypeCoverage entry ${entry.id}`)
  }

  coverageBySpendType.set(entry.id, entry)
}

for (const spendType of SHARED_BRIDGE_STATE_GATE_SPEND_TYPES) {
  const entry = bySpendType.get(spendType)
  const flowSpecificClosure = requireObject(
    entry.flowSpecificClosure,
    `${spendType}.flowSpecificClosure`
  )
  const coverage = requireObject(
    coverageBySpendType.get(spendType),
    `vector spendTypeCoverage.${spendType}`
  )

  if (flowSpecificClosure.status !== "open") {
    fail(`${spendType}.flowSpecificClosure must remain open`)
  }

  const expectedCoverageRef = `docs/test-vectors/p2tr-signature-fraud-v0.json#spendTypeCoverage:${spendType}`
  if (flowSpecificClosure.vectorCoverageRef !== expectedCoverageRef) {
    fail(`${spendType}.flowSpecificClosure vectorCoverageRef is stale`)
  }

  if (
    typeof flowSpecificClosure.sharedGateLimit !== "string" ||
    !flowSpecificClosure.sharedGateLimit.includes(entry.bridgeStateGate)
  ) {
    fail(`${spendType}.flowSpecificClosure must describe the shared gate limit`)
  }

  if (coverage.status !== "open") {
    fail(`vector spendTypeCoverage.${spendType} must remain open`)
  }

  if (entry.evidenceLevel !== FLOW_SHAPED_DRAFT_EVIDENCE_LEVEL) {
    fail(
      `${spendType} manifest evidenceLevel must identify draft flow-shaped vector evidence`
    )
  }

  if (coverage.evidenceLevel !== FLOW_SHAPED_DRAFT_EVIDENCE_LEVEL) {
    fail(
      `vector spendTypeCoverage.${spendType} must identify draft flow-shaped vector evidence`
    )
  }

  if (coverage.sharedGate !== entry.bridgeStateGate) {
    fail(`vector spendTypeCoverage.${spendType} sharedGate mismatch`)
  }

  const currentDraftCaseIds = requireArray(
    coverage.currentDraftCaseIds,
    `${spendType}.currentDraftCaseIds`
  )
  if (currentDraftCaseIds.length === 0) {
    fail(`${spendType} must include draft flow-shaped vector case ids`)
  }

  for (const caseId of currentDraftCaseIds) {
    if (typeof caseId !== "string" || caseId.length === 0) {
      fail(`${spendType}.currentDraftCaseIds must contain non-empty strings`)
    }

    const vector = requireObject(
      vectorCasesById.get(caseId),
      `${spendType}.currentDraftCaseIds.${caseId}`
    )
    const metadata = requireObject(
      vector.flowMetadata,
      `${spendType}.currentDraftCaseIds.${caseId}.flowMetadata`
    )

    if (metadata.spendType !== spendType) {
      fail(`${caseId} flowMetadata spendType mismatch`)
    }
    if (metadata.evidenceLevel !== FLOW_SHAPED_DRAFT_EVIDENCE_LEVEL) {
      fail(`${caseId} flowMetadata evidenceLevel mismatch`)
    }
    if (metadata.proofEventCorrelation !== FLOW_PROOF_CORRELATION_REQUIRED) {
      fail(`${caseId} must keep Bridge proof-event correlation open`)
    }
    if (metadata.sourceWalletInput !== vector.signedInputIndex) {
      fail(`${caseId} flowMetadata sourceWalletInput mismatch`)
    }
  }

  if (
    requireArray(
      coverage.draftEvidenceLimits,
      `${spendType}.draftEvidenceLimits`
    ).length === 0
  ) {
    fail(`${spendType}.draftEvidenceLimits must preserve draft-only status`)
  }

  for (const field of [
    "requiredPositiveVectors",
    "requiredNegativeVectors",
    "bridgeCorrelationRequired",
  ]) {
    if (requireArray(coverage[field], `${spendType}.${field}`).length === 0) {
      fail(`${spendType}.${field} must list remaining closure requirements`)
    }
  }
}

console.log(
  `[p2tr-spend-type-closure] checked ${REQUIRED_SPEND_TYPES.length} spend types; production activation remains NO-GO`
)
