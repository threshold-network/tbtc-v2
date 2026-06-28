/* eslint-disable @typescript-eslint/no-unused-expressions */

import fs from "fs"
import path from "path"

import { BigNumber, ContractTransaction } from "ethers"
import { ethers, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import chai, { expect } from "chai"
import { FakeContract, smock } from "@defi-wonderland/smock"
import type {
  Bridge,
  BridgeStub,
  IWalletRegistry,
  P2TRSignatureFraudRouter,
} from "../../typechain"
import bridgeFixture from "../fixtures/bridge"
import { ecdsaWalletTestData } from "../data/ecdsa"
import { walletState } from "../fixtures"

chai.use(smock.matchers)

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime, increaseTime } = helpers.time
const { defaultAbiCoder, keccak256 } = ethers.utils

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
  expectedBip341SighashHex: string
  witnessSignatureHex: string
  expectedBridgeChallengeIdentityHex: string
}

type SignatureFraudVectorCorpus = {
  cases: SignatureFraudVector[]
}

type ParsedTransactionInput = {
  txid: string
  vout: number
  sequence: number
}

type ParsedTransactionOutput = {
  valueSats: string
  scriptPubKey: string
}

const vectorCorpusPath = path.resolve(
  __dirname,
  "../../../docs/test-vectors/p2tr-signature-fraud-v0.json"
)

const p2trFraudAction = {
  Submit: 0,
  Defeat: 1,
  Timeout: 2,
} as const

const p2trLifecycleInterface = new ethers.utils.Interface([
  "event P2TRSignatureFraudChallengeSubmitted(bytes32 indexed walletID, bytes20 indexed walletPubKeyHash, bytes32 indexed bridgeChallengeIdentity, uint256 challengeKey, bytes32 sighash)",
  "event P2TRSignatureFraudChallengeDefeated(bytes32 indexed walletID, bytes20 indexed walletPubKeyHash, bytes32 indexed bridgeChallengeIdentity, uint256 challengeKey, bytes32 sighash)",
  "event P2TRSignatureFraudChallengeDefeatTimedOut(bytes32 indexed walletID, bytes20 indexed walletPubKeyHash, bytes32 indexed bridgeChallengeIdentity, uint256 challengeKey, bytes32 sighash)",
])

const payloadType =
  "tuple(bytes32 walletID,uint32 version,uint32 locktime,tuple(bytes32 txid,uint32 vout,uint32 sequence)[] inputs,tuple(uint64 valueSats,bytes scriptPubKey)[] prevouts,tuple(uint64 valueSats,bytes scriptPubKey)[] outputs,uint32 signedInputIndex,bool annexPresent,bytes witnessSignature)"

const hex = (value: string): string => `0x${value}`

const mutateLastByte = (value: string): string => {
  const replacement = value.endsWith("00") ? "01" : "00"
  return `${value.slice(0, -2)}${replacement}`
}

const readCompactSize = (
  buffer: Buffer,
  offset: number
): { value: number; nextOffset: number } => {
  const first = buffer[offset]

  if (first < 0xfd) {
    return { value: first, nextOffset: offset + 1 }
  }

  if (first === 0xfd) {
    return { value: buffer.readUInt16LE(offset + 1), nextOffset: offset + 3 }
  }

  if (first === 0xfe) {
    return { value: buffer.readUInt32LE(offset + 1), nextOffset: offset + 5 }
  }

  const value = buffer.readBigUInt64LE(offset + 1)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("CompactSize exceeds safe integer range")
  }

  return { value: Number(value), nextOffset: offset + 9 }
}

