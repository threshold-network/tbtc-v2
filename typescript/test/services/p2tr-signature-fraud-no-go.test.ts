import fs from "fs"
import path from "path"

import { expect } from "chai"
import { Transaction } from "bitcoinjs-lib"
import { utils } from "ethers"

import { BitcoinClient, BitcoinRawTx } from "../../src/lib/bitcoin"
import { Hex } from "../../src/lib/utils"
import {
  extractP2TRSignatureFraudWitnessObservations,
  deserializeP2TRWatchtowerChallengeRecord,
  P2TR_SIGNATURE_FRAUD_BRIDGE_ACTION_SUBMIT,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
  P2TRSignatureFraudBridgeChallengeSubmitter,
  P2TRSignatureFraudChallengeSubmitter,
  P2TRSignatureFraudWitnessObservation,
  P2TRSignatureFraudWatchtower,
  P2TRSignatureFraudWatchtowerRunner,
  P2TRWatchtowerChallengeRecord,
  P2TRWatchtowerChallengeRecordJSON,
  P2TRWatchtowerChallengeReplayStore,
  serializeP2TRWatchtowerChallengeRecord,
} from "../../src/services/maintenance/p2tr-signature-fraud"

type PrevoutVector = {
  txidHex: string
  vout: number
  valueSats: number | string
  scriptPubKeyHex: string
}

type SignatureFraudVector = {
  id: string
  walletIDHex: string
  unsignedTransactionHex: string
  signedInputIndex: number
  prevouts: PrevoutVector[]
  witnessSignatureHex: string
  annexHex?: string
}

const vectorCorpusPath = path.resolve(
  __dirname,
  "../../../docs/test-vectors/p2tr-signature-fraud-full-sighash-v0.json"
)

const vectors = (
  JSON.parse(fs.readFileSync(vectorCorpusPath, "utf8")) as {
    cases: SignatureFraudVector[]
  }
).cases

const requireVector = (id: string): SignatureFraudVector => {
  const vector = vectors.find((candidate) => candidate.id === id)
  if (vector === undefined) {
    throw new Error(`Missing P2TR signature-fraud vector ${id}`)
  }

  return vector
}

const annexVector = requireVector("bip341-keypath-default-with-annex")
const inputZeroVector = requireVector("bip341-keypath-none-multi")
const inputTwoVector = requireVector("bip341-keypath-single-multi")
const bridgeChallengeDomain = {
  chainID: 11155111,
  bridgeAddress: "0x1111111111111111111111111111111111111111",
}
const completeBridgeChallengeEvidenceAbiType =
  "tuple(bytes32 walletID,bytes32 signingKey,bytes32 bindingTxHash,uint32 bindingOutputIndex,bytes32 sighash,bytes32 nonceX,bytes32 signatureScalar)"

const buildAnnexTransaction = (): BitcoinRawTx => {
  if (annexVector.annexHex === undefined) {
    throw new Error("Missing annex bytes in P2TR signature-fraud vector")
  }

  const transaction = Transaction.fromHex(annexVector.unsignedTransactionHex)
  transaction.ins[0].witness = [
    Buffer.from(inputZeroVector.witnessSignatureHex, "hex"),
  ]
  transaction.ins[annexVector.signedInputIndex].witness = [
    Buffer.from(annexVector.witnessSignatureHex, "hex"),
    Buffer.from(annexVector.annexHex, "hex"),
  ]
  transaction.ins[2].witness = [
    Buffer.from(inputTwoVector.witnessSignatureHex, "hex"),
  ]

  return { transactionHex: transaction.toHex() }
}

const toObservationPrevouts = () =>
  annexVector.prevouts.map((prevout) => ({
    txid: prevout.txidHex,
    vout: prevout.vout,
    valueSats: prevout.valueSats,
    scriptPubKey: prevout.scriptPubKeyHex,
  }))

const rawPreviousTransactionForPrevout = (
  prevout: PrevoutVector
): BitcoinRawTx => {
  const transaction = new Transaction()
  transaction.addInput(Buffer.alloc(32), 0xffffffff)

  for (let i = 0; i <= prevout.vout; i++) {
    transaction.addOutput(
      Buffer.from(i === prevout.vout ? prevout.scriptPubKeyHex : "51", "hex"),
      i === prevout.vout ? Number(prevout.valueSats) : 1
    )
  }

  return { transactionHex: transaction.toHex() }
}

class CountingSubmitter implements P2TRSignatureFraudChallengeSubmitter {
  calls = 0

