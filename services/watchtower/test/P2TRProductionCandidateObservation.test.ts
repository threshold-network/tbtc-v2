import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, it } from "node:test"
import { Transaction } from "bitcoinjs-lib"
import {
  extractP2TRSignatureFraudWitnessObservations,
  type P2TRWalletInputObservationPrevout,
} from "@keep-network/tbtc-v2.ts"
import {
  resolveP2TRProductionCanonicalObservation,
  type P2TRProductionLockedCandidateProvenance,
} from "../src/P2TRProductionCandidateObservation.js"
import { calculateP2TRCanonicalOccurrenceID } from "../src/P2TRCanonicalOccurrenceIdentity.js"
import { computeP2TRCompleteAuthorizationDomainDigest } from "../src/P2TRCompleteCandidateIdentity.js"

type Vector = {
  id: string
  walletIDHex: string
  unsignedTransactionHex: string
  signedInputIndex: number
  witnessSignatureHex: string
  prevouts: {
    txidHex: string
    vout: number
    valueSats: number | string
    scriptPubKeyHex: string
  }[]
}

const bridgeDomain = {
  chainID: 11155111,
  bridgeAddress: "0x1111111111111111111111111111111111111111",
}

describe("production per-input candidate observation", () => {
  it("reconstructs the exact challenge from locked occurrence provenance", () => {
    const fixture = candidateFixture()
    const claim = resolveP2TRProductionCanonicalObservation(
      fixture.request,
      fixture.locked,
      bridgeDomain
    )

    assert.equal(claim.identity.inputIndex, 1)
    assert.equal(claim.inputProvenance.fundingTxid, "bb".repeat(32))
    assert.equal(claim.identity.observationID, fixture.occurrenceID)
    assert.equal(claim.identity.challengeKey, fixture.challengeKey)
    assert.equal(claim.provenanceGeneration, 7)
  })

  it("separates the occurrence identity from the challenge-series key", () => {
    const fixture = candidateFixture()
    // The SDK reports observationID as an alias of the Bridge challenge key.
    // The canonical occurrence must NOT be that value, otherwise two inputs in
    // one challenge series would collide onto a single acknowledgement.
    assert.equal(
      fixture.challengeKey.replace(/^0x/i, "").toLowerCase(),
      fixture.sdkObservationID.replace(/^0x/i, "").toLowerCase()
    )
    assert.notEqual(
      fixture.occurrenceID.replace(/^0x/i, "").toLowerCase(),
      fixture.sdkObservationID.replace(/^0x/i, "").toLowerCase()
    )
  })

  it("rejects a request that still carries the challenge key as the occurrence", () => {
    const fixture = candidateFixture()
    assert.throws(
      () =>
        resolveP2TRProductionCanonicalObservation(
          { ...fixture.request, observationID: fixture.challengeKey },
          fixture.locked,
          bridgeDomain
        ),
      /does not match the canonical witnessed signing key/
    )
  })

  it("gives two occurrences sharing one challenge identity distinct identities", () => {
    const fixture = candidateFixture()
    // Same challenge series, different canonical input coordinates.
    const sibling = occurrenceFor(fixture.locked, 0, fixture.challengeKey)
    assert.notEqual(sibling, fixture.occurrenceID)
  })

  it("gives a reorg replacement a distinct occurrence so stale ACKs cannot settle it", () => {
    const fixture = candidateFixture()
    const replacementBlock: P2TRProductionLockedCandidateProvenance = {
      ...fixture.locked,
      blockHash: "99".repeat(32),
    }
    const replacementGeneration: P2TRProductionLockedCandidateProvenance = {
      ...fixture.locked,
      provenanceGeneration: fixture.locked.provenanceGeneration + 1,
    }
    const replacementFingerprint: P2TRProductionLockedCandidateProvenance = {
      ...fixture.locked,
      provenanceFingerprint: "77".repeat(32),
    }
    for (const replacement of [
      replacementBlock,
      replacementGeneration,
      replacementFingerprint,
    ]) {
      assert.notEqual(
        occurrenceFor(
          replacement,
          fixture.request.inputIndex,
          fixture.challengeKey
        ),
        fixture.occurrenceID
      )
    }
  })

  it("binds every occurrence field, so any single mutation changes the identity", () => {
    const fixture = candidateFixture()
    const base = {
      domainDigest: computeP2TRCompleteAuthorizationDomainDigest({
        domainChainID: String(bridgeDomain.chainID),
        bridgeAddress: bridgeDomain.bridgeAddress,
      }),
      provenanceGeneration: fixture.locked.provenanceGeneration,
      blockHash: fixture.locked.blockHash,
      txid: fixture.locked.txid,
      wtxid: fixture.locked.wtxid,
      inputIndex: fixture.request.inputIndex,
      provenanceFingerprint: fixture.locked.provenanceFingerprint,
      challengeIdentity: fixture.challengeKey,
    }
    assert.equal(calculateP2TRCanonicalOccurrenceID(base), fixture.occurrenceID)

    const mutations = [
      { domainDigest: "01".repeat(32) },
      { provenanceGeneration: base.provenanceGeneration + 1 },
      { blockHash: "02".repeat(32) },
      { txid: "03".repeat(32) },
      { wtxid: "04".repeat(32) },
      { inputIndex: base.inputIndex + 1 },
      { provenanceFingerprint: "05".repeat(32) },
      { challengeIdentity: "06".repeat(32) },
    ]
    for (const mutation of mutations) {
      assert.notEqual(
        calculateP2TRCanonicalOccurrenceID({ ...base, ...mutation }),
        fixture.occurrenceID,
        `mutating ${Object.keys(mutation)[0]} must change the occurrence`
      )
    }

    // Dropping the challenge must also be domain-separated from including it.
    const { challengeIdentity: _omitted, ...withoutChallenge } = base
    assert.notEqual(
      calculateP2TRCanonicalOccurrenceID(withoutChallenge),
      fixture.occurrenceID
    )
  })

  it("matches the frozen cross-language occurrence vectors", () => {
    const frozen = {
      domainDigest: "11".repeat(32),
      provenanceGeneration: 7,
      blockHash: "22".repeat(32),
      txid: "33".repeat(32),
      wtxid: "44".repeat(32),
      inputIndex: 2,
      provenanceFingerprint: "55".repeat(32),
    }
    assert.equal(
      calculateP2TRCanonicalOccurrenceID({
        ...frozen,
        challengeIdentity: "66".repeat(32),
      }),
      "4ceeda3e8ec284bf60729eac66c5eb48fe574cf9cb18b72fd11cc47afe818869"
    )
    assert.equal(
      calculateP2TRCanonicalOccurrenceID(frozen),
      "3e3401263f5b30f4ec9f25560ac9bb288c7f1108fa988188c8116bf68ae69405"
    )
  })

  it("rejects a valid multi-input transaction when authority names the wrong input", () => {
    const fixture = candidateFixture()
    assert.throws(
      () =>
        resolveP2TRProductionCanonicalObservation(
          { ...fixture.request, inputIndex: 0 },
          fixture.locked,
          bridgeDomain
        ),
      /does not match the canonical witnessed signing key/
    )
  })

  it("rejects a provenance row whose output key differs from the witnessed P2TR key", () => {
    const fixture = candidateFixture()
    fixture.locked.inputProvenance[1] = {
      ...fixture.locked.inputProvenance[1],
      outputKey: "42".repeat(32),
    }
    assert.throws(
      () =>
        resolveP2TRProductionCanonicalObservation(
          fixture.request,
          fixture.locked,
          bridgeDomain
        ),
      /not bound to the canonical P2TR output key/
    )
  })

  it("rejects a deposit provenance row with another wallet signing-key binding", () => {
    const fixture = candidateFixture()
    const provenance = fixture.locked.inputProvenance[1]
    fixture.locked.inputProvenance[1] = {
      ...provenance,
      bindingKind: "deposit",
    }
    fixture.locked.walletInputKeyBindings = [
      {
        txid: provenance.fundingTxid,
        vout: provenance.fundingVout,
        outputKey: provenance.outputKey,
        walletID: "43".repeat(32),
      },
    ]
    assert.throws(
      () =>
        resolveP2TRProductionCanonicalObservation(
          fixture.request,
          fixture.locked,
          bridgeDomain
        ),
      /signing-key binding is not canonical/
    )
  })
})