const parseUnsignedTransaction = (
  unsignedTransactionHex: string
): {
  version: number
  locktime: number
  inputs: ParsedTransactionInput[]
  outputs: ParsedTransactionOutput[]
} => {
  const buffer = Buffer.from(unsignedTransactionHex, "hex")
  let offset = 0

  const version = buffer.readUInt32LE(offset)
  offset += 4

  const inputCount = readCompactSize(buffer, offset)
  offset = inputCount.nextOffset

  const inputs = Array.from({ length: inputCount.value }, () => {
    const txid = buffer.subarray(offset, offset + 32).toString("hex")
    offset += 32

    const vout = buffer.readUInt32LE(offset)
    offset += 4

    const scriptSigSize = readCompactSize(buffer, offset)
    offset = scriptSigSize.nextOffset + scriptSigSize.value

    const sequence = buffer.readUInt32LE(offset)
    offset += 4

    return { txid, vout, sequence }
  })

  const outputCount = readCompactSize(buffer, offset)
  offset = outputCount.nextOffset

  const outputs = Array.from({ length: outputCount.value }, () => {
    const valueSats = buffer.readBigUInt64LE(offset).toString()
    offset += 8

    const scriptPubKeySize = readCompactSize(buffer, offset)
    offset = scriptPubKeySize.nextOffset

    const scriptPubKey = buffer
      .subarray(offset, offset + scriptPubKeySize.value)
      .toString("hex")
    offset += scriptPubKeySize.value

    return { valueSats, scriptPubKey }
  })

  const locktime = buffer.readUInt32LE(offset)
  offset += 4

  if (offset !== buffer.length) {
    throw new Error("Unexpected trailing transaction bytes")
  }

  return { version, locktime, inputs, outputs }
}

const loadVectorCorpus = (): SignatureFraudVectorCorpus =>
  JSON.parse(
    fs.readFileSync(vectorCorpusPath, "utf8")
  ) as SignatureFraudVectorCorpus

const vectorPayload = (
  vector: SignatureFraudVector,
  options: { witnessSignatureHex?: string; annexPresent?: boolean } = {}
) => {
  const parsedTransaction = parseUnsignedTransaction(
    vector.unsignedTransactionHex
  )

  return {
    walletID: hex(vector.walletIDHex),
    version: parsedTransaction.version,
    locktime: parsedTransaction.locktime,
    inputs: parsedTransaction.inputs.map((input) => ({
      txid: hex(input.txid),
      vout: input.vout,
      sequence: input.sequence,
    })),
    prevouts: vector.prevouts.map((prevout) => ({
      valueSats: BigNumber.from(prevout.valueSats.toString()),
      scriptPubKey: hex(prevout.scriptPubKeyHex),
    })),
    outputs: parsedTransaction.outputs.map((output) => ({
      valueSats: BigNumber.from(output.valueSats),
      scriptPubKey: hex(output.scriptPubKey),
    })),
    signedInputIndex: vector.signedInputIndex,
    annexPresent: options.annexPresent ?? false,
    witnessSignature: hex(
      options.witnessSignatureHex ?? vector.witnessSignatureHex
    ),
  }
}

type BridgeChallengePayload = ReturnType<typeof vectorPayload>

const encodePayload = (payload: ReturnType<typeof vectorPayload>): string =>
  defaultAbiCoder.encode([payloadType], [payload])

const signedInputUtxo = (payload: BridgeChallengePayload) => {
  const signedInput = payload.inputs[payload.signedInputIndex]
  const signedPrevout = payload.prevouts[payload.signedInputIndex]

  return {
    txHash: signedInput.txid,
    txOutputIndex: signedInput.vout,
    txOutputValue: signedPrevout.valueSats,
  }
}

const buildBridgeChallengeKey = async (
  bridgeAddress: string,
  bridgeChallengeIdentity: string
): Promise<BigNumber> => {
  const { chainId } = await ethers.provider.getNetwork()

  return BigNumber.from(
    keccak256(
      defaultAbiCoder.encode(
        ["string", "uint256", "address", "bytes32"],
        [
          "tbtc-p2tr-signature-fraud-bridge-key-v0",
          chainId,
          bridgeAddress,
          bridgeChallengeIdentity,
        ]
      )
    )
  )
}

const p2trWalletPubKeyHash = (walletID: string): string =>
  ethers.utils.hexDataSlice(keccak256(walletID), 0, 20)

const findP2TREvent = async (
  tx: ContractTransaction,
  bridgeAddress: string,
  eventName: string
): Promise<ethers.utils.LogDescription> => {
  const receipt = await tx.wait()
  const topic = p2trLifecycleInterface.getEventTopic(eventName)
  const eventLog = receipt.logs.find(
    (log) => log.address === bridgeAddress && log.topics[0] === topic
  )

  expect(eventLog, `${eventName} log`).to.not.be.undefined

  return p2trLifecycleInterface.parseLog(eventLog!)
}

