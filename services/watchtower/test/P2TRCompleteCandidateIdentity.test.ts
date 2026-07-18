import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  assertP2TRVerifiedCompleteCandidateIdentity,
  computeP2TRCompleteChallengeIdentity,
  encodeP2TRCompleteChallengeEvidence,
  verifyP2TRCompleteCandidateIdentity,
  type P2TRCompleteCandidateIdentity,
  type P2TRCompleteChallengeEvidence,
} from "../src/P2TRCompleteCandidateIdentity.js"

const domain = {
  domainChainID: "1",
  bridgeAddress: "0x1111111111111111111111111111111111111111",
}

const evidence: P2TRCompleteChallengeEvidence = {
  walletID:
    "0xf9502d540ca7d5ab09ea89e83889fa4bcd0b27f7eec5752f4fa07b1b19160f3b",
  signingKey:
    "0xf9502d540ca7d5ab09ea89e83889fa4bcd0b27f7eec5752f4fa07b1b19160f3b",
  bindingTxHash: `0x${"00".repeat(32)}`,
  bindingOutputIndex: 0,
  sighash: "0xedc0355e9a341f61fa9312ea99edc9e91501c3aeb7f5f25adb866aecbabec315",
  nonceX: "0xbd9b6cb8de6956ed31aebb10f241b6fa7a37675728e7ae645456a3f07ccd5a30",
  signatureScalar:
    "0x6073380949e71abd7f3ee673497e71242216c9f84a64a91f32b5af202be47ab1",
}

function candidate(
  overrides: Partial<P2TRCompleteCandidateIdentity> = {}
): P2TRCompleteCandidateIdentity {
  return {
    schema: "tbtc-p2tr-complete-candidate/v2",
    txid: "11".repeat(32),
    wtxid: "22".repeat(32),
    blockHeight: 840_000,
    blockHash: "33".repeat(32),
    inputIndex: 7,
    evidence,
    challengeIdentity:
      "0xd54dd4754e29f32b513a31865bf327437404fb32f8e83f122b611922a23eeb50",
    ...overrides,
  }
}

describe("COMPLETE_V2 production candidate identity", () => {
  it("matches the Solidity 7-word encoding and authorization vector", () => {
    assert.equal(
      computeP2TRCompleteChallengeIdentity(domain, evidence),
      "d54dd4754e29f32b513a31865bf327437404fb32f8e83f122b611922a23eeb50"
    )
    assert.equal(
      encodeP2TRCompleteChallengeEvidence(evidence),
      "f9502d540ca7d5ab09ea89e83889fa4bcd0b27f7eec5752f4fa07b1b19160f3b" +
        "f9502d540ca7d5ab09ea89e83889fa4bcd0b27f7eec5752f4fa07b1b19160f3b" +
        "00".repeat(64) +
        "edc0355e9a341f61fa9312ea99edc9e91501c3aeb7f5f25adb866aecbabec315" +
        "bd9b6cb8de6956ed31aebb10f241b6fa7a37675728e7ae645456a3f07ccd5a30" +
        "6073380949e71abd7f3ee673497e71242216c9f84a64a91f32b5af202be47ab1"
    )
  })

  it("issues an unforgeable process-local COMPLETE brand", () => {
    const verified = verifyP2TRCompleteCandidateIdentity(candidate(), domain)
    assert.equal(
      assertP2TRVerifiedCompleteCandidateIdentity(verified, {
        inputIndex: 7,
        challengeIdentity: candidate().challengeIdentity,
      }).evidence.sighash,
      evidence.sighash.slice(2)
    )
    assert.throws(
      () =>
        assertP2TRVerifiedCompleteCandidateIdentity({
          ...verified,
        } as typeof verified),
      /not verified by this runtime/
    )
  })

  it("rejects legacy identities and altered authorization fields", () => {
    assert.throws(
      () =>
        verifyP2TRCompleteCandidateIdentity(
          {
            ...candidate(),
            schema: "tbtc-p2tr-bounded-candidate/v1",
          } as unknown as P2TRCompleteCandidateIdentity,
          domain
        ),
      /Legacy or unsupported/
    )
    for (const changed of [
      { ...evidence, signingKey: "44".repeat(32) },
      { ...evidence, sighash: "55".repeat(32) },
    ]) {
      assert.throws(
        () =>
          verifyP2TRCompleteCandidateIdentity(
            candidate({ evidence: changed }),
            domain
          ),
        /identity is invalid|binding is not canonical/
      )
    }
  })

  it("requires zero base-key bindings and explicit tweaked-key outpoints", () => {
    assert.throws(
      () =>
        verifyP2TRCompleteCandidateIdentity(
          candidate({
            evidence: {
              ...evidence,
              bindingTxHash: "66".repeat(32),
            },
          }),
          domain
        ),
      /binding is not canonical/
    )
    assert.throws(
      () =>
        verifyP2TRCompleteCandidateIdentity(
          candidate({
            evidence: {
              ...evidence,
              signingKey: "77".repeat(32),
            },
          }),
          domain
        ),
      /binding is not canonical/
    )
  })
})
