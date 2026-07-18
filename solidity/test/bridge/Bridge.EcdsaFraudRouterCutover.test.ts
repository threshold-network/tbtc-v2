import { ethers, helpers, waffle } from "hardhat"
import { expect } from "chai"
import type { BigNumberish, Contract } from "ethers"
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import type {
  Bridge,
  BridgeGovernance,
  BridgeStub,
  EcdsaFraudRouter,
} from "../../typechain"
import bridgeFixture from "../fixtures/bridge"
import { wallet as fraudWallet } from "../data/fraud"
import { constants, walletState } from "../fixtures"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { increaseTime, lastBlockTime } = helpers.time

const INVENTORY_DOMAIN = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes("tbtc/ecdsa-fraud-router-cutover/inventory/v1")
)

type LegacyChallenge = {
  challenger: string
  depositAmount: BigNumberish
  reportedAt: number
  resolved: boolean
}

async function expectCustomError(
  promise: Promise<unknown>,
  signature: string
): Promise<void> {
  const selector = ethers.utils.id(signature).slice(0, 10).toLowerCase()
  try {
    await promise
    expect.fail(`expected ${signature}`)
  } catch (error) {
    const typedError = error as {
      data?: string
      error?: { data?: string }
      message?: string
    }
    const data = typedError.data ?? typedError.error?.data ?? ""
    expect(`${data} ${typedError.message ?? ""}`.toLowerCase()).to.include(
      selector
    )
  }
}