// Pre/post balance delta helper. Avoids `changeEtherBalance(contract, ...)`
// which is flaky across Waffle versions for TypeChain Contract instances
// (some versions call `account.getAddress()`, others want `account.provider`).
// Reads the balance at the block before and after the tx; for the tx
// sender, adds back the gas cost so the assertion compares the
// transferred amount (matching Waffle's `changeEtherBalance` semantics).
async function expectBalanceDelta(
  tx: ContractTransaction,
  target: { address: string } | string,
  expectedDelta: BigNumber
) {
  const address = typeof target === "string" ? target : target.address
  const before = await ethers.provider.getBalance(address, tx.blockNumber! - 1)
  const after = await ethers.provider.getBalance(address, tx.blockNumber!)
  let delta = after.sub(before)
  if (address.toLowerCase() === tx.from.toLowerCase()) {
    const receipt = await tx.wait()
    delta = delta.add(receipt.gasUsed.mul(receipt.effectiveGasPrice))
  }
  expect(delta).to.equal(expectedDelta)
}

describe("Bridge - P2TR signature fraud", () => {
  const vectorCorpus = loadVectorCorpus()
  const vector = vectorCorpus.cases[0]
  const multiInputVector = vectorCorpus.cases.find(
    ({ id }) => id === "bip341-keypath-sighash-default-multi-input-multi-output"
  )!

  let thirdParty: SignerWithAddress
  let treasury: SignerWithAddress
  let walletRegistry: FakeContract<IWalletRegistry>
  let bridge: Bridge & BridgeStub
  let p2trFraudRouter: P2TRSignatureFraudRouter
  let fraudChallengeDepositAmount: BigNumber
  let fraudChallengeDefeatTimeout: number
  let fraudSlashingAmount: BigNumber
  let fraudNotifierRewardMultiplier: number

  before(async () => {
    const fixture = await waffle.loadFixture(bridgeFixture)
    thirdParty = fixture.thirdParty
    treasury = fixture.treasury
    walletRegistry = fixture.walletRegistry
    bridge = fixture.bridge
    p2trFraudRouter = fixture.p2trFraudRouter

    const fraudParameters = await bridge.fraudParameters()
    fraudChallengeDepositAmount = fraudParameters.fraudChallengeDepositAmount
    fraudChallengeDefeatTimeout = fraudParameters.fraudChallengeDefeatTimeout
    fraudSlashingAmount = fraudParameters.fraudSlashingAmount
    fraudNotifierRewardMultiplier =
      fraudParameters.fraudNotifierRewardMultiplier
  })

  beforeEach(async () => {
    await createSnapshot()
  })

  afterEach(async () => {
    walletRegistry.closeWallet.reset()
    walletRegistry.seize.reset()

    await restoreSnapshot()
  })

  const registerP2TRWallet = async (
    walletID: string,
    state: number = walletState.Live
  ): Promise<string> => {
    const walletPubKeyHash = p2trWalletPubKeyHash(walletID)

    await bridge.setWalletPubKeyHashForWalletID(walletID, walletPubKeyHash)
    await bridge.setWallet(walletPubKeyHash, {
      ecdsaWalletID: ecdsaWalletTestData.walletID,
      mainUtxoHash: ethers.constants.HashZero,
      pendingRedemptionsValue: 0,
      createdAt: await lastBlockTime(),
      movingFundsRequestedAt: 0,
      closingStartedAt: 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state,
      movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
    })

    return walletPubKeyHash
  }

  const submitChallenge = async (
    payload = vectorPayload(vector),
    challengeVector = vector
  ): Promise<{
    tx: ContractTransaction
    bridgeChallengeIdentity: string
    challengeKey: BigNumber
  }> => {
    const bridgeChallengeIdentity = hex(
      challengeVector.expectedBridgeChallengeIdentityHex
    )
    const challengeKey = await buildBridgeChallengeKey(
      bridge.address,
      bridgeChallengeIdentity
    )
    const tx = await p2trFraudRouter
      .connect(thirdParty)
      .processP2TRSignatureFraudChallenge(
        p2trFraudAction.Submit,
        encodePayload(payload),
        [],
        { value: fraudChallengeDepositAmount }
      )

    return { tx, bridgeChallengeIdentity, challengeKey }
  }

  it("submits and stores a P2TR signature-fraud challenge", async () => {
    const payload = vectorPayload(vector)
    const walletPubKeyHash = await registerP2TRWallet(payload.walletID)
    const { tx, bridgeChallengeIdentity, challengeKey } = await submitChallenge(
      payload
    )

    await expectBalanceDelta(
      tx,
      p2trFraudRouter.address,
      fraudChallengeDepositAmount
    )

    const fraudChallenge = await p2trFraudRouter.fraudChallenges(challengeKey)
    expect(fraudChallenge.challenger).to.equal(await thirdParty.getAddress())
    expect(fraudChallenge.depositAmount).to.equal(fraudChallengeDepositAmount)
    expect(fraudChallenge.reportedAt).to.equal(await lastBlockTime())
    expect(fraudChallenge.resolved).to.equal(false)

    const event = await findP2TREvent(
      tx,
      p2trFraudRouter.address,
      "P2TRSignatureFraudChallengeSubmitted"
    )
    expect(event.args.walletID).to.equal(payload.walletID)
    expect(event.args.walletPubKeyHash).to.equal(walletPubKeyHash)
    expect(event.args.bridgeChallengeIdentity).to.equal(bridgeChallengeIdentity)
    expect(event.args.challengeKey).to.equal(challengeKey)
    expect(event.args.sighash).to.equal(hex(vector.expectedBip341SighashHex))
  })

  it("submits a bounded multi-input multi-output P2TR signature-fraud challenge", async () => {
    const payload = vectorPayload(multiInputVector)
    const walletPubKeyHash = await registerP2TRWallet(payload.walletID)
    const { tx, bridgeChallengeIdentity, challengeKey } = await submitChallenge(
      payload,
      multiInputVector
    )

    const fraudChallenge = await p2trFraudRouter.fraudChallenges(challengeKey)
    expect(fraudChallenge.reportedAt).to.equal(await lastBlockTime())
    expect(fraudChallenge.resolved).to.equal(false)

    const event = await findP2TREvent(
      tx,
      p2trFraudRouter.address,
      "P2TRSignatureFraudChallengeSubmitted"
    )
    expect(event.args.walletID).to.equal(payload.walletID)
    expect(event.args.walletPubKeyHash).to.equal(walletPubKeyHash)
    expect(event.args.bridgeChallengeIdentity).to.equal(bridgeChallengeIdentity)
    expect(event.args.challengeKey).to.equal(challengeKey)
    expect(event.args.sighash).to.equal(
      hex(multiInputVector.expectedBip341SighashHex)
    )
  })

  it("rejects duplicate P2TR signature-fraud challenges", async () => {
    const payload = vectorPayload(vector)
    await registerP2TRWallet(payload.walletID)
    await submitChallenge(payload)

    await expect(
      p2trFraudRouter
        .connect(thirdParty)
        .processP2TRSignatureFraudChallenge(
          p2trFraudAction.Submit,
          encodePayload(payload),
          [],
          { value: fraudChallengeDepositAmount }
        )
    ).to.be.revertedWith("Fraud challenge already exists")
  })

  it("rejects P2TR challenges for unknown wallets before storage", async () => {
    const payload = vectorPayload(vector)
    const bridgeChallengeIdentity = hex(
      vector.expectedBridgeChallengeIdentityHex
    )
    const challengeKey = await buildBridgeChallengeKey(
      bridge.address,
      bridgeChallengeIdentity
    )

    await expect(
      p2trFraudRouter
        .connect(thirdParty)
        .processP2TRSignatureFraudChallenge(
          p2trFraudAction.Submit,
          encodePayload(payload),
          [],
          { value: fraudChallengeDepositAmount }
        )
    ).to.be.revertedWith("Wallet ID is unknown")

    expect(
      (await p2trFraudRouter.fraudChallenges(challengeKey)).reportedAt
    ).to.equal(0)
  })

  it("rejects P2TR challenges for inactive wallets", async () => {
    const payload = vectorPayload(vector)
    await registerP2TRWallet(payload.walletID, walletState.Terminated)

    await expect(
      p2trFraudRouter
        .connect(thirdParty)
        .processP2TRSignatureFraudChallenge(
          p2trFraudAction.Submit,
          encodePayload(payload),
          [],
          { value: fraudChallengeDepositAmount }
        )
    ).to.be.revertedWith(
      "Wallet must be in Live or MovingFunds or Closing state"
    )
  })

  it("rejects P2TR challenges with invalid BIP340 signatures", async () => {
    const payload = vectorPayload(vector, {
      witnessSignatureHex: mutateLastByte(vector.witnessSignatureHex),
    })
    await registerP2TRWallet(payload.walletID)

    await expect(
      p2trFraudRouter
        .connect(thirdParty)
        .processP2TRSignatureFraudChallenge(
          p2trFraudAction.Submit,
          encodePayload(payload),
          [],
          { value: fraudChallengeDepositAmount }
        )
    ).to.be.revertedWith("Signature verification failure")
  })

  const payloadBoundRejectionScenarios: {
    name: string
    mutatePayload: (payload: BridgeChallengePayload) => BridgeChallengePayload
    revertMessage: string
  }[] = [
    {
      name: "prevout count mismatch",
      mutatePayload: (payload) => ({
        ...payload,
        prevouts: [],
      }),
      revertMessage: "Prevout count mismatch",
    },
    {
      name: "signed input out of range",
      mutatePayload: (payload) => ({
        ...payload,
        signedInputIndex: payload.inputs.length,
      }),
      revertMessage: "Signed input out of range",
    },
    {
      name: "annex-present witnesses",
      mutatePayload: (payload) => ({
        ...payload,
        annexPresent: true,
      }),
      revertMessage: "Annex not supported",
    },
    {
      name: "oversized prevout script",
      mutatePayload: (payload) => ({
        ...payload,
        prevouts: [
          {
            ...payload.prevouts[0],
            scriptPubKey: `0x${"00".repeat(35)}`,
          },
          ...payload.prevouts.slice(1),
        ],
      }),
      revertMessage: "Prevout script too large",
    },
    {
      name: "oversized output script",
      mutatePayload: (payload) => ({
        ...payload,
        outputs: [
          {
            ...payload.outputs[0],
            scriptPubKey: `0x${"00".repeat(35)}`,
          },
          ...payload.outputs.slice(1),
        ],
      }),
      revertMessage: "Output script too large",
    },
  ]

  for (const scenario of payloadBoundRejectionScenarios) {
    it(`rejects P2TR challenges with ${scenario.name} before signature verification`, async () => {
      const payload = vectorPayload(vector)
      await registerP2TRWallet(payload.walletID)

      await expect(
        p2trFraudRouter
          .connect(thirdParty)
          .processP2TRSignatureFraudChallenge(
            p2trFraudAction.Submit,
            encodePayload(scenario.mutatePayload(payload)),
            [],
            { value: fraudChallengeDepositAmount }
          )
      ).to.be.revertedWith(scenario.revertMessage)
    })
  }

  // The router must accept protocol-realistic shapes with more than two inputs
  // or outputs (redemption batches, moving-funds fan-out, multi-input sweeps).
  // The shape check no longer rejects them, so an altered shape reaches -- and
  // fails -- signature verification instead of being rejected as "Too many".
  const acceptedLargerShapeScenarios: {
    name: string
    mutatePayload: (payload: BridgeChallengePayload) => BridgeChallengePayload
  }[] = [
    {
      name: "more than two inputs",
      mutatePayload: (payload) => ({
        ...payload,
        inputs: [...payload.inputs, payload.inputs[0], payload.inputs[0]],
        prevouts: [
          ...payload.prevouts,
          payload.prevouts[0],
          payload.prevouts[0],
        ],
      }),
    },
    {
      name: "more than two outputs",
      mutatePayload: (payload) => ({
        ...payload,
        outputs: [...payload.outputs, payload.outputs[0], payload.outputs[0]],
      }),
    },
  ]

  for (const scenario of acceptedLargerShapeScenarios) {
    it(`accepts P2TR challenges with ${scenario.name} past the shape check`, async () => {
      const payload = vectorPayload(vector)
      await registerP2TRWallet(payload.walletID)

      await expect(
        p2trFraudRouter
          .connect(thirdParty)
          .processP2TRSignatureFraudChallenge(
            p2trFraudAction.Submit,
            encodePayload(scenario.mutatePayload(payload)),
            [],
            { value: fraudChallengeDepositAmount }
          )
      ).to.be.revertedWith("Signature verification failure")
    })
  }

  for (const action of [
    p2trFraudAction.Submit,
    p2trFraudAction.Defeat,
    p2trFraudAction.Timeout,
  ]) {
    it(`rejects oversized raw P2TR action ${action} payloads before ABI decode`, async () => {
      await expect(
        p2trFraudRouter
          .connect(thirdParty)
          .processP2TRSignatureFraudChallenge(
            action,
            `0x${"00".repeat(262145)}`,
            [],
            {
              value:
                action === p2trFraudAction.Submit
                  ? fraudChallengeDepositAmount
                  : 0,
              // The payload exceeds P2TRSignatureFraudMaxPayloadBytes so the call
              // reverts at the early length check before ABI decode. Set the gas
              // limit explicitly: eth_estimateGas cannot price a tx that always
              // reverts and otherwise falls back above the block gas limit for a
              // calldata this large.
              gasLimit: 29000000,
            }
          )
      ).to.be.revertedWith("P2TR payload too large")
    })
  }

  const honestSpendDefeatScenarios: {
    name: string
    markHonestSpend: (
      payload: BridgeChallengePayload,
      walletPubKeyHash: string
    ) => Promise<unknown>
  }[] = [
    {
      name: "swept deposit",
      markHonestSpend: async (payload) =>
        bridge.setSweptDeposits([signedInputUtxo(payload)]),
    },
    {
      name: "spent main UTXO",
      markHonestSpend: async (payload) =>
        bridge.setSpentMainUtxos([signedInputUtxo(payload)]),
    },
    {
      name: "processed moved-funds sweep request",
      markHonestSpend: async (payload) =>
        bridge.setProcessedMovedFundsSweepRequests([signedInputUtxo(payload)]),
    },
  ]

  for (const scenario of honestSpendDefeatScenarios) {
    it(`defeats a P2TR challenge after the signed input is a ${scenario.name}`, async () => {
      const payload = vectorPayload(vector)
      const walletPubKeyHash = await registerP2TRWallet(payload.walletID)
      const { challengeKey, bridgeChallengeIdentity } = await submitChallenge(
        payload
      )

      await scenario.markHonestSpend(payload, walletPubKeyHash)

      const tx = await p2trFraudRouter
        .connect(thirdParty)
        .processP2TRSignatureFraudChallenge(
          p2trFraudAction.Defeat,
          encodePayload(payload),
          []
        )

      await expectBalanceDelta(tx, treasury, fraudChallengeDepositAmount)

      expect((await p2trFraudRouter.fraudChallenges(challengeKey)).resolved).to
        .be.true

      const event = await findP2TREvent(
        tx,
        p2trFraudRouter.address,
        "P2TRSignatureFraudChallengeDefeated"
      )
      expect(event.args.walletID).to.equal(payload.walletID)
      expect(event.args.walletPubKeyHash).to.equal(walletPubKeyHash)
      expect(event.args.bridgeChallengeIdentity).to.equal(
        bridgeChallengeIdentity
      )
      expect(event.args.challengeKey).to.equal(challengeKey)
      expect(event.args.sighash).to.equal(hex(vector.expectedBip341SighashHex))
    })
  }

  it("rejects P2TR defeat before the signed input is proven honestly spent", async () => {
    const payload = vectorPayload(vector)
    await registerP2TRWallet(payload.walletID)
    await submitChallenge(payload)

    await expect(
      p2trFraudRouter
        .connect(thirdParty)
        .processP2TRSignatureFraudChallenge(
          p2trFraudAction.Defeat,
          encodePayload(payload),
          []
        )
    ).to.be.revertedWith("Spent UTXO not found among correctly spent UTXOs")
  })

  it("rejects P2TR defeat when only a different outpoint is proven honestly spent", async () => {
    const payload = vectorPayload(vector)
    await registerP2TRWallet(payload.walletID)
    await submitChallenge(payload)
    const wrongOutpoint = signedInputUtxo(payload)

    await bridge.setSpentMainUtxos([
      {
        ...wrongOutpoint,
        txOutputIndex: wrongOutpoint.txOutputIndex + 1,
      },
    ])

    await expect(
      p2trFraudRouter
        .connect(thirdParty)
        .processP2TRSignatureFraudChallenge(
          p2trFraudAction.Defeat,
          encodePayload(payload),
          []
        )
    ).to.be.revertedWith("Spent UTXO not found among correctly spent UTXOs")
  })

  const movedFundsNonDefeatScenarios: {
    name: string
    markMovedFundsRequest: (
      payload: BridgeChallengePayload,
      walletPubKeyHash: string
    ) => Promise<unknown>
  }[] = [
    {
      name: "pending",
      markMovedFundsRequest: async (payload, walletPubKeyHash) =>
        bridge.setPendingMovedFundsSweepRequest(
          walletPubKeyHash,
          signedInputUtxo(payload)
        ),
    },
    {
      name: "timed out",
      markMovedFundsRequest: async (payload, walletPubKeyHash) => {
        const utxo = signedInputUtxo(payload)
        await bridge.setPendingMovedFundsSweepRequest(walletPubKeyHash, utxo)

        return bridge.timeoutPendingMovedFundsSweepRequest(
          walletPubKeyHash,
          utxo
        )
      },
    },
  ]

  for (const scenario of movedFundsNonDefeatScenarios) {
    it(`rejects P2TR defeat when the moved-funds sweep request is ${scenario.name}`, async () => {
      const payload = vectorPayload(vector)
      const walletPubKeyHash = await registerP2TRWallet(payload.walletID)
      await submitChallenge(payload)

      await scenario.markMovedFundsRequest(payload, walletPubKeyHash)

      await expect(
        p2trFraudRouter
          .connect(thirdParty)
          .processP2TRSignatureFraudChallenge(
            p2trFraudAction.Defeat,
            encodePayload(payload),
            []
          )
      ).to.be.revertedWith("Spent UTXO not found among correctly spent UTXOs")
    })
  }

  it("resolves timeout, refunds deposit, and slashes the P2TR wallet alias", async () => {
    const payload = vectorPayload(vector)
    const walletPubKeyHash = await registerP2TRWallet(payload.walletID)
    const { challengeKey, bridgeChallengeIdentity } = await submitChallenge(
      payload
    )
    const walletMembersIDs = [1, 2, 3]

    await increaseTime(fraudChallengeDefeatTimeout)

    const tx = await p2trFraudRouter
      .connect(thirdParty)
      .processP2TRSignatureFraudChallenge(
        p2trFraudAction.Timeout,
        encodePayload(payload),
        walletMembersIDs
      )

    await expectBalanceDelta(
      tx,
      p2trFraudRouter.address,
      fraudChallengeDepositAmount.mul(-1)
    )
    await expectBalanceDelta(tx, thirdParty, fraudChallengeDepositAmount)
    expect((await p2trFraudRouter.fraudChallenges(challengeKey)).resolved).to.be
      .true
    expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
      walletState.Terminated
    )
    expect(walletRegistry.seize).to.have.been.calledOnceWith(
      fraudSlashingAmount,
      fraudNotifierRewardMultiplier,
      await thirdParty.getAddress(),
      ecdsaWalletTestData.walletID,
      walletMembersIDs
    )

    const event = await findP2TREvent(
      tx,
      p2trFraudRouter.address,
      "P2TRSignatureFraudChallengeDefeatTimedOut"
    )
    expect(event.args.walletID).to.equal(payload.walletID)
    expect(event.args.walletPubKeyHash).to.equal(walletPubKeyHash)
    expect(event.args.bridgeChallengeIdentity).to.equal(bridgeChallengeIdentity)
    expect(event.args.challengeKey).to.equal(challengeKey)
    expect(event.args.sighash).to.equal(hex(vector.expectedBip341SighashHex))
  })

  it("rejects later P2TR timeout or defeat after an honest-spend defeat", async () => {
    const payload = vectorPayload(vector)
    await registerP2TRWallet(payload.walletID)
    await submitChallenge(payload)

    await bridge.setSpentMainUtxos([signedInputUtxo(payload)])
    await p2trFraudRouter
      .connect(thirdParty)
      .processP2TRSignatureFraudChallenge(
        p2trFraudAction.Defeat,
        encodePayload(payload),
        []
      )

    await increaseTime(fraudChallengeDefeatTimeout)

    await expect(
      p2trFraudRouter
        .connect(thirdParty)
        .processP2TRSignatureFraudChallenge(
          p2trFraudAction.Timeout,
          encodePayload(payload),
          [1, 2, 3]
        )
    ).to.be.revertedWith("Fraud challenge has already been resolved")

    await expect(
      p2trFraudRouter
        .connect(thirdParty)
        .processP2TRSignatureFraudChallenge(
          p2trFraudAction.Defeat,
          encodePayload(payload),
          []
        )
    ).to.be.revertedWith("Fraud challenge has already been resolved")
  })

  it("rejects later P2TR defeat or repeated timeout after timeout resolution", async () => {
    const payload = vectorPayload(vector)
    await registerP2TRWallet(payload.walletID)
    await submitChallenge(payload)

    await increaseTime(fraudChallengeDefeatTimeout)
    await p2trFraudRouter
      .connect(thirdParty)
      .processP2TRSignatureFraudChallenge(
        p2trFraudAction.Timeout,
        encodePayload(payload),
        [1, 2, 3]
      )

    await bridge.setSpentMainUtxos([signedInputUtxo(payload)])

    await expect(
      p2trFraudRouter
        .connect(thirdParty)
        .processP2TRSignatureFraudChallenge(
          p2trFraudAction.Defeat,
          encodePayload(payload),
          []
        )
    ).to.be.revertedWith("Fraud challenge has already been resolved")

    await expect(
      p2trFraudRouter
        .connect(thirdParty)
        .processP2TRSignatureFraudChallenge(
          p2trFraudAction.Timeout,
          encodePayload(payload),
          [1, 2, 3]
        )
    ).to.be.revertedWith("Fraud challenge has already been resolved")
  })

  it("records a first local gas envelope for the bounded draft payload", async () => {
    const payload = vectorPayload(vector)
    const encodedPayload = encodePayload(payload)
    await registerP2TRWallet(payload.walletID)

    const submitGas = await p2trFraudRouter
      .connect(thirdParty)
      .estimateGas.processP2TRSignatureFraudChallenge(
        p2trFraudAction.Submit,
        encodedPayload,
        [],
        { value: fraudChallengeDepositAmount }
      )

    const { challengeKey } = await submitChallenge(payload)

    await bridge.setSpentMainUtxos([signedInputUtxo(payload)])

    const defeatGas = await p2trFraudRouter
      .connect(thirdParty)
      .estimateGas.processP2TRSignatureFraudChallenge(
        p2trFraudAction.Defeat,
        encodedPayload,
        []
      )

    await increaseTime(fraudChallengeDefeatTimeout)

    const timeoutGas = await p2trFraudRouter
      .connect(thirdParty)
      .estimateGas.processP2TRSignatureFraudChallenge(
        p2trFraudAction.Timeout,
        encodedPayload,
        [1, 2, 3]
      )

    // eslint-disable-next-line no-console
    console.log(`p2tr_submitChallenge_gas=${submitGas.toString()}`)
    // eslint-disable-next-line no-console
    console.log(`p2tr_defeatChallenge_gas=${defeatGas.toString()}`)
    // eslint-disable-next-line no-console
    console.log(`p2tr_timeoutChallenge_gas=${timeoutGas.toString()}`)

    expect(submitGas.toNumber()).to.be.lessThan(6000000)
    expect(defeatGas.toNumber()).to.be.lessThan(1000000)
    expect(timeoutGas.toNumber()).to.be.lessThan(1500000)
  })

  it("records a local submit gas envelope for the bounded multi-input draft payload", async () => {
    const payload = vectorPayload(multiInputVector)
    const encodedPayload = encodePayload(payload)
    await registerP2TRWallet(payload.walletID)

    const submitGas = await p2trFraudRouter
      .connect(thirdParty)
      .estimateGas.processP2TRSignatureFraudChallenge(
        p2trFraudAction.Submit,
        encodedPayload,
        [],
        { value: fraudChallengeDepositAmount }
      )

    // eslint-disable-next-line no-console
    console.log(`p2tr_multiInputSubmitChallenge_gas=${submitGas.toString()}`)

    expect(submitGas.toNumber()).to.be.lessThan(7000000)
  })
})