  async submitSignatureFraudChallenge(): Promise<string> {
    this.calls++
    return "11".repeat(32)
  }
}

class InMemoryReplayStore implements P2TRWatchtowerChallengeReplayStore {
  private readonly records = new Map<
    string,
    P2TRWatchtowerChallengeRecordJSON
  >()
  saves = 0

  constructor(records: P2TRWatchtowerChallengeRecordJSON[] = []) {
    for (const record of records) {
      this.records.set(record.observationID, JSON.parse(JSON.stringify(record)))
    }
  }

  async getChallengeRecord(
    observationID: Hex
  ): Promise<P2TRWatchtowerChallengeRecord | undefined> {
    const record = this.records.get(observationID.toString())
    return record === undefined
      ? undefined
      : deserializeP2TRWatchtowerChallengeRecord(
          JSON.parse(JSON.stringify(record))
        )
  }

  async saveChallengeRecord(
    record: P2TRWatchtowerChallengeRecord
  ): Promise<void> {
    this.saves++
    const serialized = serializeP2TRWatchtowerChallengeRecord(record)
    this.records.set(
      serialized.observationID,
      JSON.parse(JSON.stringify(serialized))
    )
  }

  async listChallengeRecords(): Promise<P2TRWatchtowerChallengeRecord[]> {
    return [...this.records.values()].map((record) =>
      deserializeP2TRWatchtowerChallengeRecord(
        JSON.parse(JSON.stringify(record))
      )
    )
  }

  snapshot(): P2TRWatchtowerChallengeRecordJSON[] {
    return JSON.parse(JSON.stringify([...this.records.values()]))
  }

  get size(): number {
    return this.records.size
  }
}

const createWatchtower = (store: P2TRWatchtowerChallengeReplayStore) =>
  new P2TRSignatureFraudWatchtower(
    store,
    [annexVector.walletIDHex],
    undefined,
    () => P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
    undefined,
    bridgeChallengeDomain
  )

const extractAnnexObservation = (): P2TRSignatureFraudWitnessObservation => {
  const observation = extractP2TRSignatureFraudWitnessObservations(
    buildAnnexTransaction(),
    toObservationPrevouts(),
    [annexVector.walletIDHex],
    undefined,
    () => P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
    undefined,
    bridgeChallengeDomain
  ).find(({ inputIndex }) => inputIndex === annexVector.signedInputIndex)

  if (observation === undefined) {
    throw new Error("Missing annex-bearing P2TR watchtower observation")
  }

  return observation
}

const expectDisabledRejection = async (operation: Promise<unknown>) => {
  try {
    await operation
  } catch (error) {
    expect(error).to.be.instanceOf(Error)
    expect((error as Error).message).to.include("bounded/no-go")
    return
  }

  throw new Error("Expected P2TR signature-fraud no-go rejection")
}

