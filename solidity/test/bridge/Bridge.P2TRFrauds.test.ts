/* eslint-disable @typescript-eslint/no-unused-expressions */

import fs from "fs"
import path from "path"

import { BigNumber, ContractTransaction, Signer } from "ethers"
import { ethers, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import chai, { expect } from "chai"
import { FakeContract, smock } from "@defi-wonderland/smock"
import type {
  Bridge,
  BridgeLifecycleRouter,
  BridgeStub,
  FrostWalletRegistryStub,
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
const fullSighashVectorCorpusPath = path.resolve(
  __dirname,
  "../../../docs/test-vectors/p2tr-signature-fraud-full-sighash-v0.json"
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
  "tuple(bytes32 walletID,uint32 version,uint32 locktime,tuple(bytes32 txid,uint32 vout,uint32 sequence)[] inputs,tuple(uint64 valueSats,bytes scriptPubKey)[] prevouts,tuple(uint64 valueSats,bytes scriptPubKey)[] outputs,uint32 signedInputIndex,bytes witnessSignature,bytes annex)"

const hex = (value: string): string => `0x${value}`

async function expectCustomError(
  promise: Promise<unknown>,
  errorName: string
): Promise<void> {
  const expectedSelector = ethers.utils.id(`${errorName}()`).slice(0, 10)

  try {
    await promise
  } catch (err) {
    const errAny = err as {
      data?: string
      message?: string
      error?: { data?: string }
    }
    const revertData = errAny.data || errAny.error?.data || ""
    const errMsg = errAny.message || String(err)

    if (
      (revertData &&
        revertData.toLowerCase().startsWith(expectedSelector.toLowerCase())) ||
      errMsg.toLowerCase().includes(expectedSelector.toLowerCase()) ||
      errMsg.includes(errorName)
    ) {
      return
    }

    throw new Error(
      `expected revert with custom error ${errorName} ` +
        `(selector ${expectedSelector}), got: ${errMsg}`
    )
  }

  throw new Error(
    `expected revert with custom error ${errorName} but tx succeeded`
  )
}

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

const loadVectorCorpus = (
  corpusPath = vectorCorpusPath
): SignatureFraudVectorCorpus =>
  JSON.parse(fs.readFileSync(corpusPath, "utf8")) as SignatureFraudVectorCorpus

const vectorPayload = (
  vector: SignatureFraudVector,
  options: { witnessSignatureHex?: string; annexHex?: string } = {}
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
    witnessSignature: hex(
      options.witnessSignatureHex ?? vector.witnessSignatureHex
    ),
    annex: options.annexHex ?? "0x",
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
  const distinctWalletVector = vectorCorpus.cases.find(
    ({ walletIDHex }) => walletIDHex !== vector.walletIDHex
  )
  const sighashNoneVector = loadVectorCorpus(
    fullSighashVectorCorpusPath
  ).cases.find(({ id }) => id === "bip341-keypath-none-multi")!
  if (!distinctWalletVector) {
    throw new Error("P2TR fraud vector corpus needs two distinct wallets")
  }

  let thirdParty: SignerWithAddress
  let treasury: SignerWithAddress
  let walletRegistry: FakeContract<IWalletRegistry>
  let bridge: Bridge & BridgeStub
  let bridgeSigner: Signer
  let frostWalletRegistry: FrostWalletRegistryStub
  let lifecycleRouter: BridgeLifecycleRouter
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

    const FrostWalletRegistryStubFactory = await ethers.getContractFactory(
      "FrostWalletRegistryStub"
    )
    frostWalletRegistry =
      (await FrostWalletRegistryStubFactory.deploy()) as FrostWalletRegistryStub
    await frostWalletRegistry.deployed()

    const BridgeLifecycleRouterFactory = await ethers.getContractFactory(
      "BridgeLifecycleRouter"
    )
    lifecycleRouter = (await BridgeLifecycleRouterFactory.deploy(
      bridge.address
    )) as BridgeLifecycleRouter
    await lifecycleRouter.deployed()

    await bridge.resetFrostWalletRegistryForTest(frostWalletRegistry.address)
    await bridge.resetLifecycleRouterForTest(lifecycleRouter.address)
    await frostWalletRegistry.setLifecycleOwner(lifecycleRouter.address)

    await ethers.provider.send("hardhat_impersonateAccount", [bridge.address])
    await ethers.provider.send("hardhat_setBalance", [
      bridge.address,
      ethers.utils.hexValue(ethers.utils.parseEther("100")),
    ])
    bridgeSigner = await ethers.getSigner(bridge.address)

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

  const registerClosingFrostWallet = async (
    challengeVector: SignatureFraudVector,
    remainingClosingTime: number
  ): Promise<string> => {
    const walletID = hex(challengeVector.walletIDHex)

    await frostWalletRegistry.callBridgeFrostWalletCreatedCallback(
      bridge.address,
      walletID
    )

    const walletPubKeyHash = await bridge.walletPubKeyHashForWalletID(walletID)
    const { walletClosingPeriod } = await bridge.walletParameters()
    const now = await lastBlockTime()

    await bridge.setWallet(walletPubKeyHash, {
      ecdsaWalletID: ethers.constants.HashZero,
      mainUtxoHash: ethers.constants.HashZero,
      pendingRedemptionsValue: 0,
      createdAt: now,
      movingFundsRequestedAt: 0,
      closingStartedAt: now - walletClosingPeriod + remainingClosingTime,
      pendingMovedFundsSweepRequestsCount: 0,
      state: walletState.Closing,
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

  const expectChallengeCounters = async (
    walletPubKeyHash: string,
    expectedWalletCount: number,
    expectedUnattributedCount: number,
    expectedTotalCount: number
  ): Promise<void> => {
    expect(
      await p2trFraudRouter.openFraudChallengeCountByWallet(walletPubKeyHash)
    ).to.equal(expectedWalletCount)
    expect(
      await p2trFraudRouter.unattributedOpenFraudChallengeCount()
    ).to.equal(expectedUnattributedCount)
    expect(await p2trFraudRouter.openFraudChallengeCount()).to.equal(
      expectedTotalCount
    )
    expect(
      await p2trFraudRouter.hasOpenFraudChallengeForWallet(walletPubKeyHash)
    ).to.equal(expectedWalletCount > 0 || expectedUnattributedCount > 0)
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
    await expectChallengeCounters(walletPubKeyHash, 1, 0, 1)

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

  it("submits a deposit-spend challenge using the committed Taproot output key", async () => {
    const payload = {
      ...vectorPayload(vector),
      walletID: hex(distinctWalletVector.walletIDHex),
    }
    const walletPubKeyHash = await registerP2TRWallet(payload.walletID)

    const signedPrevout = payload.prevouts[payload.signedInputIndex]
    const outputKey = ethers.utils.hexDataSlice(signedPrevout.scriptPubKey, 2)
    await bridge.setTaprootDepositOutputKeyCommitment(
      signedInputUtxo(payload),
      payload.walletID,
      outputKey
    )

    const tx = await p2trFraudRouter
      .connect(thirdParty)
      .processP2TRSignatureFraudChallenge(
        p2trFraudAction.Submit,
        encodePayload(payload),
        [],
        { value: fraudChallengeDepositAmount }
      )

    const event = await findP2TREvent(
      tx,
      p2trFraudRouter.address,
      "P2TRSignatureFraudChallengeSubmitted"
    )
    expect(event.args.walletID).to.equal(payload.walletID)
    expect(event.args.walletPubKeyHash).to.equal(walletPubKeyHash)
  })

  it("rejects a deposit output key committed to a different registered wallet", async () => {
    const payload = {
      ...vectorPayload(vector),
      walletID: hex(distinctWalletVector.walletIDHex),
    }
    await registerP2TRWallet(payload.walletID)

    const signedPrevout = payload.prevouts[payload.signedInputIndex]
    const outputKey = ethers.utils.hexDataSlice(signedPrevout.scriptPubKey, 2)
    await bridge.setTaprootDepositOutputKeyCommitment(
      signedInputUtxo(payload),
      hex(vector.walletIDHex),
      outputKey
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
    ).to.be.revertedWith("Taproot deposit key mismatch")
  })

  it("rejects a different deposit output key committed to the registered wallet", async () => {
    const payload = {
      ...vectorPayload(vector),
      walletID: hex(distinctWalletVector.walletIDHex),
    }
    await registerP2TRWallet(payload.walletID)

    const signedPrevout = payload.prevouts[payload.signedInputIndex]
    const outputKey = ethers.utils.hexDataSlice(signedPrevout.scriptPubKey, 2)
    await bridge.setTaprootDepositOutputKeyCommitment(
      signedInputUtxo(payload),
      payload.walletID,
      mutateLastByte(outputKey)
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
    ).to.be.revertedWith("Taproot deposit key mismatch")
  })

  it("rejects a committed deposit whose signed prevout is not P2TR", async () => {
    const basePayload = vectorPayload(vector)
    const payload = {
      ...basePayload,
      walletID: hex(distinctWalletVector.walletIDHex),
      prevouts: basePayload.prevouts.map((prevout, index) =>
        index === basePayload.signedInputIndex
          ? {
              ...prevout,
              scriptPubKey: `0x0014${"00".repeat(20)}`,
            }
          : prevout
      ),
    }
    await registerP2TRWallet(payload.walletID)

    const originalOutputKey = ethers.utils.hexDataSlice(
      basePayload.prevouts[basePayload.signedInputIndex].scriptPubKey,
      2
    )
    await bridge.setTaprootDepositOutputKeyCommitment(
      signedInputUtxo(payload),
      payload.walletID,
      originalOutputKey
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
    ).to.be.revertedWith("Taproot deposit prevout must be P2TR")
  })

  it("cannot verify a deposit-specific signature before its commitment exists", async () => {
    const payload = {
      ...vectorPayload(vector),
      walletID: hex(distinctWalletVector.walletIDHex),
    }
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

  it("submits a multi-input deposit challenge using only the signed outpoint commitment", async () => {
    const payload = {
      ...vectorPayload(multiInputVector),
      walletID: hex(distinctWalletVector.walletIDHex),
    }
    const walletPubKeyHash = await registerP2TRWallet(payload.walletID)
    const signedPrevout = payload.prevouts[payload.signedInputIndex]
    const outputKey = ethers.utils.hexDataSlice(signedPrevout.scriptPubKey, 2)
    await bridge.setTaprootDepositOutputKeyCommitment(
      signedInputUtxo(payload),
      payload.walletID,
      outputKey
    )

    const tx = await p2trFraudRouter
      .connect(thirdParty)
      .processP2TRSignatureFraudChallenge(
        p2trFraudAction.Submit,
        encodePayload(payload),
        [],
        { value: fraudChallengeDepositAmount }
      )

    const event = await findP2TREvent(
      tx,
      p2trFraudRouter.address,
      "P2TRSignatureFraudChallengeSubmitted"
    )
    expect(event.args.walletID).to.equal(payload.walletID)
    expect(event.args.walletPubKeyHash).to.equal(walletPubKeyHash)
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

  it("rejects an equivalent SIGHASH_NONE representation as a duplicate", async () => {
    const payload = vectorPayload(sighashNoneVector)
    const equivalentPayload = {
      ...payload,
      // SIGHASH_NONE leaves every output unauthenticated. A caller can change
      // this representation while preserving the exact wallet signature.
      outputs: payload.outputs.map((output, index) =>
        index === 0 ? { ...output, valueSats: output.valueSats.add(1) } : output
      ),
    }

    await registerP2TRWallet(payload.walletID)
    await submitChallenge(payload, sighashNoneVector)

    await expect(
      p2trFraudRouter
        .connect(thirdParty)
        .processP2TRSignatureFraudChallenge(
          p2trFraudAction.Submit,
          encodePayload(equivalentPayload),
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
      name: "malformed annex (missing 0x50 prefix)",
      mutatePayload: (payload) => ({
        ...payload,
        annex: "0x00",
      }),
      revertMessage: "Annex must start with 0x50",
    },
    // The base vector is a 64-byte SIGHASH_DEFAULT witness. SIGHASH_NONE (0x02),
    // SIGHASH_SINGLE (0x03) and the ANYONECANPAY variants (0x81/0x82/0x83) are
    // now in scope and adjudicated via the multi-mode sighash. The remaining
    // rejected 65-byte encoding is the explicit, non-canonical SIGHASH_DEFAULT
    // (0x00 trailing byte), which BIP-341 forbids; it must be refused at
    // `parseWitnessSignature`, before signature checking, never mis-verified.
    {
      name: "non-canonical explicit-SIGHASH_DEFAULT witness",
      mutatePayload: (payload) => ({
        ...payload,
        witnessSignature: `${payload.witnessSignature}00`,
      }),
      revertMessage: "Unsupported witness sighash type",
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

  // The shape caps accept up to 128 inputs/outputs (see P2TRSignatureFraudRouter
  // for why 128 and not higher). A maximum-size but valid shape must reconstruct
  // on-chain within the block gas limit: the linear BIP-341 sighash
  // reconstruction makes 128 in/out reach signature verification with margin
  // (empirically ~192 is the edge, 256+ runs out of gas), whereas a higher cap
  // would exhaust gas before the challenge is recorded.
  it("builds the challenge identity for a maximum-size (128 in/out) shape within gas", async () => {
    const base = vectorPayload(vector)
    await registerP2TRWallet(base.walletID)

    const count = 128
    const maxShapePayload = {
      ...base,
      inputs: Array.from({ length: count }, () => base.inputs[0]),
      prevouts: Array.from({ length: count }, () => base.prevouts[0]),
      outputs: Array.from({ length: count }, () => base.outputs[0]),
      signedInputIndex: 0,
    }

    await expect(
      p2trFraudRouter
        .connect(thirdParty)
        .processP2TRSignatureFraudChallenge(
          p2trFraudAction.Submit,
          encodePayload(maxShapePayload),
          [],
          { value: fraudChallengeDepositAmount, gasLimit: 29500000 }
        )
    ).to.be.revertedWith("Signature verification failure")
  })

  // One past the cap must be rejected cheaply at the shape check (before the
  // encoder/sighash run), so an oversized payload cannot grief the challenger.
  it("rejects P2TR challenges that exceed the 128 input/output caps", async () => {
    const base = vectorPayload(vector)
    await registerP2TRWallet(base.walletID)

    const tooManyInputs = {
      ...base,
      inputs: Array.from({ length: 129 }, () => base.inputs[0]),
      prevouts: Array.from({ length: 129 }, () => base.prevouts[0]),
      signedInputIndex: 0,
    }
    await expect(
      p2trFraudRouter
        .connect(thirdParty)
        .processP2TRSignatureFraudChallenge(
          p2trFraudAction.Submit,
          encodePayload(tooManyInputs),
          [],
          { value: fraudChallengeDepositAmount, gasLimit: 29500000 }
        )
    ).to.be.revertedWith("Too many inputs")

    const tooManyOutputs = {
      ...base,
      outputs: Array.from({ length: 129 }, () => base.outputs[0]),
    }
    await expect(
      p2trFraudRouter
        .connect(thirdParty)
        .processP2TRSignatureFraudChallenge(
          p2trFraudAction.Submit,
          encodePayload(tooManyOutputs),
          [],
          { value: fraudChallengeDepositAmount, gasLimit: 29500000 }
        )
    ).to.be.revertedWith("Too many outputs")
  })

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
            `0x${"00".repeat(131073)}`,
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
      await expectChallengeCounters(walletPubKeyHash, 0, 0, 0)

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

  it("blocks FROST wallet closure until its P2TR challenge times out", async () => {
    const payload = vectorPayload(vector)
    const remainingClosingTime = Math.floor(fraudChallengeDefeatTimeout / 2)
    const walletPubKeyHash = await registerClosingFrostWallet(
      vector,
      remainingClosingTime
    )
    const { challengeKey } = await submitChallenge(payload)
    await expectChallengeCounters(walletPubKeyHash, 1, 0, 1)

    await increaseTime(remainingClosingTime)

    await expectCustomError(
      bridge.notifyWalletClosingPeriodElapsed(walletPubKeyHash),
      "P2TRFraudChallengePending"
    )
    expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
      walletState.Closing
    )
    expect(await frostWalletRegistry.closeWalletCalled()).to.equal(false)

    await increaseTime(fraudChallengeDefeatTimeout - remainingClosingTime)
    await p2trFraudRouter
      .connect(thirdParty)
      .processP2TRSignatureFraudChallenge(
        p2trFraudAction.Timeout,
        encodePayload(payload),
        [1, 2, 3]
      )

    expect((await p2trFraudRouter.fraudChallenges(challengeKey)).resolved).to.be
      .true
    await expectChallengeCounters(walletPubKeyHash, 0, 0, 0)
    expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
      walletState.Terminated
    )
    expect(await frostWalletRegistry.seizeCalled()).to.equal(true)
    expect(await frostWalletRegistry.closeWalletCalled()).to.equal(true)
  })

  it("keeps the challenge active while refunding a contract challenger", async () => {
    const payload = vectorPayload(vector)
    const walletPubKeyHash = await registerClosingFrostWallet(
      vector,
      Math.floor(fraudChallengeDefeatTimeout / 2)
    )
    const ReentrantChallengerFactory = await ethers.getContractFactory(
      "ReentrantP2TRFraudChallenger"
    )
    const reentrantChallenger = await ReentrantChallengerFactory.deploy(
      p2trFraudRouter.address,
      bridge.address,
      walletPubKeyHash
    )
    await reentrantChallenger.deployed()

    const challengeKey = await buildBridgeChallengeKey(
      bridge.address,
      hex(vector.expectedBridgeChallengeIdentityHex)
    )
    await reentrantChallenger.submitFraudChallenge(encodePayload(payload), {
      value: fraudChallengeDepositAmount,
    })
    await expectChallengeCounters(walletPubKeyHash, 1, 0, 1)
    await increaseTime(fraudChallengeDefeatTimeout)

    const tx = await p2trFraudRouter
      .connect(thirdParty)
      .processP2TRSignatureFraudChallenge(
        p2trFraudAction.Timeout,
        encodePayload(payload),
        [1, 2, 3]
      )

    await expect(tx)
      .to.emit(reentrantChallenger, "ReentrantClosureAttempt")
      .withArgs(
        false,
        ethers.utils.id("P2TRFraudChallengePending()").slice(0, 10)
      )
    expect(
      await ethers.provider.getBalance(reentrantChallenger.address)
    ).to.equal(fraudChallengeDepositAmount)
    expect((await p2trFraudRouter.fraudChallenges(challengeKey)).resolved).to.be
      .true
    await expectChallengeCounters(walletPubKeyHash, 0, 0, 0)
    expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
      walletState.Terminated
    )
    expect(await frostWalletRegistry.seizeCalled()).to.equal(true)
    expect(await frostWalletRegistry.closeWalletCalled()).to.equal(true)
  })

  it("allows FROST wallet closure after its P2TR challenge is defeated", async () => {
    const payload = vectorPayload(vector)
    const remainingClosingTime = Math.floor(fraudChallengeDefeatTimeout / 2)
    const walletPubKeyHash = await registerClosingFrostWallet(
      vector,
      remainingClosingTime
    )
    await submitChallenge(payload)

    await bridge.setSpentMainUtxos([signedInputUtxo(payload)])
    await p2trFraudRouter
      .connect(thirdParty)
      .processP2TRSignatureFraudChallenge(
        p2trFraudAction.Defeat,
        encodePayload(payload),
        []
      )
    await expectChallengeCounters(walletPubKeyHash, 0, 0, 0)
    await increaseTime(remainingClosingTime)

    await bridge.notifyWalletClosingPeriodElapsed(walletPubKeyHash)

    expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
      walletState.Closed
    )
    expect(await frostWalletRegistry.closeWalletCalled()).to.equal(true)
    expect(await frostWalletRegistry.lastClosedWalletID()).to.equal(
      payload.walletID
    )
  })

  it("allows an unrelated FROST wallet to close while a P2TR challenge is open", async () => {
    const payload = vectorPayload(vector)
    const challengedWalletPubKeyHash = await registerClosingFrostWallet(
      vector,
      Math.floor(fraudChallengeDefeatTimeout / 2)
    )
    await submitChallenge(payload)
    await expectChallengeCounters(challengedWalletPubKeyHash, 1, 0, 1)

    const unrelatedWalletPubKeyHash = await registerClosingFrostWallet(
      distinctWalletVector,
      0
    )
    await expectChallengeCounters(unrelatedWalletPubKeyHash, 0, 0, 1)
    await bridge.notifyWalletClosingPeriodElapsed(unrelatedWalletPubKeyHash)

    expect((await bridge.wallets(unrelatedWalletPubKeyHash)).state).to.equal(
      walletState.Closed
    )
    expect((await bridge.wallets(challengedWalletPubKeyHash)).state).to.equal(
      walletState.Closing
    )
    expect(await frostWalletRegistry.lastClosedWalletID()).to.equal(
      hex(distinctWalletVector.walletIDHex)
    )
  })

  it("blocks graceful closure for unattributed migrated challenges without blocking fraud termination", async () => {
    const payload = vectorPayload(vector)
    const walletPubKeyHash = await registerClosingFrostWallet(vector, 0)
    const challengeKey = await buildBridgeChallengeKey(
      bridge.address,
      hex(vector.expectedBridgeChallengeIdentityHex)
    )
    const secondChallengeKey = challengeKey.add(1)
    const migratedChallenge = {
      challenger: await thirdParty.getAddress(),
      depositAmount: fraudChallengeDepositAmount,
      reportedAt: (await lastBlockTime()) - fraudChallengeDefeatTimeout,
      resolved: false,
    }

    await p2trFraudRouter
      .connect(bridgeSigner)
      .acceptMigration(
        [challengeKey, secondChallengeKey],
        [migratedChallenge, migratedChallenge],
        { value: fraudChallengeDepositAmount.mul(2) }
      )

    await expectChallengeCounters(walletPubKeyHash, 0, 2, 2)
    expect(
      await p2trFraudRouter.hasOpenFraudChallengeForWallet(
        p2trWalletPubKeyHash(hex(distinctWalletVector.walletIDHex))
      )
    ).to.equal(true)
    await expectCustomError(
      bridge.notifyWalletClosingPeriodElapsed(walletPubKeyHash),
      "P2TRFraudChallengePending"
    )
    expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
      walletState.Closing
    )

    await p2trFraudRouter
      .connect(thirdParty)
      .processP2TRSignatureFraudChallenge(
        p2trFraudAction.Timeout,
        encodePayload(payload),
        [1, 2, 3]
      )

    expect((await p2trFraudRouter.fraudChallenges(challengeKey)).resolved).to.be
      .true
    await expectChallengeCounters(walletPubKeyHash, 0, 1, 1)
    expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
      walletState.Terminated
    )
    expect(await frostWalletRegistry.seizeCalled()).to.equal(true)
    expect(await frostWalletRegistry.closeWalletCalled()).to.equal(true)
  })

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
    await expectChallengeCounters(walletPubKeyHash, 0, 0, 0)
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
