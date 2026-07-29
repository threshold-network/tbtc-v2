/* eslint-disable @typescript-eslint/no-unused-expressions */

import fs from "fs"
import path from "path"

import { BigNumber, Contract, Signer } from "ethers"
import { ethers, helpers } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import chai, { expect } from "chai"
import { FakeContract, smock } from "@defi-wonderland/smock"
import type {
  Bridge,
  BridgeStub,
  CompleteP2TRSignatureFraudRouter,
  IBridgeLifecycleRouter,
} from "../../typechain"
import bridgeFixture from "../fixtures/bridge"
import { walletState } from "../fixtures"
import { loadFixture } from "../helpers/fixture"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { increaseTime, lastBlockTime } = helpers.time
const { hexDataSlice, keccak256, toUtf8Bytes } = ethers.utils
const quarantinedWalletState = 6
const recoveryRequiredWalletState = 7

chai.use(smock.matchers)

type FraudVector = {
  id: string
  walletIDHex: string
  expectedBip341SighashHex: string
  witnessSignatureHex: string
  signedInputIndex: number
  prevouts: {
    txidHex: string
    vout: number
    valueSats: number | string
  }[]
}

type CompleteChallengeVector = {
  id: string
  sighashType: string
  walletKey: CompleteChallengeEvidenceVector
  tweakedDepositKey: CompleteChallengeEvidenceVector & {
    depositKey: string
    bindingCommitment: string
  }
}

type CompleteChallengeEvidenceVector = {
  walletID: string
  signingKey: string
  bindingTxHash: string
  bindingOutputIndex: number
  sighash: string
  nonceX: string
  signatureScalar: string
  encodedEvidence: string
  challengeIdentity: string
}

const hex = (value: string): string => `0x${value}`

const splitSignature = (witnessSignatureHex: string) => {
  // Explicit BIP341 hash-type suffixes are not part of the BIP340 signature.
  const signature = hex(witnessSignatureHex.slice(0, 128))
  return {
    nonceX: hexDataSlice(signature, 0, 32),
    signatureScalar: hexDataSlice(signature, 32, 64),
  }
}