function candidateFixture() {
  const vectors = JSON.parse(
    readFileSync(
      resolve(process.cwd(), "docs/test-vectors/p2tr-signature-fraud-v0.json"),
      "utf8"
    )
  ) as { cases: Vector[] }
  const vector = vectors.cases.find(
    ({ id }) => id === "bip341-keypath-sighash-default-multi-input-multi-output"
  )
  if (vector === undefined) throw new Error("multi-input vector is absent")

  const transaction = Transaction.fromHex(vector.unsignedTransactionHex)
  for (const input of transaction.ins) {
    input.witness = [Buffer.from(vector.witnessSignatureHex, "hex")]
  }
  const rawTransactionHex = transaction.toHex()
  const inputPrevouts: P2TRWalletInputObservationPrevout[] =
    vector.prevouts.map((prevout) => ({
      txid: prevout.txidHex,
      vout: prevout.vout,
      valueSats: prevout.valueSats,
      scriptPubKey: prevout.scriptPubKeyHex,
    }))
  const observation = extractP2TRSignatureFraudWitnessObservations(
    { transactionHex: rawTransactionHex },
    inputPrevouts,
    [vector.walletIDHex],
    undefined,
    undefined,
    undefined,
    bridgeDomain
  ).find(({ inputIndex }) => inputIndex === vector.signedInputIndex)
  if (observation?.bridgeChallengeKey === undefined) {
    throw new Error("multi-input vector did not yield a Bridge challenge")
  }
  const wtxid = Buffer.from(transaction.getHash(true)).reverse().toString("hex")
  const locked: P2TRProductionLockedCandidateProvenance = {
    txid: transaction.getId(),
    wtxid,
    blockHeight: 840000,
    blockHash: "12".repeat(32),
    rawTransactionHex,
    inputPrevouts,
    walletInputKeyBindings: [],
    provenanceGeneration: 7,
    provenanceFingerprint: "34".repeat(32),
    inputProvenance: vector.prevouts.map((prevout, inputIndex) => ({
      inputIndex,
      fundingBlockHash: `${inputIndex + 1}`.padStart(64, "0"),
      fundingTxid: prevout.txidHex,
      fundingVout: prevout.vout,
      bindingKind: "wallet" as const,
      walletID: vector.walletIDHex,
      outputKey: vector.walletIDHex,
      sourceEventID: `${inputIndex + 10}`.padStart(64, "0"),
      ethereumBlockNumber: 100 + inputIndex,
      ethereumBlockHash: `${inputIndex + 20}`.padStart(64, "0"),
    })),
  }
  const challengeKey = observation.bridgeChallengeKey.toString()
  const occurrenceID = occurrenceFor(
    locked,
    observation.inputIndex,
    challengeKey
  )
  return {
    locked,
    challengeKey,
    occurrenceID,
    sdkObservationID: observation.observationID.toString(),
    request: {
      txid: locked.txid,
      wtxid,
      blockHeight: locked.blockHeight,
      blockHash: locked.blockHash,
      inputIndex: observation.inputIndex,
      observationID: occurrenceID,
      challengeKey,
    },
  }
}

/**
 * Recomputes the canonical occurrence identity exactly as the production
 * resolver does, so the tests bind to the formula rather than to a copy of the
 * resolver's internals.
 */
function occurrenceFor(
  locked: P2TRProductionLockedCandidateProvenance,
  inputIndex: number,
  challengeIdentity: string
): string {
  return calculateP2TRCanonicalOccurrenceID({
    domainDigest: computeP2TRCompleteAuthorizationDomainDigest({
      domainChainID: String(bridgeDomain.chainID),
      bridgeAddress: bridgeDomain.bridgeAddress,
    }),
    provenanceGeneration: locked.provenanceGeneration,
    blockHash: locked.blockHash,
    txid: locked.txid,
    wtxid: locked.wtxid,
    inputIndex,
    provenanceFingerprint: locked.provenanceFingerprint,
    challengeIdentity,
  })
}
