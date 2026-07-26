/* eslint-disable @typescript-eslint/no-unused-expressions */

import { BigNumber, Signer } from "ethers"
import { ethers, helpers, network } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"
import { smock } from "@defi-wonderland/smock"
import type {
  Bridge,
  BridgeStub,
  P2TRAuthorizationRegistry,
} from "../../typechain"
import bridgeFixture from "../fixtures/bridge"
import { loadFixture } from "../helpers/fixture"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { hexConcat, hexZeroPad, keccak256, sha256, toUtf8Bytes } = ethers.utils

const uintLE = (value: number, bytes: number): string =>
  hexZeroPad(BigNumber.from(value).toHexString(), bytes)
    .slice(2)
    .match(/../g)!
    .reverse()
    .join("")

const transaction = (sequence = "ffffffff", outputValue = 900_000) => ({
  version: "0x02000000",
  inputVector: `0x01${"11".repeat(32)}0000000000${sequence}`,
  outputVector: `0x01${uintLE(outputValue, 8)}225120${"22".repeat(32)}`,
  locktime: "0x00000000",
})

const transactionHash = (tx: ReturnType<typeof transaction>): string =>
  sha256(
    sha256(
      hexConcat([tx.version, tx.inputVector, tx.outputVector, tx.locktime])
    )
  )

