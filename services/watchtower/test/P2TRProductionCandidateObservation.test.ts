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
    assert.equal(
      claim.observation.observationID.toString(),
      fixture.request.observationID
    )
    assert.equal(claim.provenanceGeneration, 7)
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
  return {
    locked,
    request: {
      txid: locked.txid,
      wtxid,
      blockHeight: locked.blockHeight,
      blockHash: locked.blockHash,
      inputIndex: observation.inputIndex,
      observationID: observation.observationID.toString(),
      challengeKey: observation.bridgeChallengeKey.toString(),
    },
  }
}