describe("P2TR signature-fraud bounded/no-go submission boundary", () => {
  it("rejects public watchtower submission without touching the store or submitter", async () => {
    const store = new InMemoryReplayStore()
    const submitter = new CountingSubmitter()
    const watchtower = createWatchtower(store)

    await expectDisabledRejection(
      watchtower.submitChallenge(extractAnnexObservation(), submitter, {
        allowedSpendTypes: [P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION],
      })
    )

    expect(store.size).to.equal(0)
    expect(store.saves).to.equal(0)
    expect(submitter.calls).to.equal(0)
  })

  it("rejects submit-enabled runner construction before invoking its submitter", () => {
    const store = new InMemoryReplayStore()
    const submitter = new CountingSubmitter()

    expect(
      () =>
        new P2TRSignatureFraudWatchtowerRunner(
          createWatchtower(store),
          {} as BitcoinClient,
          submitter,
          { submitChallenges: true }
        )
    ).to.throw("bounded/no-go")

    expect(store.size).to.equal(0)
    expect(store.saves).to.equal(0)
    expect(submitter.calls).to.equal(0)
  })

  it("keeps the explicit COMPLETE_V2 submitter available for annex evidence", async () => {
    const observation = extractAnnexObservation()
    const calls: {
      action: number
      payload: string
      walletMembersIDs: number[]
      value: unknown
    }[] = []
    const submitter = new P2TRSignatureFraudBridgeChallengeSubmitter(
      {
        async processP2TRSignatureFraudChallenge(
          action,
          payload,
          walletMembersIDs,
          overrides
        ) {
          calls.push({
            action,
            payload,
            walletMembersIDs,
            value: overrides.value,
          })
          return {
            hash: `0x${"33".repeat(32)}`,
            async wait() {
              return { status: 1 }
            },
          }
        },
      },
      { challengeDepositAmount: 17 }
    )

    const txHash = await submitter.submitSignatureFraudChallenge(observation)
    expect(utils.arrayify(calls[0].payload)).to.have.lengthOf(224)
    const [decodedEvidence] = utils.defaultAbiCoder.decode(
      [completeBridgeChallengeEvidenceAbiType],
      calls[0].payload
    )

    expect(txHash).to.equal(`0x${"33".repeat(32)}`)
    expect(calls).to.have.lengthOf(1)
    expect(calls[0].action).to.equal(P2TR_SIGNATURE_FRAUD_BRIDGE_ACTION_SUBMIT)
    expect(calls[0].walletMembersIDs).to.deep.equal([])
    expect(String(calls[0].value)).to.equal("17")
    expect(observation.annex?.toString()).to.equal(annexVector.annexHex)
    expect(decodedEvidence.sighash).to.equal(
      observation.sighash.toPrefixedString()
    )
  })

  it("keeps annex observation, confirmation, restart replay, and integrated cycles observation-only", async () => {
    const store = new InMemoryReplayStore()
    const submitter = new CountingSubmitter()
    const rawTransaction = buildAnnexTransaction()
    const bitcoinTxHash = Transaction.fromHex(
      rawTransaction.transactionHex
    ).getId()
    const bitcoinClient = {
      async getRawTransaction(txid: Hex): Promise<BitcoinRawTx> {
        const prevout = annexVector.prevouts.find(
          (candidate) => candidate.txidHex === txid.toString()
        )
        if (prevout === undefined) {
          throw new Error("Unknown P2TR no-go test prevout")
        }

        return rawPreviousTransactionForPrevout(prevout)
      },
    } as BitcoinClient
    const runner = new P2TRSignatureFraudWatchtowerRunner(
      createWatchtower(store),
      bitcoinClient,
      submitter
    )

    const mempool = await runner.processMempoolTransaction(
      rawTransaction,
      bitcoinTxHash
    )
    const confirmed = await runner.processConfirmedTransaction(
      rawTransaction,
      bitcoinTxHash,
      "bb".repeat(32),
      144
    )
    const annexMempool = mempool.find(
      ({ observation }) =>
        observation.inputIndex === annexVector.signedInputIndex
    )
    const annexConfirmed = confirmed.find(
      ({ observation }) =>
        observation.inputIndex === annexVector.signedInputIndex
    )

    expect(annexMempool?.observation.annex?.toString()).to.equal(
      annexVector.annexHex
    )
    expect(annexConfirmed?.observation.annex?.toString()).to.equal(
      annexVector.annexHex
    )
    expect(
      mempool.every(({ record, submissionRecord }) =>
        Object.is(record, submissionRecord)
      )
    ).to.equal(true)
    expect(
      confirmed.every(({ record, submissionRecord }) =>
        Object.is(record, submissionRecord)
      )
    ).to.equal(true)

    const restartedStore = new InMemoryReplayStore(store.snapshot())
    const restartedRunner = new P2TRSignatureFraudWatchtowerRunner(
      createWatchtower(restartedStore),
      bitcoinClient,
      submitter
    )
    const replayed = await restartedRunner.replayStoredChallengeRecords(
      restartedStore
    )
    expect(replayed).to.have.lengthOf(3)
    expect(
      replayed.every(({ record, submissionRecord }) =>
        Object.is(record, submissionRecord)
      )
    ).to.equal(true)
    const replayedAnnex = replayed.find(
      ({ observation }) =>
        observation.inputIndex === annexVector.signedInputIndex
    )
    expect(replayedAnnex?.observation.annex?.toString()).to.equal(
      annexVector.annexHex
    )

    const integrated = await restartedRunner.processWatchtowerSourcesSettled(
      {
        async listMempoolTransactions() {
          return []
        },
        async listConfirmedTransactions() {
          return { transactions: [], complete: true }
        },
      },
      {
        async listBridgeLifecycleEvents() {
          return []
        },
      },
      restartedStore
    )

    expect(integrated.replayed).to.have.lengthOf(3)
    expect(integrated.mempool.submissions).to.deep.equal([])
    expect(integrated.confirmed.submissions).to.deep.equal([])
    expect(submitter.calls).to.equal(0)
  })
})