describe("Bridge - ECDSA fraud router cutover", () => {
  let deployer: SignerWithAddress
  let governance: SignerWithAddress
  let reconciler: SignerWithAddress
  let bridge: Bridge & BridgeStub
  let bridgeGovernance: BridgeGovernance
  let ecdsaFraudRouter: EcdsaFraudRouter

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      deployer,
      governance,
      thirdParty: reconciler,
      bridge,
      bridgeGovernance,
      ecdsaFraudRouter,
    } = await waffle.loadFixture(bridgeFixture))
  })

  beforeEach(async () => createSnapshot())
  afterEach(async () => restoreSnapshot())

  async function deployCurrentRouter(): Promise<EcdsaFraudRouter> {
    const factory = await ethers.getContractFactory(
      "EcdsaFraudRouter",
      deployer
    )
    const router = (await factory.deploy(
      bridge.address,
      await bridge.ecdsaFraudRouter()
    )) as EcdsaFraudRouter
    await router.deployed()
    return router
  }

  async function runtimeCodeHash(contract: Contract): Promise<string> {
    return ethers.utils.keccak256(
      await ethers.provider.getCode(contract.address)
    )
  }

  function challengeSetHash(
    challengeKeys: BigNumberish[],
    challenges: LegacyChallenge[]
  ): string {
    return ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        [
          "uint256[]",
          "tuple(address challenger,uint256 depositAmount,uint32 reportedAt,bool resolved)[]",
        ],
        [challengeKeys, challenges]
      )
    )
  }

  async function mineBlocks(count: number): Promise<void> {
    await ethers.provider.send("hardhat_mine", [ethers.utils.hexValue(count)])
  }

  async function beginDrain(
    replacement: EcdsaFraudRouter,
    oldRouter: Contract = ecdsaFraudRouter,
    scanStartBlock = 0
  ): Promise<{ oldCodeHash: string; newCodeHash: string; drainBlock: number }> {
    const oldCodeHash = await runtimeCodeHash(oldRouter)
    const newCodeHash = await runtimeCodeHash(replacement)
    const tx = await bridgeGovernance
      .connect(governance)
      .beginEcdsaFraudRouterDrain(
        oldRouter.address,
        oldCodeHash,
        replacement.address,
        newCodeHash,
        scanStartBlock
      )
    const receipt = await tx.wait()
    return { oldCodeHash, newCodeHash, drainBlock: receipt.blockNumber }
  }

  async function stageInventory(
    root: string,
    count: number,
    totalEscrow: BigNumberish
  ): Promise<{
    finalizedBlock: number
    finalizedBlockHash: string
    commitment: string
  }> {
    const finalizedBlock = await ethers.provider.getBlockNumber()
    const finalizedBlockHash = (await ethers.provider.getBlock(finalizedBlock))
      .hash
    await mineBlocks(64)
    await bridgeGovernance
      .connect(governance)
      .stageEcdsaFraudInventory(
        finalizedBlock,
        finalizedBlockHash,
        root,
        count,
        totalEscrow,
        reconciler.address
      )
    const state = await bridgeGovernance.ecdsaFraudCutoverState()
    return {
      finalizedBlock,
      finalizedBlockHash,
      commitment: state.inventoryCommitment,
    }
  }

  async function executeEmptyCutover(
    oldRouter: EcdsaFraudRouter,
    replacement: EcdsaFraudRouter
  ): Promise<void> {
    await beginDrain(replacement, oldRouter)
    const { commitment } = await stageInventory(challengeSetHash([], []), 0, 0)
    await bridgeGovernance
      .connect(reconciler)
      .confirmEcdsaFraudInventory(commitment)
    await bridgeGovernance.connect(governance).migrateEcdsaFraudRouter([])
    await bridgeGovernance.connect(reconciler).confirmEcdsaFraudMigration([])
    await increaseTime(constants.governanceDelay)
    await bridgeGovernance
      .connect(governance)
      .finalizeEcdsaFraudRouterReplacement([])
  }

  it("pins and reads back the exact runtime code hash on fresh wiring", async () => {
    await bridge.resetEcdsaFraudRouterForTest(ethers.constants.AddressZero)
    await bridge.setEcdsaFraudRouterCodeHashForTest(ethers.constants.HashZero)
    const router = await deployCurrentRouter()
    const codeHash = await runtimeCodeHash(router)

    await expectCustomError(
      bridgeGovernance
        .connect(governance)
        .setEcdsaFraudRouter(
          router.address,
          ethers.utils.hexZeroPad("0x01", 32)
        ),
      "EcdsaFraudRouterCodeHashMismatch(address,bytes32,bytes32)"
    )
    await bridgeGovernance
      .connect(governance)
      .setEcdsaFraudRouter(router.address, codeHash)
    expect(await bridge.ecdsaFraudRouter()).to.equal(router.address)
    expect(await bridge.ecdsaFraudRouterCodeHash()).to.equal(codeHash)
  })

  it("rejects wrong replacement bytecode before irreversible drain", async () => {
    const replacement = await deployCurrentRouter()
    await expectCustomError(
      bridgeGovernance
        .connect(governance)
        .beginEcdsaFraudRouterDrain(
          ecdsaFraudRouter.address,
          await runtimeCodeHash(ecdsaFraudRouter),
          replacement.address,
          ethers.utils.hexZeroPad("0x01", 32),
          0
        ),
      "EcdsaFraudRouterCodeHashMismatch(address,bytes32,bytes32)"
    )
    expect((await bridgeGovernance.ecdsaFraudCutoverState()).phase).to.equal(0)
  })

  it("rejects over-depth and cyclic ancestry before irreversible drain", async () => {
    const factory = await ethers.getContractFactory(
      "MutableEcdsaFraudRouterAncestryStub",
      deployer
    )
    const oldRouter = await factory.deploy(bridge.address)
    const replacement = await factory.deploy(bridge.address)
    await Promise.all([oldRouter.deployed(), replacement.deployed()])
    await bridge.resetEcdsaFraudRouterForTest(oldRouter.address)
    await bridge.setEcdsaFraudRouterCodeHashForTest(
      await runtimeCodeHash(oldRouter)
    )

    await replacement.setAncestry(oldRouter.address, 9)
    await expectCustomError(
      bridgeGovernance
        .connect(governance)
        .beginEcdsaFraudRouterDrain(
          oldRouter.address,
          await runtimeCodeHash(oldRouter),
          replacement.address,
          await runtimeCodeHash(replacement),
          0
        ),
      "EcdsaFraudRouterAncestryTooDeep(uint256)"
    )

    await replacement.setAncestry(oldRouter.address, 1)
    await replacement.setPredecessorCodeHash(
      ethers.utils.hexZeroPad("0x01", 32)
    )
    await expectCustomError(
      bridgeGovernance
        .connect(governance)
        .beginEcdsaFraudRouterDrain(
          oldRouter.address,
          await runtimeCodeHash(oldRouter),
          replacement.address,
          await runtimeCodeHash(replacement),
          0
        ),
      "EcdsaFraudRouterAncestryInvalid(address)"
    )

    await replacement.setAncestry(oldRouter.address, 1)
    await oldRouter.setAncestry(replacement.address, 1)
    await expectCustomError(
      bridgeGovernance
        .connect(governance)
        .beginEcdsaFraudRouterDrain(
          oldRouter.address,
          await runtimeCodeHash(oldRouter),
          replacement.address,
          await runtimeCodeHash(replacement),
          0
        ),
      "EcdsaFraudRouterAncestryInvalid(address)"
    )
    expect((await bridgeGovernance.ecdsaFraudCutoverState()).phase).to.equal(0)
    expect(await bridge.ecdsaFraudRouterInDrain()).to.equal(
      ethers.constants.AddressZero
    )
  })

  it("freezes legacy submissions and graceful closure during drain", async () => {
    const legacyFactory = await ethers.getContractFactory(
      "LegacyEcdsaFraudRouterCutoverStub",
      deployer
    )
    const legacyRouter = await legacyFactory.deploy(bridge.address)
    await legacyRouter.deployed()
    await bridge.resetEcdsaFraudRouterForTest(legacyRouter.address)
    await bridge.setEcdsaFraudRouterCodeHashForTest(
      await runtimeCodeHash(legacyRouter)
    )

    const closingStartedAt = await lastBlockTime()
    await bridge.setWallet(fraudWallet.pubKeyHash160, {
      ecdsaWalletID: fraudWallet.ecdsaWalletID,
      mainUtxoHash: ethers.constants.HashZero,
      pendingRedemptionsValue: 0,
      createdAt: 0,
      movingFundsRequestedAt: 0,
      closingStartedAt,
      pendingMovedFundsSweepRequestsCount: 0,
      state: walletState.Closing,
      movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
    })

    const challengerFactory = await ethers.getContractFactory(
      "ReentrantEcdsaFraudChallenger",
      deployer
    )
    const challenger = await challengerFactory.deploy(
      legacyRouter.address,
      bridge.address,
      fraudWallet.pubKeyHash160
    )
    await challenger.deployed()
    await challenger.submitChallenge({
      value: constants.fraudChallengeDepositAmount,
    })

    const replacement = await deployCurrentRouter()
    await beginDrain(replacement, legacyRouter)
    await expect(
      legacyRouter.connect(reconciler).submitChallengeForTest({
        value: constants.fraudChallengeDepositAmount,
      })
    ).to.be.revertedWith("Deposit too low")

    await increaseTime((await bridge.walletParameters()).walletClosingPeriod)
    const tx = await challenger.resolveChallenge()
    await expect(tx)
      .to.emit(challenger, "ReentrantClosureAttempt")
      .withArgs(
        false,
        ethers.utils.id("EcdsaFraudRouterDrainPending()").slice(0, 10)
      )
    await expectCustomError(
      bridge.notifyWalletClosingPeriodElapsed(fraudWallet.pubKeyHash160),
      "EcdsaFraudRouterDrainPending()"
    )
  })

  it("binds inventory to chain, Bridge, routers, hashes, and pinned range", async () => {
    const replacement = await deployCurrentRouter()
    const scanStartBlock = Math.max(
      0,
      (await ethers.provider.getBlockNumber()) - 10
    )
    const { oldCodeHash, newCodeHash, drainBlock } = await beginDrain(
      replacement,
      ecdsaFraudRouter,
      scanStartBlock
    )
    const root = challengeSetHash([], [])
    const { finalizedBlock, finalizedBlockHash, commitment } =
      await stageInventory(root, 0, 0)
    const { chainId } = await ethers.provider.getNetwork()
    const routerCommitment = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["address", "address", "bytes32", "bytes32", "uint64", "uint256"],
        [
          ecdsaFraudRouter.address,
          replacement.address,
          oldCodeHash,
          newCodeHash,
          drainBlock,
          constants.governanceDelay,
        ]
      )
    )
    const snapshotCommitment = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["uint64", "uint64", "bytes32", "bytes32", "uint32", "uint256"],
        [scanStartBlock, finalizedBlock, finalizedBlockHash, root, 0, 0]
      )
    )
    const expected = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["bytes32", "uint256", "address", "bytes32", "bytes32"],
        [
          INVENTORY_DOMAIN,
          chainId,
          bridge.address,
          routerCommitment,
          snapshotCommitment,
        ]
      )
    )
    expect(commitment).to.equal(expected)
    expect(
      (await bridgeGovernance.ecdsaFraudCutoverState()).scanStartBlock
    ).to.equal(scanStartBlock)
    expect(
      (await bridgeGovernance.ecdsaFraudCutoverState()).governanceDelay
    ).to.equal(constants.governanceDelay)
  })

  it("rejects a drain while a governance delay update is pending", async () => {
    const replacement = await deployCurrentRouter()
    await bridgeGovernance
      .connect(governance)
      .beginGovernanceDelayUpdate(constants.governanceDelay + 1)
    await expectCustomError(
      beginDrain(replacement),
      "EcdsaFraudCutoverGovernanceDelayUpdatePending()"
    )
  })

  it("rejects a drain while a Bridge governance transfer is pending", async () => {
    const replacement = await deployCurrentRouter()
    await bridgeGovernance
      .connect(governance)
      .beginBridgeGovernanceTransfer(reconciler.address)

    await expectCustomError(
      beginDrain(replacement),
      "EcdsaFraudCutoverGovernanceTransferPending()"
    )
    expect((await bridgeGovernance.ecdsaFraudCutoverState()).phase).to.equal(0)
    expect(await bridge.ecdsaFraudRouterInDrain()).to.equal(
      ethers.constants.AddressZero
    )
  })

  it("blocks governance handoff throughout every active cutover phase", async () => {
    const replacement = await deployCurrentRouter()
    const assertHandoffBlocked = async () => {
      await expectCustomError(
        bridgeGovernance
          .connect(governance)
          .beginBridgeGovernanceTransfer(reconciler.address),
        "EcdsaFraudCutoverActive()"
      )
      await expectCustomError(
        bridgeGovernance.connect(governance).finalizeBridgeGovernanceTransfer(),
        "EcdsaFraudCutoverActive()"
      )
    }

    await beginDrain(replacement)
    expect((await bridgeGovernance.ecdsaFraudCutoverState()).phase).to.equal(1)
    await assertHandoffBlocked()

    const { commitment } = await stageInventory(challengeSetHash([], []), 0, 0)
    expect((await bridgeGovernance.ecdsaFraudCutoverState()).phase).to.equal(2)
    await assertHandoffBlocked()

    await bridgeGovernance
      .connect(reconciler)
      .confirmEcdsaFraudInventory(commitment)
    expect((await bridgeGovernance.ecdsaFraudCutoverState()).phase).to.equal(3)
    await assertHandoffBlocked()

    await bridgeGovernance.connect(governance).migrateEcdsaFraudRouter([])
    expect((await bridgeGovernance.ecdsaFraudCutoverState()).phase).to.equal(4)
    await assertHandoffBlocked()

    await bridgeGovernance.connect(reconciler).confirmEcdsaFraudMigration([])
    expect((await bridgeGovernance.ecdsaFraudCutoverState()).phase).to.equal(5)
    await assertHandoffBlocked()
  })

  it("pins the delay and blocks delay updates for the full cutover", async () => {
    const replacement = await deployCurrentRouter()
    await beginDrain(replacement)
    expect(
      (await bridgeGovernance.ecdsaFraudCutoverState()).governanceDelay
    ).to.equal(constants.governanceDelay)
    await expectCustomError(
      bridgeGovernance
        .connect(governance)
        .beginGovernanceDelayUpdate(constants.governanceDelay + 1),
      "EcdsaFraudCutoverActive()"
    )
  })

  it("fails closed outside the 64-255 block snapshot window", async () => {
    const replacement = await deployCurrentRouter()
    await beginDrain(replacement)
    const root = challengeSetHash([], [])
    const shallowBlock = await ethers.provider.getBlockNumber()
    const shallowHash = (await ethers.provider.getBlock(shallowBlock)).hash

    await expectCustomError(
      bridgeGovernance
        .connect(governance)
        .stageEcdsaFraudInventory(
          shallowBlock,
          shallowHash,
          root,
          0,
          0,
          reconciler.address
        ),
      "EcdsaFraudCutoverBlockNotFinalized()"
    )

    const { commitment } = await stageInventory(root, 0, 0)
    await bridgeGovernance
      .connect(reconciler)
      .confirmEcdsaFraudInventory(commitment)
    await mineBlocks(190)
    await expectCustomError(
      bridgeGovernance.connect(governance).migrateEcdsaFraudRouter([]),
      "EcdsaFraudCutoverBlockHashUnavailable()"
    )

    // Confirmation does not create a liveness trap: before migration, owner
    // can restage a newer canonical snapshot and obtain a fresh independent
    // confirmation while the same fail-closed drain remains pinned.
    const restaged = await stageInventory(root, 0, 0)
    expect(restaged.commitment).to.not.equal(commitment)
    await bridgeGovernance
      .connect(reconciler)
      .confirmEcdsaFraudInventory(restaged.commitment)
  })

  it("rejects omitted legacy keys atomically and preserves the drain", async () => {
    const keys = [404, 405]
    const deposits = [
      ethers.utils.parseEther("0.75"),
      ethers.utils.parseEther("0.4"),
    ]
    const challenges: LegacyChallenge[] = [
      {
        challenger: reconciler.address,
        depositAmount: deposits[0],
        reportedAt: 1_700_000_000,
        resolved: false,
      },
      {
        challenger: deployer.address,
        depositAmount: deposits[1],
        reportedAt: 1_700_000_001,
        resolved: false,
      },
    ]
    for (let i = 0; i < keys.length; i++) {
      await bridge.setLegacyFraudChallengeForTest(keys[i], challenges[i], {
        value: deposits[i],
      })
    }

    const replacement = await deployCurrentRouter()
    await beginDrain(replacement)
    const totalEscrow = deposits[0].add(deposits[1])
    const { commitment } = await stageInventory(
      challengeSetHash(keys, challenges),
      keys.length,
      totalEscrow
    )
    await bridgeGovernance
      .connect(reconciler)
      .confirmEcdsaFraudInventory(commitment)

    await expectCustomError(
      bridgeGovernance.connect(governance).migrateEcdsaFraudRouter([keys[0]]),
      "EcdsaFraudCutoverChallengeCountMismatch()"
    )
    await expectCustomError(
      bridgeGovernance
        .connect(governance)
        .migrateEcdsaFraudRouter([keys[0], 999]),
      "LegacyFraudChallengeDoesNotExist()"
    )

    expect(
      (await bridge.legacyFraudChallengeForTest(keys[0])).reportedAt
    ).to.equal(challenges[0].reportedAt)
    expect(
      (await bridge.legacyFraudChallengeForTest(keys[1])).reportedAt
    ).to.equal(challenges[1].reportedAt)
    expect(await replacement.openFraudChallengeCount()).to.equal(0)
    expect(await bridge.ecdsaFraudRouter()).to.equal(ecdsaFraudRouter.address)
    expect((await bridgeGovernance.ecdsaFraudCutoverState()).phase).to.equal(3)
  })

  it("keeps nonempty migrated inventory recovery-only and refuses activation", async () => {
    const key = 404
    const deposit = ethers.utils.parseEther("0.75")
    const challenge: LegacyChallenge = {
      challenger: reconciler.address,
      depositAmount: deposit,
      reportedAt: 1_700_000_000,
      resolved: false,
    }
    await bridge.setLegacyFraudChallengeForTest(key, challenge, {
      value: deposit,
    })

    const replacement = await deployCurrentRouter()
    const { oldCodeHash } = await beginDrain(replacement)
    const { commitment } = await stageInventory(
      challengeSetHash([key], [challenge]),
      1,
      deposit
    )
    await expectCustomError(
      bridgeGovernance.connect(deployer).confirmEcdsaFraudInventory(commitment),
      "EcdsaFraudCutoverUnauthorizedReconciler()"
    )
    await bridgeGovernance
      .connect(reconciler)
      .confirmEcdsaFraudInventory(commitment)
    await bridgeGovernance.connect(governance).migrateEcdsaFraudRouter([key])

    expect(await bridge.ecdsaFraudRouter()).to.equal(ecdsaFraudRouter.address)
    expect(await bridge.ecdsaFraudRouterCodeHash()).to.equal(oldCodeHash)
    expect((await bridgeGovernance.ecdsaFraudCutoverState()).phase).to.equal(4)
    expect(
      (await bridgeGovernance.ecdsaFraudCutoverState()).inventoryCommitment
    ).to.equal(commitment)
    expect((await bridge.legacyFraudChallengeForTest(key)).reportedAt).to.equal(
      0
    )
    expect((await replacement.fraudChallenges(key)).challenger).to.equal(
      reconciler.address
    )
    expect(await replacement.openFraudChallengeCount()).to.equal(1)
    expect(await replacement.unattributedOpenFraudChallengeCount()).to.equal(1)
    expect(await replacement.openFraudChallengeEscrow()).to.equal(deposit)
    expect(await ethers.provider.getBalance(replacement.address)).to.equal(
      deposit
    )
    await expectCustomError(
      replacement.fraudChallengeDefeatTimeoutStartedAt(key),
      "EcdsaFraudRouterMigratedChallengeInactive(uint256)"
    )
    await expectCustomError(
      replacement.defeatFraudChallenge("0x", "0x", true),
      "EcdsaFraudRouterNotActive()"
    )

    await bridgeGovernance.connect(reconciler).confirmEcdsaFraudMigration([key])
    const confirmedState = await bridgeGovernance.ecdsaFraudCutoverState()
    expect(confirmedState.phase).to.equal(5)
    expect(confirmedState.postMigrationCommitment).to.not.equal(
      ethers.constants.HashZero
    )

    await expectCustomError(
      bridgeGovernance
        .connect(governance)
        .finalizeEcdsaFraudRouterReplacement([key]),
      "EcdsaFraudCutoverActivationRequiresEmptyInventory()"
    )
    await increaseTime(constants.governanceDelay)
    await expectCustomError(
      bridgeGovernance
        .connect(governance)
        .finalizeEcdsaFraudRouterReplacement([key]),
      "EcdsaFraudCutoverActivationRequiresEmptyInventory()"
    )
    expect(await bridge.ecdsaFraudRouter()).to.equal(ecdsaFraudRouter.address)
    expect(await bridge.ecdsaFraudRouterInDrain()).to.equal(
      ecdsaFraudRouter.address
    )
    expect(await replacement.migratedChallengesActivatedAt()).to.equal(0)
    expect((await bridgeGovernance.ecdsaFraudCutoverState()).phase).to.equal(5)
  })

  it("starts an empty replacement activation epoch and clears the coordinator", async () => {
    const replacement = await deployCurrentRouter()

    await executeEmptyCutover(ecdsaFraudRouter, replacement)

    const activatedAt = await replacement.migratedChallengesActivatedAt()
    expect(activatedAt).to.be.gt(0)
    expect(activatedAt).to.equal(await lastBlockTime())
    expect(await bridge.ecdsaFraudRouter()).to.equal(replacement.address)
    const state = await bridgeGovernance.ecdsaFraudCutoverState()
    expect(state.phase).to.equal(0)
    expect(state.pendingReconciler).to.equal(ethers.constants.AddressZero)
    expect(state.reconcilerUpdateStartedAt).to.equal(0)
  })

  it("recovers a lost phase-four reconciler through delayed candidate acceptance", async () => {
    const replacement = await deployCurrentRouter()
    await beginDrain(replacement)
    const { commitment } = await stageInventory(challengeSetHash([], []), 0, 0)
    await bridgeGovernance
      .connect(reconciler)
      .confirmEcdsaFraudInventory(commitment)
    await bridgeGovernance.connect(governance).migrateEcdsaFraudRouter([])

    await bridgeGovernance
      .connect(governance)
      .beginEcdsaFraudReconcilerUpdate(deployer.address)
    let state = await bridgeGovernance.ecdsaFraudCutoverState()
    expect(state.phase).to.equal(4)
    expect(state.reconciler).to.equal(reconciler.address)
    expect(state.pendingReconciler).to.equal(deployer.address)
    expect(state.reconcilerUpdateStartedAt).to.be.gt(0)

    await expectCustomError(
      bridgeGovernance.connect(reconciler).finalizeEcdsaFraudReconcilerUpdate(),
      "EcdsaFraudCutoverUnauthorizedReconciler()"
    )
    await expectCustomError(
      bridgeGovernance.connect(deployer).finalizeEcdsaFraudReconcilerUpdate(),
      "EcdsaFraudCutoverDelayNotElapsed()"
    )
    await increaseTime(constants.governanceDelay)
    await bridgeGovernance
      .connect(deployer)
      .finalizeEcdsaFraudReconcilerUpdate()

    state = await bridgeGovernance.ecdsaFraudCutoverState()
    expect(state.reconciler).to.equal(deployer.address)
    expect(state.pendingReconciler).to.equal(ethers.constants.AddressZero)
    expect(state.reconcilerUpdateStartedAt).to.equal(0)
    await expectCustomError(
      bridgeGovernance.connect(reconciler).confirmEcdsaFraudMigration([]),
      "EcdsaFraudCutoverUnauthorizedReconciler()"
    )
    await bridgeGovernance.connect(deployer).confirmEcdsaFraudMigration([])
    expect((await bridgeGovernance.ecdsaFraudCutoverState()).phase).to.equal(5)
  })

  it("rechecks the full pinned ancestry before activation", async () => {
    const legacyFactory = await ethers.getContractFactory(
      "LegacyEcdsaFraudRouterCutoverStub",
      deployer
    )
    const legacyRouter = await legacyFactory.deploy(bridge.address)
    await legacyRouter.deployed()

    const currentFactory = await ethers.getContractFactory(
      "MutableEcdsaFraudRouterAncestryStub",
      deployer
    )
    const oldRouter = await currentFactory.deploy(bridge.address)
    await oldRouter.deployed()
    await oldRouter.setAncestry(legacyRouter.address, 1)
    await bridge.resetEcdsaFraudRouterForTest(oldRouter.address)
    await bridge.setEcdsaFraudRouterCodeHashForTest(
      await runtimeCodeHash(oldRouter)
    )

    const replacement = await deployCurrentRouter()
    await beginDrain(replacement, oldRouter)
    const { commitment } = await stageInventory(challengeSetHash([], []), 0, 0)
    await bridgeGovernance
      .connect(reconciler)
      .confirmEcdsaFraudInventory(commitment)
    await bridgeGovernance.connect(governance).migrateEcdsaFraudRouter([])
    await bridgeGovernance.connect(reconciler).confirmEcdsaFraudMigration([])
    await increaseTime(constants.governanceDelay)

    await oldRouter.setOpenFraudChallengeEscrowForTest(1)
    await expectCustomError(
      bridgeGovernance
        .connect(governance)
        .finalizeEcdsaFraudRouterReplacement([]),
      "EcdsaFraudRouterAncestryHasOpenChallenges(address,uint256,uint256)"
    )

    await oldRouter.setOpenFraudChallengeEscrowForTest(0)
    await legacyRouter.setOpenFraudChallengeCountForTest(1)
    await expectCustomError(
      bridgeGovernance
        .connect(governance)
        .finalizeEcdsaFraudRouterReplacement([]),
      "EcdsaFraudRouterAncestryHasOpenChallenges(address,uint256,uint256)"
    )

    expect((await bridgeGovernance.ecdsaFraudCutoverState()).phase).to.equal(5)
    expect(await bridge.ecdsaFraudRouter()).to.equal(oldRouter.address)
    expect(await bridge.ecdsaFraudRouterInDrain()).to.equal(oldRouter.address)
  })

  it("blocks every generic shared-mapping migration after the inventory freeze", async () => {
    const replacement = await deployCurrentRouter()
    await beginDrain(replacement)
    await expectCustomError(
      bridgeGovernance.connect(governance).migrateLegacyFraudChallenges(0, []),
      "EcdsaFraudRouterMigrationPending()"
    )
    await expectCustomError(
      bridgeGovernance.connect(governance).migrateLegacyFraudChallenges(1, []),
      "EcdsaFraudRouterMigrationPending()"
    )
  })

  it("permanently rejects A to B to A router resurrection", async () => {
    const replacement = await deployCurrentRouter()
    await executeEmptyCutover(ecdsaFraudRouter, replacement)
    expect(await bridge.ecdsaFraudRouter()).to.equal(replacement.address)

    await expectCustomError(
      bridgeGovernance
        .connect(governance)
        .beginEcdsaFraudRouterDrain(
          replacement.address,
          await runtimeCodeHash(replacement),
          ecdsaFraudRouter.address,
          await runtimeCodeHash(ecdsaFraudRouter),
          0
        ),
      "EcdsaFraudRouterPredecessorMismatch(address,address)"
    )
    expect((await bridgeGovernance.ecdsaFraudCutoverState()).phase).to.equal(0)
    expect(await bridge.ecdsaFraudRouter()).to.equal(replacement.address)
  })
})
