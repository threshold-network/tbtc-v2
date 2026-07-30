import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type {
  P2TRCanonicalBitcoinBlock,
  P2TRCanonicalBitcoinBlockSource,
  P2TRCanonicalBitcoinTransaction,
} from "../src/P2TRCanonicalBitcoinIndex.js"
import { CanonicalBitcoinP2TRProductionEvidenceProvider } from "../src/CanonicalBitcoinP2TRProductionEvidenceProvider.js"

const FUNDING_TXID = "11".repeat(32)
const CANDIDATE_TXID = "22".repeat(32)
const CANDIDATE_WTXID = "33".repeat(32)
const BLOCK_HASH = "44".repeat(32)

describe("canonical Bitcoin production evidence", () => {
  it("resolves an external prevout before attesting a candidate", async () => {
    const fixture = sourceFixture()
    const provider = new CanonicalBitcoinP2TRProductionEvidenceProvider(
      fixture.source,
      { operatorIdentity: "independent-operator" }
    )

    const attestation = await provider.attestCandidate({
      txid: CANDIDATE_TXID,
      wtxid: CANDIDATE_WTXID,
      blockHeight: 10,
      blockHash: BLOCK_HASH,
      inputIndex: 0,
      observationID: "aa".repeat(32),
      challengeKey: "bb".repeat(32),
    })

    assert.equal(attestation.present, true)
    assert.deepEqual(
      fixture.candidate.inputs[0].authenticatedPrevout,
      fixture.funding.outputs[0]
    )
    assert.deepEqual(fixture.rawTransactionRequests, [FUNDING_TXID])
  })

  it("rejects a funding transaction that does not authenticate the prevout", async () => {
    const fixture = sourceFixture()
    fixture.funding.txid = "55".repeat(32)
    const provider = new CanonicalBitcoinP2TRProductionEvidenceProvider(
      fixture.source,
      { operatorIdentity: "independent-operator" }
    )

    await assert.rejects(
      provider.attestCandidate({
        txid: CANDIDATE_TXID,
        wtxid: CANDIDATE_WTXID,
        blockHeight: 10,
        blockHash: BLOCK_HASH,
        inputIndex: 0,
        observationID: "aa".repeat(32),
        challengeKey: "bb".repeat(32),
      }),
      /funding transaction is unauthenticated/
    )
  })
})

function sourceFixture(): {
  source: P2TRCanonicalBitcoinBlockSource
  block: P2TRCanonicalBitcoinBlock
  candidate: P2TRCanonicalBitcoinTransaction
  funding: P2TRCanonicalBitcoinTransaction
  rawTransactionRequests: string[]
} {
  const funding: P2TRCanonicalBitcoinTransaction = {
    txid: FUNDING_TXID,
    wtxid: FUNDING_TXID,
    rawTransactionHex: "01",
    coinbase: true,
    inputs: [],
    outputs: [
      {
        txid: FUNDING_TXID,
        vout: 0,
        valueSats: 1,
        scriptPubKey: `5120${"66".repeat(32)}`,
      },
    ],
  }
  const candidate: P2TRCanonicalBitcoinTransaction = {
    txid: CANDIDATE_TXID,
    wtxid: CANDIDATE_WTXID,
    rawTransactionHex: "02",
    coinbase: false,
    inputs: [
      {
        txid: FUNDING_TXID,
        vout: 0,
        spendingTxid: CANDIDATE_TXID,
        inputIndex: 0,
      },
    ],
    outputs: [],
  }
  const block: P2TRCanonicalBitcoinBlock = {
    height: 10,
    hash: BLOCK_HASH,
    parentHash: "77".repeat(32),
    header80Hex: "00".repeat(80),
    rawBlockHex: "00",
    transactions: [candidate],
  }
  const rawTransactionRequests: string[] = []
  const source: P2TRCanonicalBitcoinBlockSource = {
    trustDomainID: "bitcoin-core-primary",
    network: "main",
    genesisHash: "88".repeat(32),
    async getSyncedHead() {
      return { height: 10, hash: BLOCK_HASH }
    },
    async getBlockHash(height) {
      return height === 10 ? BLOCK_HASH : this.genesisHash
    },
    async getBlock() {
      return block
    },
    async getRawTransaction(txid) {
      rawTransactionRequests.push(txid)
      return funding
    },
  }
  Object.assign(source, { endpointFingerprint: `0x${"99".repeat(32)}` })
  return { source, block, candidate, funding, rawTransactionRequests }
}
