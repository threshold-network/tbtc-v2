import { ethers, helpers, waffle } from "hardhat"
import { expect } from "chai"
import type { Contract } from "ethers"
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

const CURRENT_PROTOCOL_ID = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes("tbtc/ecdsa-signature-fraud/router/current-v2")
)

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
  let thirdParty: SignerWithAddress
  let bridge: Bridge & BridgeStub
  let bridgeGovernance: BridgeGovernance
  let ecdsaFraudRouter: EcdsaFraudRouter

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      deployer,
      governance,
      thirdParty,
      bridge,
      bridgeGovernance,
      ecdsaFraudRouter,
    } = await waffle.loadFixture(bridgeFixture))
  })

  beforeEach(async () => {
    await createSnapshot()
  })

  afterEach(async () => {
    await restoreSnapshot()
  })

  async function deployCurrentRouter(): Promise<EcdsaFraudRouter> {
    const factory = await ethers.getContractFactory(
      "EcdsaFraudRouter",
      deployer
    )
    const router = (await factory.deploy(bridge.address)) as EcdsaFraudRouter
    await router.deployed()
    return router
  }

  async function deployProtocolStub(
    routerBridge = bridge.address,
    protocolID = CURRENT_PROTOCOL_ID,
    openCount = 0
  ): Promise<Contract> {
    const factory = await ethers.getContractFactory(
      "EcdsaFraudRouterCutoverStub",
      deployer
    )
    const stub = await factory.deploy(routerBridge, protocolID, openCount)
    await stub.deployed()
    return stub
  }

  async function beginDrain(): Promise<void> {
    await bridgeGovernance.connect(governance).beginEcdsaFraudRouterDrain()
  }

  it("admits only an empty current-version router bound to this Bridge", async () => {
    await bridge.resetEcdsaFraudRouterForTest(ethers.constants.AddressZero)

    const malformed = await (
      await ethers.getContractFactory(
        "MalformedEcdsaFraudRouterCutoverStub",
        deployer
      )
    ).deploy()
    await malformed.deployed()

    const candidates: Array<[Contract, string]> = [
      [malformed, "EcdsaFraudRouterUnavailable()"],
      [
        await deployProtocolStub(thirdParty.address),
        "EcdsaFraudRouterUnavailable()",
      ],
      [
        await deployProtocolStub(bridge.address, ethers.constants.HashZero),
        "EcdsaFraudRouterUnavailable()",
      ],
      [
        await deployProtocolStub(bridge.address, CURRENT_PROTOCOL_ID, 1),
        "EcdsaFraudRouterHasOpenChallenges(uint256)",
      ],
    ]

    for (const [candidate, error] of candidates) {
      await expectCustomError(
        bridgeGovernance
          .connect(governance)
          .setEcdsaFraudRouter(candidate.address),
        error
      )
      expect(await bridge.ecdsaFraudRouter()).to.equal(
        ethers.constants.AddressZero
      )
    }

    const current = await deployCurrentRouter()
    await bridgeGovernance
      .connect(governance)
      .setEcdsaFraudRouter(current.address)
    expect(await bridge.ecdsaFraudRouter()).to.equal(current.address)
  })

  it("requires governance and pins the exact current router once", async () => {
    await expect(
      bridge.connect(thirdParty).beginEcdsaFraudRouterDrain()
    ).to.be.revertedWith("Caller is not the governance")

    await expect(
      bridgeGovernance.connect(thirdParty).beginEcdsaFraudRouterDrain()
    ).to.be.revertedWith("Ownable: caller is not the owner")

    await expect(
      bridge
        .connect(thirdParty)
        .replaceEcdsaFraudRouter(
          ecdsaFraudRouter.address,
          thirdParty.address,
          []
        )
    ).to.be.revertedWith("Caller is not the governance")

    const tx = await bridgeGovernance
      .connect(governance)
      .beginEcdsaFraudRouterDrain()
    await expect(tx)
      .to.emit(bridge, "EcdsaFraudRouterDrainStarted")
      .withArgs(ecdsaFraudRouter.address)
    expect(await bridge.ecdsaFraudRouterInDrain()).to.equal(
      ecdsaFraudRouter.address
    )

    await expectCustomError(
      bridgeGovernance.connect(governance).beginEcdsaFraudRouterDrain(),
      "EcdsaFraudRouterDrainAlreadyStarted(address)"
    )
  })

  it("refuses to enter an irreversible drain with an unreadable old count", async () => {
    const malformed = await (
      await ethers.getContractFactory(
        "MalformedEcdsaFraudRouterCutoverStub",
        deployer
      )
    ).deploy()
    await malformed.deployed()
    await bridge.resetEcdsaFraudRouterForTest(malformed.address)

    await expectCustomError(
      bridgeGovernance.connect(governance).beginEcdsaFraudRouterDrain(),
      "EcdsaFraudRouterUnavailable()"
    )
    expect(await bridge.ecdsaFraudRouterInDrain()).to.equal(
      ethers.constants.AddressZero
    )
  })

  it("fails closed against graceful closure during a legacy refund callback", async () => {
    const legacyFactory = await ethers.getContractFactory(
      "LegacyEcdsaFraudRouterCutoverStub",
      deployer
    )
    const legacyRouter = await legacyFactory.deploy(bridge.address)
    await legacyRouter.deployed()
    await bridge.resetEcdsaFraudRouterForTest(legacyRouter.address)

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
    await beginDrain()

    await expect(
      legacyRouter.connect(thirdParty).submitChallengeForTest({
        value: constants.fraudChallengeDepositAmount,
      })
    ).to.be.revertedWith("Deposit too low")
    expect(await legacyRouter.openFraudChallengeCount()).to.equal(1)

    await increaseTime((await bridge.walletParameters()).walletClosingPeriod)

    const tx = await challenger.resolveChallenge()
    await expect(tx)
      .to.emit(challenger, "ReentrantClosureAttempt")
      .withArgs(
        false,
        ethers.utils.id("EcdsaFraudRouterDrainPending()").slice(0, 10)
      )

    expect(await legacyRouter.openFraudChallengeCount()).to.equal(0)
    expect((await bridge.wallets(fraudWallet.pubKeyHash160)).state).to.equal(
      walletState.Closing
    )
    await expectCustomError(
      bridge.notifyWalletClosingPeriodElapsed(fraudWallet.pubKeyHash160),
      "EcdsaFraudRouterDrainPending()"
    )
  })

  it("refuses replacement while the old router has any open challenge", async () => {
    const oldRouter = await deployProtocolStub(
      bridge.address,
      CURRENT_PROTOCOL_ID,
      1
    )
    await bridge.resetEcdsaFraudRouterForTest(oldRouter.address)
    await beginDrain()
    const replacement = await deployCurrentRouter()

    await expectCustomError(
      bridgeGovernance
        .connect(governance)
        .replaceEcdsaFraudRouter(oldRouter.address, replacement.address, []),
      "EcdsaFraudRouterHasOpenChallenges(uint256)"
    )

    expect(await bridge.ecdsaFraudRouter()).to.equal(oldRouter.address)
    expect(await bridge.ecdsaFraudRouterInDrain()).to.equal(oldRouter.address)
    expect(await bridge.isEcdsaFraudRouterRetired(oldRouter.address)).to.equal(
      false
    )
  })

  it("rejects malformed, wrong-Bridge, wrong-version, and nonempty replacements", async () => {
    await beginDrain()
    const malformed = await (
      await ethers.getContractFactory(
        "MalformedEcdsaFraudRouterCutoverStub",
        deployer
      )
    ).deploy()
    await malformed.deployed()

    const candidates: Array<[Contract, string]> = [
      [malformed, "EcdsaFraudRouterUnavailable()"],
      [
        await deployProtocolStub(thirdParty.address),
        "EcdsaFraudRouterUnavailable()",
      ],
      [
        await deployProtocolStub(bridge.address, ethers.constants.HashZero),
        "EcdsaFraudRouterUnavailable()",
      ],
      [
        await deployProtocolStub(bridge.address, CURRENT_PROTOCOL_ID, 2),
        "EcdsaFraudRouterHasOpenChallenges(uint256)",
      ],
    ]

    for (const [candidate, error] of candidates) {
      await expectCustomError(
        bridgeGovernance
          .connect(governance)
          .replaceEcdsaFraudRouter(
            ecdsaFraudRouter.address,
            candidate.address,
            []
          ),
        error
      )
      expect(await bridge.ecdsaFraudRouter()).to.equal(ecdsaFraudRouter.address)
      expect(await bridge.ecdsaFraudRouterInDrain()).to.equal(
        ecdsaFraudRouter.address
      )
    }
  })

  it("atomically migrates legacy Bridge escrow while swapping and retiring", async () => {
    const key = 404
    const deposit = ethers.utils.parseEther("0.75")
    await bridge.setLegacyFraudChallengeForTest(
      key,
      {
        challenger: thirdParty.address,
        depositAmount: deposit,
        reportedAt: 1_700_000_000,
        resolved: false,
      },
      { value: deposit }
    )
    await beginDrain()
    const replacement = await deployCurrentRouter()

    await expectCustomError(
      bridgeGovernance
        .connect(governance)
        .replaceEcdsaFraudRouter(
          ecdsaFraudRouter.address,
          replacement.address,
          [999]
        ),
      "LegacyFraudChallengeDoesNotExist()"
    )
    expect(await bridge.ecdsaFraudRouter()).to.equal(ecdsaFraudRouter.address)
    expect(await bridge.ecdsaFraudRouterInDrain()).to.equal(
      ecdsaFraudRouter.address
    )
    expect(
      await bridge.isEcdsaFraudRouterRetired(ecdsaFraudRouter.address)
    ).to.equal(false)

    const tx = await bridgeGovernance
      .connect(governance)
      .replaceEcdsaFraudRouter(ecdsaFraudRouter.address, replacement.address, [
        key,
      ])
    await expect(tx)
      .to.emit(bridge, "EcdsaFraudRouterRetired")
      .withArgs(ecdsaFraudRouter.address)
    await expect(tx)
      .to.emit(bridge, "EcdsaFraudRouterReplaced")
      .withArgs(ecdsaFraudRouter.address, replacement.address)
    await expect(tx)
      .to.emit(bridge, "EcdsaFraudRouterSet")
      .withArgs(replacement.address)

    expect(await bridge.ecdsaFraudRouter()).to.equal(replacement.address)
    expect(await bridge.ecdsaFraudRouterInDrain()).to.equal(
      ethers.constants.AddressZero
    )
    expect(
      await bridge.isEcdsaFraudRouterRetired(ecdsaFraudRouter.address)
    ).to.equal(true)
    expect(await replacement.openFraudChallengeCount()).to.equal(1)
    expect((await replacement.fraudChallenges(key)).challenger).to.equal(
      thirdParty.address
    )
    expect(await ethers.provider.getBalance(replacement.address)).to.equal(
      deposit
    )
    expect((await bridge.legacyFraudChallengeForTest(key)).reportedAt).to.equal(
      0
    )
  })

  it("hard-retires the old router so it cannot accept zombie escrow", async () => {
    const legacyFactory = await ethers.getContractFactory(
      "LegacyEcdsaFraudRouterCutoverStub",
      deployer
    )
    const oldRouter = await legacyFactory.deploy(bridge.address)
    await oldRouter.deployed()
    await bridge.resetEcdsaFraudRouterForTest(oldRouter.address)
    await beginDrain()
    const replacement = await deployCurrentRouter()

    await bridgeGovernance
      .connect(governance)
      .replaceEcdsaFraudRouter(oldRouter.address, replacement.address, [])

    await expectCustomError(
      oldRouter.connect(thirdParty).submitChallengeForTest({
        value: constants.fraudChallengeDepositAmount,
      }),
      "EcdsaFraudRouterRetiredCaller()"
    )
    expect(await oldRouter.openFraudChallengeCount()).to.equal(0)
    expect(await ethers.provider.getBalance(oldRouter.address)).to.equal(0)
  })
})