describe("CompleteP2TRSignatureFraudRouter", () => {
  const defaultVectors = JSON.parse(
    fs.readFileSync(
      path.resolve(
        __dirname,
        "../../../docs/test-vectors/p2tr-signature-fraud-v0.json"
      ),
      "utf8"
    )
  ).cases as FraudVector[]
  const fullVectors = JSON.parse(
    fs.readFileSync(
      path.resolve(
        __dirname,
        "../../../docs/test-vectors/p2tr-signature-fraud-full-sighash-v0.json"
      ),
      "utf8"
    )
  ).cases as FraudVector[]
  const completeVectors = JSON.parse(
    fs.readFileSync(
      path.resolve(
        __dirname,
        "../../../docs/test-vectors/p2tr-complete-v2-challenge-evidence-v1.json"
      ),
      "utf8"
    )
  ) as {
    evidenceAbiTypes: string[]
    encodedEvidenceBytes: number
    challengeIdentity: {
      domain: string
      referenceDomain: { chainId: string; bridge: string }
    }
    cases: CompleteChallengeVector[]
  }

  const defaultVector = defaultVectors.find(({ id }) =>
    id.includes("default-single-input")
  )!
  const defaultMultiVector = fullVectors.find(({ id }) =>
    id.includes("default-multi")
  )!
  const noneMultiVector = fullVectors.find(({ id }) =>
    id.includes("none-multi")
  )!

  let bridge: Bridge & BridgeStub
  let router: CompleteP2TRSignatureFraudRouter
  let registry: Contract
  let lifecycleRouter: FakeContract<IBridgeLifecycleRouter>
  let bridgeSigner: Signer
  let challenger: SignerWithAddress
  let receiver: SignerWithAddress
  let challengeDeposit: BigNumber
  let challengeTimeout: number

  before(async () => {
    const fixture = await loadFixture(bridgeFixture)
    bridge = fixture.bridge
    challenger = fixture.thirdParty
    receiver = fixture.spvMaintainer

    await ethers.provider.send("hardhat_impersonateAccount", [bridge.address])
    await ethers.provider.send("hardhat_setBalance", [
      bridge.address,
      ethers.utils.hexValue(ethers.utils.parseEther("10")),
    ])
    bridgeSigner = await ethers.getSigner(bridge.address)

    const Registry = await ethers.getContractFactory(
      "P2TRAuthorizationRegistryStub"
    )
    registry = await Registry.deploy(bridge.address)
    await registry.deployed()

    const Router = await ethers.getContractFactory(
      "CompleteP2TRSignatureFraudRouter"
    )
    router = (await Router.deploy(
      bridge.address,
      registry.address
    )) as CompleteP2TRSignatureFraudRouter
    await router.deployed()

    // Timeout tests isolate Bridge state transitions from the FROST staking
    // system. The production lifecycle router is tested independently.
    lifecycleRouter = await smock.fake("IBridgeLifecycleRouter")
    await bridge.resetLifecycleRouterForTest(lifecycleRouter.address)
    await bridge.resetP2TRFraudRouterForTest(router.address)

    const parameters = await bridge.fraudParameters()
    challengeDeposit = parameters.fraudChallengeDepositAmount
    challengeTimeout = parameters.fraudChallengeDefeatTimeout
  })

  beforeEach(async () => {
    lifecycleRouter.seize.reset()
    await createSnapshot()
  })
  afterEach(async () => restoreSnapshot())

  const registerFrostWallet = async (
    walletID: string,
    state = walletState.Live,
    targetWalletsHash = ethers.constants.HashZero
  ): Promise<string> => {
    const walletPubKeyHash = hexDataSlice(keccak256(walletID), 0, 20)
    await bridge.setWalletPubKeyHashForWalletID(walletID, walletPubKeyHash)
    await bridge.setWalletIDForWalletPubKeyHash(walletPubKeyHash, walletID)
    await bridge.setWallet(walletPubKeyHash, {
      ecdsaWalletID: ethers.constants.HashZero,
      mainUtxoHash: ethers.constants.HashZero,
      pendingRedemptionsValue: 0,
      createdAt: await lastBlockTime(),
      movingFundsRequestedAt: state === walletState.MovingFunds ? 1 : 0,
      closingStartedAt: state === walletState.Closing ? 1 : 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state,
      movingFundsTargetWalletsCommitmentHash: targetWalletsHash,
    })
    return walletPubKeyHash
  }

  const evidenceFor = (
    vector: FraudVector,
    overrides: Partial<{
      walletID: string
      signingKey: string
      bindingTxHash: string
      bindingOutputIndex: number
    }> = {}
  ) => ({
    walletID: overrides.walletID ?? hex(vector.walletIDHex),
    signingKey: overrides.signingKey ?? hex(vector.walletIDHex),
    bindingTxHash: overrides.bindingTxHash ?? ethers.constants.HashZero,
    bindingOutputIndex: overrides.bindingOutputIndex ?? 0,
    sighash: hex(vector.expectedBip341SighashHex),
    ...splitSignature(vector.witnessSignatureHex),
  })

  const identityFor = (evidence: ReturnType<typeof evidenceFor>) => ({
    walletID: evidence.walletID,
    signingKey: evidence.signingKey,
    sighash: evidence.sighash,
  })

  const submit = async (
    evidence: ReturnType<typeof evidenceFor>,
    sender = challenger
  ) =>
    router.connect(sender).submitP2TRSignatureFraudChallenge(evidence, {
      value: challengeDeposit,
    })

  it("records a fixed identity, escrow, authorization cutoff, and quarantine", async () => {
    const evidence = evidenceFor(defaultVector)
    const walletPubKeyHash = await registerFrostWallet(evidence.walletID)
    const identity = await router.challengeIdentity(identityFor(evidence))
    const challengeKey = BigNumber.from(identity)

    await expect(submit(evidence))
      .to.emit(router, "CompleteP2TRSignatureFraudChallengeSubmitted")
      .withArgs(
        identity,
        evidence.walletID,
        evidence.signingKey,
        evidence.sighash,
        challengeKey,
        walletPubKeyHash,
        challenger.address,
        0
      )

    const challenge = await router.fraudChallenges(challengeKey)
    expect(challenge.challenger).to.equal(challenger.address)
    expect(challenge.depositAmount).to.equal(challengeDeposit)
    expect(
      await router.challengeAuthorizationSequenceCutoff(challengeKey)
    ).to.equal(0)
    expect(await router.openFraudChallengeCount()).to.equal(1)
    expect(await router.totalChallengeEscrow()).to.equal(challengeDeposit)
    expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
      quarantinedWalletState
    )
  })

  it("prevents an elapsed Closing wallet from escaping an open challenge", async () => {
    const evidence = evidenceFor(defaultVector)
    const walletPubKeyHash = await registerFrostWallet(
      evidence.walletID,
      walletState.Closing
    )

    await submit(evidence)

    expect(
      await router.openFraudChallengeCountByWallet(walletPubKeyHash)
    ).to.equal(1)
    expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
      quarantinedWalletState
    )
    await expect(
      bridge.notifyWalletClosingPeriodElapsed(walletPubKeyHash)
    ).to.be.revertedWith("Wallet must be in Closing state")
  })

  it("does not block an unrelated Closing wallet", async () => {
    const evidence = evidenceFor(defaultVector)
    const challengedWalletPubKeyHash = await registerFrostWallet(
      evidence.walletID,
      walletState.Closing
    )
    const unrelatedWalletID = keccak256(
      toUtf8Bytes("complete-v2-unrelated-closing-wallet")
    )
    const unrelatedWalletPubKeyHash = await registerFrostWallet(
      unrelatedWalletID,
      walletState.Closing
    )

    await submit(evidence)
    await bridge.notifyWalletClosingPeriodElapsed(unrelatedWalletPubKeyHash)

    expect(
      await router.hasOpenFraudChallengeForWallet(challengedWalletPubKeyHash)
    ).to.equal(true)
    expect(
      await router.hasOpenFraudChallengeForWallet(unrelatedWalletPubKeyHash)
    ).to.equal(false)
    expect((await bridge.wallets(unrelatedWalletPubKeyHash)).state).to.equal(
      walletState.Closed
    )
  })

  it("rejects a signature identity preauthorized before challenge admission", async () => {
    const evidence = evidenceFor(defaultVector)
    await registerFrostWallet(evidence.walletID)
    const identity = await router.challengeIdentity(identityFor(evidence))
    await registry.authorize(identity)

    expect(
      await registry.authorizationSequenceByChallengeIdentity(identity)
    ).to.equal(1)
    await expect(submit(evidence)).to.be.revertedWith(
      "P2TR authorization already accepted"
    )
  })

  it("never lets a retroactive authorization defeat an admitted challenge", async () => {
    const evidence = evidenceFor(defaultVector)
    const walletPubKeyHash = await registerFrostWallet(evidence.walletID)
    const identity = await router.challengeIdentity(identityFor(evidence))
    const challengeKey = BigNumber.from(identity)
    await submit(evidence)

    await registry.authorize(identity)
    expect(
      await registry.authorizationSequenceByChallengeIdentity(identity)
    ).to.equal(1)
    expect(
      await router.challengeAuthorizationSequenceCutoff(challengeKey)
    ).to.equal(0)

    await expect(
      router.defeatP2TRSignatureFraudChallenge(identityFor(evidence))
    ).to.be.revertedWith("P2TR authorization was not accepted before challenge")

    await increaseTime(challengeTimeout)
    await router.notifyP2TRSignatureFraudChallengeDefeatTimeout(
      identityFor(evidence),
      []
    )

    expect((await router.fraudChallenges(challengeKey)).resolved).to.be.true
    expect(await router.openFraudChallengeCount()).to.equal(0)
    expect(await router.totalChallengeEscrow()).to.equal(0)
    expect(
      await router.withdrawableP2TRFraudPayouts(challenger.address)
    ).to.equal(challengeDeposit)
    expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
      recoveryRequiredWalletState
    )
  })

  it("seizes after a reservation conflict put the wallet in recovery before challenge admission", async () => {
    const evidence = evidenceFor(defaultVector)
    const walletPubKeyHash = await registerFrostWallet(evidence.walletID)
    const resourceID = keccak256(toUtf8Bytes("pre-challenge-conflict-resource"))
    const reservationID = keccak256(
      toUtf8Bytes("pre-challenge-conflict-reservation")
    )
    await registry.setConflictingReservation(
      resourceID,
      reservationID,
      walletPubKeyHash,
      1
    )
    await bridge.settleP2TRProofForTest(
      keccak256(toUtf8Bytes("pre-challenge-conflict-proof")),
      1,
      walletPubKeyHash,
      [resourceID]
    )
    expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
      recoveryRequiredWalletState
    )

    await submit(evidence)
    await increaseTime(challengeTimeout)
    await router.notifyP2TRSignatureFraudChallengeDefeatTimeout(
      identityFor(evidence),
      []
    )

    expect(lifecycleRouter.seize).to.have.been.calledOnce
    expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
      recoveryRequiredWalletState
    )
  })

  it("seizes once after a reservation conflict put a quarantined wallet in recovery", async () => {
    const firstEvidence = evidenceFor(defaultMultiVector)
    const secondEvidence = evidenceFor(noneMultiVector)
    const walletPubKeyHash = await registerFrostWallet(firstEvidence.walletID)
    await submit(firstEvidence)
    await submit(secondEvidence)

    const resourceID = keccak256(
      toUtf8Bytes("open-challenge-conflict-resource")
    )
    const reservationID = keccak256(
      toUtf8Bytes("open-challenge-conflict-reservation")
    )
    await registry.setConflictingReservation(
      resourceID,
      reservationID,
      walletPubKeyHash,
      1
    )
    await bridge.settleP2TRProofForTest(
      keccak256(toUtf8Bytes("open-challenge-conflict-proof")),
      1,
      walletPubKeyHash,
      [resourceID]
    )
    expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
      recoveryRequiredWalletState
    )

    await increaseTime(challengeTimeout)
    await router.notifyP2TRSignatureFraudChallengeDefeatTimeout(
      identityFor(firstEvidence),
      []
    )
    await router.notifyP2TRSignatureFraudChallengeDefeatTimeout(
      identityFor(secondEvidence),
      []
    )

    expect(lifecycleRouter.seize).to.have.been.calledOnce
    expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
      recoveryRequiredWalletState
    )
  })

  it("reconciles an exact late-authorized moving-funds proof without clearing quarantine", async () => {
    const evidence = evidenceFor(defaultVector)
    const targetWalletsHash = keccak256(toUtf8Bytes("targets"))
    const walletPubKeyHash = await registerFrostWallet(
      evidence.walletID,
      walletState.MovingFunds,
      targetWalletsHash
    )
    await bridge.setWalletMainUtxo(walletPubKeyHash, {
      txHash: keccak256(toUtf8Bytes("main-utxo")),
      txOutputIndex: 3,
      txOutputValue: 1_000_000,
    })

    const identity = await router.challengeIdentity(identityFor(evidence))
    await submit(evidence)
    await registry.authorize(identity)

    const transactionHash = keccak256(toUtf8Bytes("authorized-moving-proof"))
    const reservationID = keccak256(toUtf8Bytes("moving-reservation"))
    await registry.setSettledVariant(
      transactionHash,
      reservationID,
      walletPubKeyHash,
      3
    )

    await bridge.reconcileAuthorizedMovingFundsProofForTest(
      walletPubKeyHash,
      transactionHash,
      targetWalletsHash
    )

    expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
      quarantinedWalletState
    )
    expect((await bridge.wallets(walletPubKeyHash)).mainUtxoHash).to.equal(
      ethers.constants.HashZero
    )
    expect(await router.openFraudChallengeCount()).to.equal(1)
    await expect(
      router.defeatP2TRSignatureFraudChallenge(identityFor(evidence))
    ).to.be.revertedWith("P2TR authorization was not accepted before challenge")
  })

  for (const fraudState of [
    quarantinedWalletState,
    recoveryRequiredWalletState,
  ]) {
    for (const action of [1, 2, 3, 4]) {
      it(`accepts only settled action ${action} in fraud state ${fraudState}`, async () => {
        const walletID = hex(defaultVector.walletIDHex)
        const walletPubKeyHash = await registerFrostWallet(walletID, fraudState)
        const transactionHash = keccak256(
          ethers.utils.defaultAbiCoder.encode(
            ["string", "uint8"],
            ["tx", action]
          )
        )
        const reservationID = keccak256(
          ethers.utils.defaultAbiCoder.encode(
            ["string", "uint8"],
            ["reservation", action]
          )
        )
        await registry.setSettledVariant(
          transactionHash,
          reservationID,
          walletPubKeyHash,
          action
        )

        await expect(
          bridge.requireP2TRProofWalletStateForTest(
            transactionHash,
            walletPubKeyHash,
            action
          )
        ).not.to.be.reverted
        await expect(
          bridge.requireP2TRProofWalletStateForTest(
            transactionHash,
            walletPubKeyHash,
            action === 4 ? 1 : action + 1
          )
        ).to.be.revertedWith("Fraud-state proof is not settled authorization")
      })
    }
  }

  it("applies a settled moving-funds proof in RecoveryRequired without restoring it", async () => {
    const walletID = hex(defaultVector.walletIDHex)
    const targetWalletsHash = keccak256(toUtf8Bytes("recovery-targets"))
    const walletPubKeyHash = await registerFrostWallet(
      walletID,
      recoveryRequiredWalletState,
      targetWalletsHash
    )
    await bridge.setWalletMainUtxo(walletPubKeyHash, {
      txHash: keccak256(toUtf8Bytes("recovery-main-utxo")),
      txOutputIndex: 5,
      txOutputValue: 2_000_000,
    })
    const transactionHash = keccak256(toUtf8Bytes("recovery-moving-proof"))
    const reservationID = keccak256(toUtf8Bytes("recovery-moving-reservation"))
    await registry.setSettledVariant(
      transactionHash,
      reservationID,
      walletPubKeyHash,
      3
    )

    await bridge.reconcileAuthorizedMovingFundsProofForTest(
      walletPubKeyHash,
      transactionHash,
      targetWalletsHash
    )
    expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
      recoveryRequiredWalletState
    )
    expect((await bridge.wallets(walletPubKeyHash)).mainUtxoHash).to.equal(
      ethers.constants.HashZero
    )
  })

  it("rejects an unreserved proof in Quarantined and RecoveryRequired", async () => {
    const walletID = hex(defaultVector.walletIDHex)
    const walletPubKeyHash = await registerFrostWallet(
      walletID,
      quarantinedWalletState
    )
    const transactionHash = keccak256(toUtf8Bytes("unreserved"))

    await expect(
      bridge.requireP2TRProofWalletStateForTest(
        transactionHash,
        walletPubKeyHash,
        1
      )
    ).to.be.revertedWith("Fraud-state proof is not settled authorization")

    await bridge.setWallet(walletPubKeyHash, {
      ecdsaWalletID: ethers.constants.HashZero,
      mainUtxoHash: ethers.constants.HashZero,
      pendingRedemptionsValue: 0,
      createdAt: await lastBlockTime(),
      movingFundsRequestedAt: 0,
      closingStartedAt: 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state: recoveryRequiredWalletState,
      movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
    })
    await expect(
      bridge.requireP2TRProofWalletStateForTest(
        transactionHash,
        walletPubKeyHash,
        2
      )
    ).to.be.revertedWith("Fraud-state proof is not settled authorization")
  })

  it("challenges explicit SIGHASH_NONE without treating its suffix as signature data", async () => {
    const evidence = evidenceFor(noneMultiVector)
    await registerFrostWallet(evidence.walletID)
    expect(noneMultiVector.witnessSignatureHex.length).to.equal(130)
    await expect(submit(evidence)).to.emit(
      router,
      "P2TRSignatureFraudChallengeSubmitted"
    )
  })

  it("matches fixed COMPLETE_V2 ABI, identity, and deposit-binding vectors", async () => {
    expect(completeVectors.encodedEvidenceBytes).to.equal(224)
    for (const vector of completeVectors.cases) {
      for (const evidence of [vector.walletKey, vector.tweakedDepositKey]) {
        const encoded = ethers.utils.defaultAbiCoder.encode(
          completeVectors.evidenceAbiTypes,
          [
            evidence.walletID,
            evidence.signingKey,
            evidence.bindingTxHash,
            evidence.bindingOutputIndex,
            evidence.sighash,
            evidence.nonceX,
            evidence.signatureScalar,
          ]
        )
        expect(encoded).to.equal(evidence.encodedEvidence)
        expect(ethers.utils.arrayify(encoded).length).to.equal(224)
        expect(
          ethers.utils.sha256(
            ethers.utils.solidityPack(
              ["string", "uint256", "address", "bytes32", "bytes32", "bytes32"],
              [
                completeVectors.challengeIdentity.domain,
                completeVectors.challengeIdentity.referenceDomain.chainId,
                completeVectors.challengeIdentity.referenceDomain.bridge,
                evidence.walletID,
                evidence.signingKey,
                evidence.sighash,
              ]
            )
          )
        ).to.equal(evidence.challengeIdentity)
      }
      expect(vector.tweakedDepositKey.depositKey).to.equal(
        BigNumber.from(
          ethers.utils.keccak256(
            ethers.utils.solidityPack(
              ["bytes32", "uint32"],
              [
                vector.tweakedDepositKey.bindingTxHash,
                vector.tweakedDepositKey.bindingOutputIndex,
              ]
            )
          )
        ).toString()
      )
      expect(vector.tweakedDepositKey.bindingCommitment).to.equal(
        ethers.utils.keccak256(
          ethers.utils.solidityPack(
            ["bytes32", "bytes32"],
            [
              vector.tweakedDepositKey.walletID,
              vector.tweakedDepositKey.signingKey,
            ]
          )
        )
      )
    }
  })

  it("accepts fixed wallet-key evidence for every covered BIP-341 hash mode", async () => {
    const { walletID } = completeVectors.cases[0].walletKey
    await registerFrostWallet(walletID)
    for (const { walletKey } of completeVectors.cases) {
      expect(walletKey.walletID).to.equal(walletID)
      expect(
        await router.challengeIdentity({
          walletID: walletKey.walletID,
          signingKey: walletKey.signingKey,
          sighash: walletKey.sighash,
        })
      ).to.equal(
        ethers.utils.sha256(
          ethers.utils.solidityPack(
            ["string", "uint256", "address", "bytes32", "bytes32", "bytes32"],
            [
              completeVectors.challengeIdentity.domain,
              await registry.domainChainID(),
              bridge.address,
              walletKey.walletID,
              walletKey.signingKey,
              walletKey.sighash,
            ]
          )
        )
      )
      await expect(
        router.processP2TRSignatureFraudChallenge(
          0,
          walletKey.encodedEvidence,
          [],
          { value: challengeDeposit }
        )
      ).to.emit(router, "CompleteP2TRSignatureFraudChallengeSubmitted")
    }
  })

  it("accepts fixed tweaked-key evidence for every covered BIP-341 hash mode", async () => {
    const { walletID } = completeVectors.cases[0].tweakedDepositKey
    await registerFrostWallet(walletID)
    const initializedBindings = new Set<string>()
    for (const { tweakedDepositKey } of completeVectors.cases) {
      const binding = `${tweakedDepositKey.bindingTxHash}:${tweakedDepositKey.bindingOutputIndex}`
      if (!initializedBindings.has(binding)) {
        await bridge.setTaprootDepositOutputKeyCommitment(
          {
            txHash: tweakedDepositKey.bindingTxHash,
            txOutputIndex: tweakedDepositKey.bindingOutputIndex,
            txOutputValue: 1,
          },
          tweakedDepositKey.walletID,
          tweakedDepositKey.signingKey
        )
        initializedBindings.add(binding)
      }
      await expect(
        router.processP2TRSignatureFraudChallenge(
          0,
          tweakedDepositKey.encodedEvidence,
          [],
          { value: challengeDeposit }
        )
      ).to.emit(router, "CompleteP2TRSignatureFraudChallengeSubmitted")
    }
  })

  it("rejects noncanonical evidence lengths and invalid base/tweaked bindings", async () => {
    const vector = completeVectors.cases[0]
    await registerFrostWallet(vector.walletKey.walletID)
    await expect(
      router.processP2TRSignatureFraudChallenge(
        0,
        ethers.utils.hexDataSlice(vector.walletKey.encodedEvidence, 0, 223),
        [],
        { value: challengeDeposit }
      )
    ).to.be.revertedWith("Invalid challenge evidence length")
    await expect(
      router.processP2TRSignatureFraudChallenge(
        0,
        `${vector.walletKey.encodedEvidence}00`,
        [],
        { value: challengeDeposit }
      )
    ).to.be.revertedWith("Invalid challenge evidence length")
    await expect(
      submit({
        ...vector.walletKey,
        bindingTxHash: vector.tweakedDepositKey.bindingTxHash,
      })
    ).to.be.revertedWith("Base wallet key must not have deposit binding")

    await registerFrostWallet(vector.tweakedDepositKey.walletID)
    await expect(
      submit({
        ...vector.tweakedDepositKey,
        bindingTxHash: ethers.constants.HashZero,
        bindingOutputIndex: 0,
      })
    ).to.be.revertedWith("Taproot deposit wallet binding not found")
  })

  it("binds a tweaked deposit signing key to one exact revealed outpoint", async () => {
    const walletID = ethers.utils.hexZeroPad("0x1234", 32)
    await registerFrostWallet(walletID)
    const prevout = defaultVector.prevouts[defaultVector.signedInputIndex]
    const signingKey = hex(defaultVector.walletIDHex)
    await bridge.setTaprootDepositOutputKeyCommitment(
      {
        txHash: hex(prevout.txidHex),
        txOutputIndex: prevout.vout,
        txOutputValue: prevout.valueSats,
      },
      walletID,
      signingKey
    )

    const evidence = evidenceFor(defaultVector, {
      walletID,
      signingKey,
      bindingTxHash: hex(prevout.txidHex),
      bindingOutputIndex: prevout.vout,
    })
    await expect(submit(evidence)).to.emit(
      router,
      "P2TRSignatureFraudChallengeSubmitted"
    )

    await expect(
      router
        .connect(challenger)
        .submitP2TRSignatureFraudChallenge(
          { ...evidence, bindingOutputIndex: prevout.vout + 1 },
          { value: challengeDeposit }
        )
    ).to.be.revertedWith("Taproot deposit wallet binding not found")
  })

  for (const terminalState of [walletState.Closed, walletState.Terminated]) {
    it(`slashes an archived wallet without changing terminal state ${terminalState}`, async () => {
      const evidence = evidenceFor(defaultVector)
      const walletPubKeyHash = await registerFrostWallet(
        evidence.walletID,
        terminalState
      )
      const identity = identityFor(evidence)
      const challengeKey = BigNumber.from(
        await router.challengeIdentity(identity)
      )
      const walletMembersIDs = [11, 22]

      await submit(evidence)
      expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
        terminalState
      )
      expect(lifecycleRouter.seize).not.to.have.been.called

      await increaseTime(challengeTimeout)
      await router.notifyP2TRSignatureFraudChallengeDefeatTimeout(
        identity,
        walletMembersIDs
      )

      const parameters = await bridge.fraudParameters()
      expect(lifecycleRouter.seize).to.have.been.calledOnceWith(
        walletPubKeyHash,
        parameters.fraudSlashingAmount,
        parameters.fraudNotifierRewardMultiplier,
        challenger.address,
        walletMembersIDs
      )
      expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
        terminalState
      )
      expect((await router.fraudChallenges(challengeKey)).resolved).to.be.true
      expect(await router.openFraudChallengeCount()).to.equal(0)
      expect(await router.totalChallengeEscrow()).to.equal(0)
      expect(
        await router.withdrawableP2TRFraudPayouts(challenger.address)
      ).to.equal(challengeDeposit)
    })
  }

  it("defeats an archived challenge without reopening its closed wallet", async () => {
    const evidence = evidenceFor(defaultVector)
    const walletPubKeyHash = await registerFrostWallet(
      evidence.walletID,
      walletState.Closed
    )
    const bridgeChallengeIdentity = await router.challengeIdentity(
      identityFor(evidence)
    )
    const challengeKey = BigNumber.from(bridgeChallengeIdentity)

    await registry.authorize(keccak256(toUtf8Bytes("earlier-authorization")))
    await submit(evidence)
    expect(
      await router.challengeAuthorizationSequenceCutoff(challengeKey)
    ).to.equal(1)

    await registry.setAuthorizationSequence(bridgeChallengeIdentity, 1)
    await router.defeatP2TRSignatureFraudChallenge(identityFor(evidence))

    expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
      walletState.Closed
    )
    expect(lifecycleRouter.seize).not.to.have.been.called
    expect((await router.fraudChallenges(challengeKey)).resolved).to.be.true
    expect(await router.openFraudChallengeCount()).to.equal(0)
    expect(
      await router.withdrawableP2TRFraudPayouts(await bridge.treasury())
    ).to.equal(challengeDeposit)
  })

  it("authenticates retained archived members before slashing", async () => {
    const evidence = evidenceFor(defaultVector)
    const walletPubKeyHash = await registerFrostWallet(
      evidence.walletID,
      walletState.Terminated
    )
    const walletMembersIDs = [31, 41, 59]
    const wrongWalletMembersIDs = [31, 41]

    const Registry = await ethers.getContractFactory("FrostWalletRegistryStub")
    const frostRegistry = await Registry.deploy()
    await frostRegistry.deployed()
    const LifecycleRouter = await ethers.getContractFactory(
      "BridgeLifecycleRouter"
    )
    const retainedLifecycleRouter = await LifecycleRouter.deploy(bridge.address)
    await retainedLifecycleRouter.deployed()
    await frostRegistry.setLifecycleOwner(retainedLifecycleRouter.address)
    await frostRegistry.setRetainedWalletMembersIdsHash(
      evidence.walletID,
      keccak256(
        ethers.utils.defaultAbiCoder.encode(["uint32[]"], [walletMembersIDs])
      )
    )
    await bridge.resetFrostWalletRegistryForTest(frostRegistry.address)
    await bridge.resetLifecycleRouterForTest(retainedLifecycleRouter.address)

    await submit(evidence)
    await increaseTime(challengeTimeout)
    await expect(
      router.notifyP2TRSignatureFraudChallengeDefeatTimeout(
        identityFor(evidence),
        wrongWalletMembersIDs
      )
    ).to.be.revertedWith("Invalid wallet members identifiers")

    const challengeKey = BigNumber.from(
      await router.challengeIdentity(identityFor(evidence))
    )
    expect((await router.fraudChallenges(challengeKey)).resolved).to.be.false
    expect(await router.openFraudChallengeCount()).to.equal(1)
    expect(await router.totalChallengeEscrow()).to.equal(challengeDeposit)
    expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
      walletState.Terminated
    )

    await router.notifyP2TRSignatureFraudChallengeDefeatTimeout(
      identityFor(evidence),
      walletMembersIDs
    )
    expect(await frostRegistry.seizeCalled()).to.be.true
    expect(await frostRegistry.lastSeizeWalletID()).to.equal(evidence.walletID)
    expect(
      (await frostRegistry.getLastSeizeWalletMembersIDs()).map(
        (memberID: BigNumber | number) => BigNumber.from(memberID).toNumber()
      )
    ).to.deep.equal(walletMembersIDs)
    expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
      walletState.Terminated
    )
  })

  it("slashes an archived wallet only once across multiple challenges", async () => {
    const firstEvidence = evidenceFor(defaultMultiVector)
    const secondEvidence = evidenceFor(noneMultiVector)
    const walletPubKeyHash = await registerFrostWallet(
      firstEvidence.walletID,
      walletState.Closed
    )

    await submit(firstEvidence)
    await submit(secondEvidence)
    await increaseTime(challengeTimeout)

    await router.notifyP2TRSignatureFraudChallengeDefeatTimeout(
      identityFor(firstEvidence),
      []
    )
    await router.notifyP2TRSignatureFraudChallengeDefeatTimeout(
      identityFor(secondEvidence),
      []
    )

    expect(lifecycleRouter.seize).to.have.been.calledOnce
    expect(
      await router.openFraudChallengeCountByWallet(walletPubKeyHash)
    ).to.equal(0)
    expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
      walletState.Closed
    )
    expect(
      await router.withdrawableP2TRFraudPayouts(challenger.address)
    ).to.equal(challengeDeposit.mul(2))
  })

  it("records timeout effects before an archived seize callback can reenter", async () => {
    const evidence = evidenceFor(defaultVector)
    const walletPubKeyHash = await registerFrostWallet(
      evidence.walletID,
      walletState.Terminated
    )
    const ReentrantLifecycleRouter = await ethers.getContractFactory(
      "ReentrantP2TRFraudLifecycleRouter"
    )
    const reentrantLifecycleRouter = await ReentrantLifecycleRouter.deploy(
      bridge.address,
      router.address
    )
    await reentrantLifecycleRouter.deployed()
    await bridge.resetLifecycleRouterForTest(reentrantLifecycleRouter.address)

    const identity = identityFor(evidence)
    await submit(evidence)
    await reentrantLifecycleRouter.configureReentry(
      router.interface.encodeFunctionData(
        "notifyP2TRSignatureFraudChallengeDefeatTimeout",
        [identity, []]
      )
    )
    await increaseTime(challengeTimeout)

    await router.notifyP2TRSignatureFraudChallengeDefeatTimeout(identity, [])

    expect(await reentrantLifecycleRouter.seizeCalls()).to.equal(1)
    expect(await reentrantLifecycleRouter.reentryAttempted()).to.be.true
    expect(await reentrantLifecycleRouter.reentrySucceeded()).to.be.false
    expect(await router.openFraudChallengeCount()).to.equal(0)
    expect(await router.totalChallengeEscrow()).to.equal(0)
    expect(
      await router.withdrawableP2TRFraudPayouts(challenger.address)
    ).to.equal(challengeDeposit)
    expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
      walletState.Terminated
    )
  })

  it("transitions to recovery once while resolving multiple same-wallet timeouts", async () => {
    const firstEvidence = evidenceFor(defaultMultiVector)
    const secondEvidence = evidenceFor(noneMultiVector)
    expect(firstEvidence.walletID).to.equal(secondEvidence.walletID)
    const walletPubKeyHash = await registerFrostWallet(firstEvidence.walletID)

    await submit(firstEvidence)
    await submit(secondEvidence)
    expect(
      await router.openFraudChallengeCountByWallet(walletPubKeyHash)
    ).to.equal(2)

    await increaseTime(challengeTimeout)
    await router.notifyP2TRSignatureFraudChallengeDefeatTimeout(
      identityFor(firstEvidence),
      []
    )
    expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
      recoveryRequiredWalletState
    )
    expect(
      await router.openFraudChallengeCountByWallet(walletPubKeyHash)
    ).to.equal(1)

    await router.notifyP2TRSignatureFraudChallengeDefeatTimeout(
      identityFor(secondEvidence),
      []
    )
    expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(
      recoveryRequiredWalletState
    )
    expect(await router.openFraudChallengeCount()).to.equal(0)
    expect(
      await router.withdrawableP2TRFraudPayouts(challenger.address)
    ).to.equal(challengeDeposit.mul(2))
  })

  it("credits a reverting challenger and lets it withdraw to another receiver", async () => {
    const evidence = evidenceFor(defaultVector)
    await registerFrostWallet(evidence.walletID)
    const Recipient = await ethers.getContractFactory(
      "RevertingP2TRFraudPayoutRecipient"
    )
    const recipient = await Recipient.deploy()
    await recipient.deployed()

    const submitData = router.interface.encodeFunctionData(
      "submitP2TRSignatureFraudChallenge",
      [evidence]
    )
    await recipient.forward(router.address, submitData, {
      value: challengeDeposit,
    })
    await increaseTime(challengeTimeout)
    await router.notifyP2TRSignatureFraudChallengeDefeatTimeout(
      identityFor(evidence),
      []
    )

    expect(
      await router.withdrawableP2TRFraudPayouts(recipient.address)
    ).to.equal(challengeDeposit)
    expect(await router.totalWithdrawablePayouts()).to.equal(challengeDeposit)

    await expect(
      recipient.withdraw(router.address, recipient.address)
    ).to.be.revertedWith("Payout transfer failed")
    expect(
      await router.withdrawableP2TRFraudPayouts(recipient.address)
    ).to.equal(challengeDeposit)

    await expect(() =>
      recipient.withdraw(router.address, receiver.address)
    ).to.changeEtherBalance(receiver, challengeDeposit)
    expect(
      await router.withdrawableP2TRFraudPayouts(recipient.address)
    ).to.equal(0)
    expect(await router.totalWithdrawablePayouts()).to.equal(0)
    expect(await ethers.provider.getBalance(router.address)).to.equal(0)
  })

  it("zeros payout accounting before a receiver can reenter", async () => {
    const evidence = evidenceFor(defaultVector)
    await registerFrostWallet(evidence.walletID)
    const Recipient = await ethers.getContractFactory(
      "ReentrantP2TRFraudPayoutRecipient"
    )
    const recipient = await Recipient.deploy(router.address)
    await recipient.deployed()

    const submitData = router.interface.encodeFunctionData(
      "submitP2TRSignatureFraudChallenge",
      [evidence]
    )
    await recipient.forward(submitData, { value: challengeDeposit })
    await increaseTime(challengeTimeout)
    await router.notifyP2TRSignatureFraudChallengeDefeatTimeout(
      identityFor(evidence),
      []
    )
    expect(await router.totalChallengeEscrow()).to.equal(0)
    expect(await router.totalWithdrawablePayouts()).to.equal(challengeDeposit)

    await recipient.withdraw()
    expect(await recipient.reentryAttempted()).to.be.true
    expect(await recipient.reentrySucceeded()).to.be.false
    expect(
      await router.withdrawableP2TRFraudPayouts(recipient.address)
    ).to.equal(0)
    expect(await router.totalWithdrawablePayouts()).to.equal(0)
    expect(await ethers.provider.getBalance(recipient.address)).to.equal(
      challengeDeposit
    )
    expect(await ethers.provider.getBalance(router.address)).to.equal(0)
  })

  it("rejects nonempty predecessor migration and accepts an empty receipt", async () => {
    await expect(
      router.connect(bridgeSigner).acceptMigration(
        [1],
        [
          {
            challenger: challenger.address,
            depositAmount: 1,
            reportedAt: 1,
            resolved: false,
          },
        ],
        { value: 1 }
      )
    ).to.be.revertedWith("COMPLETE_V2 migration must be empty")
    await expect(router.connect(bridgeSigner).acceptMigration([], [])).not.to.be
      .reverted
  })
})