describe("P2TRAuthorizationRegistry pre-signing reservations", () => {
  let bridge: Bridge & BridgeStub
  let registry: P2TRAuthorizationRegistry
  let completeRouter: any
  let bridgeSigner: Signer
  let operator: SignerWithAddress
  let relayer: SignerWithAddress
  let frostRegistry: any
  let sortitionPool: any
  let walletID: string
  let walletPubKeyHash: string
  let walletMembersIDs: number[]
  let membersIDsHash: string
  let resourceIDs: string[]

  before(async () => {
    const fixture = await loadFixture(bridgeFixture)
    bridge = fixture.bridge
    operator = fixture.deployer
    relayer = fixture.thirdParty
    walletID = `0x${"ab".repeat(32)}`
    walletPubKeyHash = `0x${"cd".repeat(20)}`
    walletMembersIDs = Array.from({ length: 100 }, (_, index) => index + 1)
    membersIDsHash = keccak256(
      ethers.utils.defaultAbiCoder.encode(["uint32[]"], [walletMembersIDs])
    )
    resourceIDs = [
      keccak256(toUtf8Bytes("deposit-outpoint")),
      keccak256(toUtf8Bytes("wallet-main-slot")),
    ].sort()

    frostRegistry = await smock.fake("IFrostRegistryForP2TRPreAuthorization")
    sortitionPool = await smock.fake("ISortitionPoolForP2TRPreAuthorization")
    const proposalValidator = await smock.fake(
      "IProposalValidatorForP2TRPreAuthorization"
    )
    proposalValidator.bridge.returns(bridge.address)
    frostRegistry.getWallet.returns([membersIDsHash, walletID])
    frostRegistry.sortitionPool.returns(sortitionPool.address)
    sortitionPool.getIDOperators.returns(
      Array.from({ length: 51 }, () => operator.address)
    )

    const Registry = await ethers.getContractFactory(
      "P2TRAuthorizationRegistry"
    )
    registry = (await Registry.deploy(
      bridge.address,
      frostRegistry.address,
      proposalValidator.address
    )) as P2TRAuthorizationRegistry
    await registry.deployed()

    const Router = await ethers.getContractFactory(
      "CompleteP2TRSignatureFraudRouter"
    )
    completeRouter = await Router.deploy(bridge.address, registry.address)
    await completeRouter.deployed()

    await ethers.provider.send("hardhat_impersonateAccount", [bridge.address])
    await ethers.provider.send("hardhat_setBalance", [
      bridge.address,
      ethers.utils.hexValue(ethers.utils.parseEther("10")),
    ])
    bridgeSigner = await ethers.getSigner(bridge.address)
    await bridge.resetFrostWalletRegistryForTest(frostRegistry.address)
    await bridge.resetP2TRFraudRouterForTest(completeRouter.address)
    await bridge.setWalletIDForWalletPubKeyHash(walletPubKeyHash, walletID)
  })

  beforeEach(async () => {
    await createSnapshot()
    frostRegistry.getWallet.returns([membersIDsHash, walletID])
  })
  afterEach(async () => restoreSnapshot())

  const baseAuthorization = (
    overrides: Partial<{
      action: number
      walletPubKeyHash: string
      walletID: string
      membersIDsHash: string
      snapshotHash: string
      resourceHash: string
      orderedInputRoot: string
      applyPlanHash: string
      applyPlanData1: string
      applyPlanData2: string
      feeLimitSnapshot: number
    }> = {}
  ) => ({
    action: overrides.action ?? 1,
    walletPubKeyHash: overrides.walletPubKeyHash ?? walletPubKeyHash,
    walletID: overrides.walletID ?? walletID,
    membersIDsHash: overrides.membersIDsHash ?? membersIDsHash,
    snapshotHash:
      overrides.snapshotHash ?? keccak256(toUtf8Bytes("state-snapshot")),
    resourceHash:
      overrides.resourceHash ??
      keccak256(
        ethers.utils.defaultAbiCoder.encode(["bytes32[]"], [resourceIDs])
      ),
    orderedInputRoot:
      overrides.orderedInputRoot ?? keccak256(toUtf8Bytes("ordered-inputs")),
    applyPlanHash:
      overrides.applyPlanHash ?? keccak256(toUtf8Bytes("apply-plan")),
    applyPlanData1:
      overrides.applyPlanData1 ?? keccak256(toUtf8Bytes("apply-data-1")),
    applyPlanData2:
      overrides.applyPlanData2 ?? keccak256(toUtf8Bytes("apply-data-2")),
    feeLimitSnapshot: overrides.feeLimitSnapshot ?? 10_000,
  })

  const sign = async (
    tx = transaction(),
    authorization = baseAuthorization(),
    indices = Array.from({ length: 51 }, (_, index) => index + 1),
    signingKeys = [authorization.walletID],
    members = walletMembersIDs
  ) => {
    const inputValues = [1_000_000]
    const authorizationRoot = await registry.authorizationRoot(
      authorization.walletID,
      tx,
      inputValues,
      signingKeys
    )
    const digest = await registry.preAuthorizationDigest(
      authorization,
      transactionHash(tx),
      authorizationRoot
    )
    const signature = await operator.signMessage(ethers.utils.arrayify(digest))
    return {
      inputValues,
      signingKeys,
      authorizationRoot,
      attestation: {
        walletMembersIDs: members,
        signingMemberIndices: indices,
        signatures: hexConcat(indices.map(() => signature)),
      },
    }
  }

  const authorize = async (
    tx = transaction(),
    authorization = baseAuthorization(),
    resources = resourceIDs,
    indices = Array.from({ length: 51 }, (_, index) => index + 1),
    members = walletMembersIDs
  ) => {
    const signed = await sign(
      tx,
      authorization,
      indices,
      [authorization.walletID],
      members
    )
    return registry
      .connect(bridgeSigner)
      .registerPreAuthorizedTransaction(
        authorization,
        tx,
        signed.inputValues,
        signed.signingKeys,
        resources,
        signed.attestation
      )
  }

  for (const retainedGroupSize of [99, 51]) {
    it(`accepts a legitimate retained ${retainedGroupSize}-member FROST group`, async () => {
      const retainedMembers = Array.from(
        { length: retainedGroupSize },
        (_, index) => index + 1
      )
      const retainedMembersHash = keccak256(
        ethers.utils.defaultAbiCoder.encode(["uint32[]"], [retainedMembers])
      )
      frostRegistry.getWallet.returns([retainedMembersHash, walletID])

      const authorization = baseAuthorization({
        membersIDsHash: retainedMembersHash,
      })
      await expect(
        authorize(
          transaction(),
          authorization,
          resourceIDs,
          Array.from({ length: 51 }, (_, index) => index + 1),
          retainedMembers
        )
      ).to.emit(registry, "P2TRPreSigningReservationAuthorized")
    })
  }

  for (const retainedGroupSize of [50, 101]) {
    it(`rejects an invalid retained ${retainedGroupSize}-member FROST group`, async () => {
      const retainedMembers = Array.from(
        { length: retainedGroupSize },
        (_, index) => index + 1
      )
      const retainedMembersHash = keccak256(
        ethers.utils.defaultAbiCoder.encode(["uint32[]"], [retainedMembers])
      )
      frostRegistry.getWallet.returns([retainedMembersHash, walletID])

      await expect(
        authorize(
          transaction(),
          baseAuthorization({ membersIDsHash: retainedMembersHash }),
          resourceIDs,
          Array.from({ length: 51 }, (_, index) => index + 1),
          retainedMembers
        )
      ).to.be.revertedWith("Wallet seat count out of range")
    })
  }

  it("accepts exactly 51 sorted seat attestations and records auditable accounting", async () => {
    const tx = transaction()
    const authorization = baseAuthorization()
    const expectedID = await registry.reservationID(authorization)
    const authorizationRoot = await registry.authorizationRoot(
      walletID,
      tx,
      [1_000_000],
      [walletID]
    )

    await expect(authorize(tx, authorization))
      .to.emit(registry, "P2TRPreSigningReservationAuthorized")
      .withArgs(
        expectedID,
        transactionHash(tx),
        walletID,
        authorizationRoot,
        authorization.snapshotHash,
        authorization.resourceHash,
        authorization.action
      )
      .and.to.emit(registry, "P2TRActiveReservationAccountingUpdated")
      .withArgs(expectedID, true, 1, 1)

    expect(await registry.activeReservation(walletPubKeyHash)).to.equal(
      expectedID
    )
    expect(await registry.activeReservationCount()).to.equal(1)
    expect(await registry.activeReservationAt(0)).to.equal(expectedID)
    expect(await registry.activeReservationSetVersion()).to.equal(1)
    expect(await registry.isResourceReserved(resourceIDs[0])).to.be.true
    expect(await registry.authorizedChallengeIdentityCount()).to.equal(1)

    const registered = await registry.getReservation(expectedID)
    expect(registered.walletID).to.equal(walletID)
    expect(registered.walletPubKeyHash).to.equal(walletPubKeyHash)
    expect(registered.membersIDsHash).to.equal(membersIDsHash)
    expect(registered.applyPlanData1).to.equal(authorization.applyPlanData1)
    expect(registered.applyPlanData2).to.equal(authorization.applyPlanData2)
    expect(registered.feeLimitSnapshot).to.equal(authorization.feeLimitSnapshot)
    expect(registered.status).to.equal(1)
  })

  it("rejects too few, duplicate, unsorted, and out-of-range seat indices", async () => {
    await expect(
      authorize(
        transaction(),
        baseAuthorization(),
        resourceIDs,
        Array.from({ length: 50 }, (_, index) => index + 1)
      )
    ).to.be.revertedWith("Exactly 51 seat signatures required")

    const duplicate = Array.from({ length: 51 }, (_, index) => index + 1)
    duplicate[50] = 50
    await expect(
      authorize(transaction(), baseAuthorization(), resourceIDs, duplicate)
    ).to.be.revertedWith("Corrupted signing member indices")

    const unsorted = Array.from({ length: 51 }, (_, index) => index + 1)
    ;[unsorted[1], unsorted[2]] = [unsorted[2], unsorted[1]]
    await expect(
      authorize(transaction(), baseAuthorization(), resourceIDs, unsorted)
    ).to.be.revertedWith("Corrupted signing member indices")

    const outOfRange = Array.from({ length: 51 }, (_, index) => index + 50)
    outOfRange[50] = 101
    await expect(
      authorize(transaction(), baseAuthorization(), resourceIDs, outOfRange)
    ).to.be.revertedWith("Corrupted signing member indices")
  })

  it("rejects a malformed signature bundle and every attested-plan mutation", async () => {
    const tx = transaction()
    const authorization = baseAuthorization()
    const signed = await sign(tx, authorization)

    await expect(
      registry
        .connect(bridgeSigner)
        .registerPreAuthorizedTransaction(
          authorization,
          tx,
          signed.inputValues,
          signed.signingKeys,
          resourceIDs,
          { ...signed.attestation, signatures: "0x1234" }
        )
    ).to.be.revertedWith("Malformed signatures array")

    await expect(
      registry.connect(bridgeSigner).registerPreAuthorizedTransaction(
        {
          ...authorization,
          applyPlanHash: keccak256(toUtf8Bytes("mutated-plan")),
        },
        tx,
        signed.inputValues,
        signed.signingKeys,
        resourceIDs,
        signed.attestation
      )
    ).to.be.revertedWith("Invalid seat signature")
  })

  it("keeps replay idempotent and admits only additive variants of one immutable reservation", async () => {
    const authorization = baseAuthorization()
    const first = transaction()
    const replacement = transaction("fdffffff", 899_000)
    const replacementAuthorization = {
      ...authorization,
      applyPlanHash: keccak256(toUtf8Bytes("replacement-apply-plan")),
    }
    const expectedID = await registry.reservationID(authorization)
    expect(await registry.reservationID(replacementAuthorization)).to.equal(
      expectedID
    )

    await authorize(first, authorization)
    const firstStatus = await registry.getAuthorizedVariantStatus(
      transactionHash(first)
    )
    expect(firstStatus.authorizationSequence).to.equal(1)
    expect(firstStatus.fraudDefenseAuthorized).to.be.true
    expect(firstStatus.signingAllowed).to.be.true
    const identitiesAfterFirst =
      await registry.authorizedChallengeIdentityCount()
    await authorize(first, authorization)
    expect(await registry.authorizedChallengeIdentityCount()).to.equal(
      identitiesAfterFirst
    )
    expect(await registry.activeReservationCount()).to.equal(1)
    expect(await registry.authorizedVariantCount()).to.equal(1)

    await expect(authorize(replacement, replacementAuthorization))
      .to.emit(registry, "P2TRAuthorizedVariantAdvanced")
      .withArgs(expectedID, transactionHash(replacement), 2)
    expect(
      (await registry.getAuthorizedVariant(transactionHash(first))).authorized
    ).to.be.true
    expect(
      (await registry.getAuthorizedVariant(transactionHash(replacement)))
        .authorized
    ).to.be.true
    expect(await registry.activeReservationCount()).to.equal(1)
    expect(await registry.activeReservationAt(0)).to.equal(expectedID)
    expect(await registry.activeReservationSetVersion()).to.equal(1)
    const superseded = await registry.getAuthorizedVariantStatus(
      transactionHash(first)
    )
    expect(superseded.fraudDefenseAuthorized).to.be.true
    expect(superseded.signingAllowed).to.be.false
    const current = await registry.getAuthorizedVariantStatus(
      transactionHash(replacement)
    )
    expect(current.authorizationSequence).to.equal(2)
    expect(current.signingAllowed).to.be.true
    const latest = await registry.latestAuthorizedVariant(expectedID)
    expect(latest.transactionHash).to.equal(transactionHash(replacement))
    expect(latest.authorizationSequence).to.equal(2)
    expect(latest.signingAllowed).to.be.true

    await expect(
      authorize(replacement, {
        ...replacementAuthorization,
        feeLimitSnapshot: replacementAuthorization.feeLimitSnapshot + 1,
      })
    ).to.be.revertedWith("Transaction variant already bound")
  })

  it("orders same-block RBF variants monotonically and permits only the latest to sign", async () => {
    const authorization = baseAuthorization()
    const first = transaction()
    const replacement = transaction("fdffffff", 899_000)
    const replacementAuthorization = {
      ...authorization,
      applyPlanHash: keccak256(toUtf8Bytes("same-block-rbf-plan")),
    }
    const id = await registry.reservationID(authorization)
    const firstSigned = await sign(first, authorization)
    const replacementSigned = await sign(replacement, replacementAuthorization)
    const nonce = await bridgeSigner.getTransactionCount()

    await network.provider.send("evm_setAutomine", [false])
    try {
      const firstTransaction = await registry
        .connect(bridgeSigner)
        .registerPreAuthorizedTransaction(
          authorization,
          first,
          firstSigned.inputValues,
          firstSigned.signingKeys,
          resourceIDs,
          firstSigned.attestation,
          { nonce, gasLimit: 5_000_000 }
        )
      const replacementTransaction = await registry
        .connect(bridgeSigner)
        .registerPreAuthorizedTransaction(
          replacementAuthorization,
          replacement,
          replacementSigned.inputValues,
          replacementSigned.signingKeys,
          resourceIDs,
          replacementSigned.attestation,
          { nonce: nonce + 1, gasLimit: 5_000_000 }
        )
      await network.provider.send("hardhat_mine", ["0x1"])
      await firstTransaction.wait()
      await replacementTransaction.wait()
    } finally {
      await network.provider.send("evm_setAutomine", [true])
    }

    const firstStatus = await registry.getAuthorizedVariantStatus(
      transactionHash(first)
    )
    const replacementStatus = await registry.getAuthorizedVariantStatus(
      transactionHash(replacement)
    )
    expect(firstStatus.authorizationSequence).to.equal(1)
    expect(firstStatus.signingAllowed).to.be.false
    expect(replacementStatus.authorizationSequence).to.equal(2)
    expect(replacementStatus.signingAllowed).to.be.true
    expect(
      (await registry.latestAuthorizedVariant(id)).transactionHash
    ).to.equal(transactionHash(replacement))
  })

  it("settles exactly once and restores an empty enumerable set/resource locks", async () => {
    const tx = transaction()
    const authorization = baseAuthorization()
    const id = await registry.reservationID(authorization)
    await authorize(tx, authorization)

    await expect(
      registry
        .connect(bridgeSigner)
        .settleAuthorizedProof(id, transactionHash(tx))
    )
      .to.emit(registry, "P2TRActiveReservationAccountingUpdated")
      .withArgs(id, false, 0, 2)

    expect(await registry.hasActiveReservation(walletPubKeyHash)).to.be.false
    expect(await registry.activeReservationCount()).to.equal(0)
    expect(await registry.activeReservationSetVersion()).to.equal(2)
    await expect(registry.activeReservationAt(0)).to.be.revertedWith(
      "Index out of bounds"
    )
    expect(await registry.isResourceReserved(resourceIDs[0])).to.be.false
    expect((await registry.getReservation(id)).status).to.equal(2)
    const settledStatus = await registry.getAuthorizedVariantStatus(
      transactionHash(tx)
    )
    expect(settledStatus.fraudDefenseAuthorized).to.be.true
    expect(settledStatus.signingAllowed).to.be.false
    expect((await registry.latestAuthorizedVariant(id)).signingAllowed).to.be
      .false

    await expect(
      registry
        .connect(bridgeSigner)
        .settleAuthorizedProof(id, transactionHash(tx))
    ).to.be.revertedWith("Reservation is not active")
  })

  it("enumerates the exact active set and releases both conflicts", async () => {
    const secondWalletID = `0x${"bc".repeat(32)}`
    const secondWalletPubKeyHash = `0x${"de".repeat(20)}`
    const secondResources = [
      keccak256(toUtf8Bytes("second-outpoint")),
      keccak256(toUtf8Bytes("second-wallet-slot")),
    ].sort()
    const secondAuthorization = baseAuthorization({
      action: 2,
      walletID: secondWalletID,
      walletPubKeyHash: secondWalletPubKeyHash,
      snapshotHash: keccak256(toUtf8Bytes("second-snapshot")),
      resourceHash: keccak256(
        ethers.utils.defaultAbiCoder.encode(["bytes32[]"], [secondResources])
      ),
      orderedInputRoot: keccak256(toUtf8Bytes("second-input-root")),
      applyPlanHash: keccak256(toUtf8Bytes("second-apply-plan")),
    })
    frostRegistry.getWallet
      .whenCalledWith(secondWalletID)
      .returns([membersIDsHash, secondWalletID])
    await bridge.setWalletIDForWalletPubKeyHash(
      secondWalletPubKeyHash,
      secondWalletID
    )

    const firstAuthorization = baseAuthorization()
    const firstID = await registry.reservationID(firstAuthorization)
    const secondID = await registry.reservationID(secondAuthorization)
    await authorize(transaction(), firstAuthorization)
    await authorize(
      transaction("feffffff", 880_000),
      secondAuthorization,
      secondResources
    )

    expect(await registry.activeReservationCount()).to.equal(2)
    expect(await registry.activeReservationAt(0)).to.equal(firstID)
    expect(await registry.activeReservationAt(1)).to.equal(secondID)
    expect(await registry.activeReservationSetVersion()).to.equal(2)
    const firstActiveSet = [
      await registry.activeReservationAt(0),
      await registry.activeReservationAt(1),
    ]

    const conflictingTx = keccak256(toUtf8Bytes("physical-conflict"))
    await registry
      .connect(bridgeSigner)
      .settleConflictingProof(conflictingTx, resourceIDs[0])
    expect(await registry.activeReservationCount()).to.equal(1)
    expect(await registry.activeReservationAt(0)).to.equal(secondID)
    expect(await registry.activeReservationSetVersion()).to.equal(3)
    expect((await registry.getReservation(firstID)).status).to.equal(3)

    const thirdWalletID = `0x${"ac".repeat(32)}`
    const thirdWalletPubKeyHash = `0x${"ce".repeat(20)}`
    const thirdResources = [
      keccak256(toUtf8Bytes("third-outpoint")),
      keccak256(toUtf8Bytes("third-wallet-slot")),
    ].sort()
    const thirdAuthorization = baseAuthorization({
      action: 3,
      walletID: thirdWalletID,
      walletPubKeyHash: thirdWalletPubKeyHash,
      snapshotHash: keccak256(toUtf8Bytes("third-snapshot")),
      resourceHash: keccak256(
        ethers.utils.defaultAbiCoder.encode(["bytes32[]"], [thirdResources])
      ),
      orderedInputRoot: keccak256(toUtf8Bytes("third-input-root")),
      applyPlanHash: keccak256(toUtf8Bytes("third-apply-plan")),
    })
    frostRegistry.getWallet
      .whenCalledWith(thirdWalletID)
      .returns([membersIDsHash, thirdWalletID])
    await bridge.setWalletIDForWalletPubKeyHash(
      thirdWalletPubKeyHash,
      thirdWalletID
    )
    const thirdID = await registry.reservationID(thirdAuthorization)
    await authorize(
      transaction("fdffffff", 870_000),
      thirdAuthorization,
      thirdResources
    )

    // Equal counts cannot conceal a divergent set: every live ID is
    // authoritatively enumerable at one block tag.
    expect(await registry.activeReservationCount()).to.equal(
      firstActiveSet.length
    )
    const divergentActiveSet = [
      await registry.activeReservationAt(0),
      await registry.activeReservationAt(1),
    ]
    expect(divergentActiveSet).to.deep.equal([secondID, thirdID])
    expect(divergentActiveSet).not.to.deep.equal(firstActiveSet)
    expect(await registry.activeReservationSetVersion()).to.equal(4)

    await registry
      .connect(bridgeSigner)
      .settleConflictingProof(conflictingTx, secondResources[1])
    expect(await registry.activeReservationCount()).to.equal(1)
    expect(await registry.activeReservationAt(0)).to.equal(thirdID)
    await registry
      .connect(bridgeSigner)
      .settleConflictingProof(conflictingTx, thirdResources[0])
    expect(await registry.activeReservationCount()).to.equal(0)
    expect(await registry.activeReservationSetVersion()).to.equal(6)
    expect((await registry.getReservation(secondID)).status).to.equal(3)
    expect((await registry.getReservation(thirdID)).status).to.equal(3)
  })

  it("settles every distinct reservation touched by one physical conflict proof", async () => {
    const secondWalletID = `0x${"bc".repeat(32)}`
    const secondWalletPubKeyHash = `0x${"de".repeat(20)}`
    const secondResources = [
      keccak256(toUtf8Bytes("proof-second-outpoint")),
      keccak256(toUtf8Bytes("proof-second-wallet-slot")),
    ].sort()
    const firstAuthorization = baseAuthorization()
    const secondAuthorization = baseAuthorization({
      action: 2,
      walletID: secondWalletID,
      walletPubKeyHash: secondWalletPubKeyHash,
      snapshotHash: keccak256(toUtf8Bytes("proof-second-snapshot")),
      resourceHash: keccak256(
        ethers.utils.defaultAbiCoder.encode(["bytes32[]"], [secondResources])
      ),
      orderedInputRoot: keccak256(toUtf8Bytes("proof-second-input-root")),
      applyPlanHash: keccak256(toUtf8Bytes("proof-second-apply-plan")),
    })
    frostRegistry.getWallet
      .whenCalledWith(secondWalletID)
      .returns([membersIDsHash, secondWalletID])
    await bridge.setWalletIDForWalletPubKeyHash(
      secondWalletPubKeyHash,
      secondWalletID
    )
    for (const [pubKeyHash, id] of [
      [walletPubKeyHash, walletID],
      [secondWalletPubKeyHash, secondWalletID],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await bridge.setWallet(pubKeyHash, {
        ecdsaWalletID: ethers.constants.HashZero,
        mainUtxoHash: ethers.constants.HashZero,
        pendingRedemptionsValue: 0,
        createdAt: 1,
        movingFundsRequestedAt: 1,
        closingStartedAt: 0,
        pendingMovedFundsSweepRequestsCount: 0,
        state: 2,
        movingFundsTargetWalletsCommitmentHash: keccak256(id),
      })
    }

    const firstID = await registry.reservationID(firstAuthorization)
    const secondID = await registry.reservationID(secondAuthorization)
    await authorize(transaction(), firstAuthorization)
    await authorize(
      transaction("feffffff", 880_000),
      secondAuthorization,
      secondResources
    )

    const conflictHash = keccak256(toUtf8Bytes("one-proof-two-conflicts"))
    const settlement = await bridge.callStatic.settleP2TRProofForTest(
      conflictHash,
      1,
      walletPubKeyHash,
      [resourceIDs[0], secondResources[1]]
    )
    expect(settlement.disposition).to.equal(2)
    await bridge.settleP2TRProofForTest(conflictHash, 1, walletPubKeyHash, [
      resourceIDs[0],
      secondResources[1],
    ])

    expect((await registry.getReservation(firstID)).status).to.equal(3)
    expect((await registry.getReservation(secondID)).status).to.equal(3)
    expect(await registry.activeReservationCount()).to.equal(0)
    expect((await bridge.wallets(walletPubKeyHash)).state).to.equal(7)
    expect((await bridge.wallets(secondWalletPubKeyHash)).state).to.equal(7)
  })

  it("rejects resource collisions and public caller metadata authority", async () => {
    const tx = transaction()
    const authorization = baseAuthorization()
    const signed = await sign(tx, authorization)
    await expect(
      registry
        .connect(relayer)
        .registerPreAuthorizedTransaction(
          authorization,
          tx,
          signed.inputValues,
          signed.signingKeys,
          resourceIDs,
          signed.attestation
        )
    ).to.be.revertedWith("Caller is not Bridge")

    await authorize(tx, authorization)
    const secondWalletID = `0x${"ef".repeat(32)}`
    const secondWalletPubKeyHash = `0x${"fa".repeat(20)}`
    frostRegistry.getWallet
      .whenCalledWith(secondWalletID)
      .returns([membersIDsHash, secondWalletID])
    await bridge.setWalletIDForWalletPubKeyHash(
      secondWalletPubKeyHash,
      secondWalletID
    )
    const colliding = baseAuthorization({
      walletID: secondWalletID,
      walletPubKeyHash: secondWalletPubKeyHash,
      snapshotHash: keccak256(toUtf8Bytes("colliding-snapshot")),
      applyPlanHash: keccak256(toUtf8Bytes("colliding-plan")),
    })
    await expect(
      authorize(transaction("fcffffff"), colliding)
    ).to.be.revertedWith("Signing resource already reserved")
    expect(await registry.activeReservationCount()).to.equal(1)
  })
})
