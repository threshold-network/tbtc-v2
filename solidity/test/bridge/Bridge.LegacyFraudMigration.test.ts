import { ethers, helpers } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import type { BigNumberish } from "ethers"
import { expect } from "chai"
import type {
  Bridge,
  BridgeGovernance,
  BridgeStub,
  EcdsaFraudRouter,
  P2TRSignatureFraudRouter,
} from "../../typechain"
import bridgeFixture from "../fixtures/bridge"
import {
  nonWitnessSignSingleInputTx,
  wallet as fraudWallet,
} from "../data/fraud"
import { constants, walletState } from "../fixtures"
import { loadFixture } from "../helpers/fixture"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

const expectCustomError = async (
  promise: Promise<unknown>,
  errorName: string
): Promise<void> => {
  const selector = ethers.utils.id(`${errorName}()`).slice(0, 10)

  try {
    await promise
    expect.fail(`expected ${errorName}`)
  } catch (error) {
    const errorData = error as {
      data?: string
      error?: { data?: string }
      message?: string
    }
    const data = errorData.data ?? errorData.error?.data ?? ""
    expect(`${data} ${errorData.message ?? ""}`.toLowerCase()).to.include(
      selector.toLowerCase()
    )
  }
}

describe("Bridge - legacy fraud challenge migration", () => {
  let deployer: SignerWithAddress
  let governance: SignerWithAddress
  let thirdParty: SignerWithAddress
  let bridge: Bridge & BridgeStub
  let bridgeGovernance: BridgeGovernance
  let ecdsaFraudRouter: EcdsaFraudRouter
  let p2trFraudRouter: P2TRSignatureFraudRouter

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({
      deployer,
      governance,
      thirdParty,
      bridge,
      bridgeGovernance,
      ecdsaFraudRouter,
      p2trFraudRouter,
    } = await loadFixture(bridgeFixture))
  })

  beforeEach(async () => {
    await createSnapshot()
  })

  afterEach(async () => {
    await restoreSnapshot()
  })

  async function seedChallenge(
    challengeKey: BigNumberish,
    depositAmount: ReturnType<typeof ethers.utils.parseEther>,
    resolved = false,
    reportedAt = 1_700_000_000
  ): Promise<void> {
    await bridge.setLegacyFraudChallengeForTest(
      challengeKey,
      {
        challenger: thirdParty.address,
        depositAmount,
        reportedAt,
        resolved,
      },
      { value: depositAmount }
    )
  }

  it("migrates an ECDSA batch and transfers the exact aggregate escrow", async () => {
    const keys = [101, 102]
    const deposits = [
      ethers.utils.parseEther("0.4"),
      ethers.utils.parseEther("0.7"),
    ]
    const totalDeposit = deposits[0].add(deposits[1])

    await seedChallenge(keys[0], deposits[0])
    await seedChallenge(keys[1], deposits[1])

    const bridgeBalanceBefore = await ethers.provider.getBalance(bridge.address)
    const routerBalanceBefore = await ethers.provider.getBalance(
      ecdsaFraudRouter.address
    )

    const tx = await bridgeGovernance
      .connect(governance)
      .migrateLegacyFraudChallenges(0, keys)

    await expect(tx)
      .to.emit(bridge, "LegacyFraudChallengeMigrated")
      .withArgs(0, keys[0], thirdParty.address, deposits[0])
    await expect(tx)
      .to.emit(bridge, "LegacyFraudChallengeMigrated")
      .withArgs(0, keys[1], thirdParty.address, deposits[1])
    const receipt = await tx.wait()
    const migratedAt = (await ethers.provider.getBlock(receipt.blockNumber))
      .timestamp

    expect(await ethers.provider.getBalance(bridge.address)).to.equal(
      bridgeBalanceBefore.sub(totalDeposit)
    )
    expect(await ethers.provider.getBalance(ecdsaFraudRouter.address)).to.equal(
      routerBalanceBefore.add(totalDeposit)
    )
    expect(await ecdsaFraudRouter.openFraudChallengeCount()).to.equal(2)
    expect(
      await ecdsaFraudRouter.unattributedOpenFraudChallengeCount()
    ).to.equal(2)
    expect(
      await ecdsaFraudRouter.openFraudChallengeCountByWallet(
        fraudWallet.pubKeyHash160
      )
    ).to.equal(0)
    expect(
      await ecdsaFraudRouter.hasOpenFraudChallengeForWallet(
        fraudWallet.pubKeyHash160
      )
    ).to.equal(true)

    for (let i = 0; i < keys.length; i++) {
      const legacy = await bridge.legacyFraudChallengeForTest(keys[i])
      expect(legacy.reportedAt).to.equal(0)

      const migrated = await ecdsaFraudRouter.fraudChallenges(keys[i])
      expect(migrated.challenger).to.equal(thirdParty.address)
      expect(migrated.depositAmount).to.equal(deposits[i])
      expect(migrated.reportedAt).to.equal(1_700_000_000)
      expect(migrated.resolved).to.equal(false)
      expect(
        await ecdsaFraudRouter.migrationDefenseStartedAtByChallenge(keys[i])
      ).to.equal(migratedAt)
      expect(
        await ecdsaFraudRouter.fraudChallengeDefeatTimeoutStartedAt(keys[i])
      ).to.equal(migratedAt)
    }
    expect(await ecdsaFraudRouter.migratedChallengesActivatedAt()).to.equal(0)
  })

  it("blocks public evidence from pre-seeding an ECDSA migration key", async () => {
    const data = nonWitnessSignSingleInputTx
    const key = ethers.BigNumber.from(
      ethers.utils.solidityKeccak256(
        ["bytes", "bytes32"],
        [fraudWallet.publicKey, data.sighash]
      )
    )

    await bridge.setWallet(fraudWallet.pubKeyHash160, {
      ecdsaWalletID: fraudWallet.ecdsaWalletID,
      mainUtxoHash: ethers.constants.HashZero,
      pendingRedemptionsValue: 0,
      createdAt: 1_700_000_000,
      movingFundsRequestedAt: 0,
      closingStartedAt: 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state: walletState.Live,
      movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
    })
    await seedChallenge(key, constants.fraudChallengeDepositAmount)

    await expect(
      ecdsaFraudRouter
        .connect(deployer)
        .submitFraudChallenge(
          fraudWallet.publicKey,
          data.preimageSha256,
          data.signature,
          { value: constants.fraudChallengeDepositAmount }
        )
    ).to.be.revertedWith("Legacy fraud challenge exists")

    expect(await ecdsaFraudRouter.openFraudChallengeCount()).to.equal(0)
    expect((await ecdsaFraudRouter.fraudChallenges(key)).reportedAt).to.equal(0)
    expect(await ethers.provider.getBalance(ecdsaFraudRouter.address)).to.equal(
      0
    )
    expect(await bridge.legacyFraudChallengeExists(key)).to.equal(true)

    await bridgeGovernance
      .connect(governance)
      .migrateLegacyFraudChallenges(0, [key])

    const migrated = await ecdsaFraudRouter.fraudChallenges(key)
    expect(migrated.challenger).to.equal(thirdParty.address)
    expect(migrated.depositAmount).to.equal(
      constants.fraudChallengeDepositAmount
    )
    expect(await bridge.legacyFraudChallengeExists(key)).to.equal(false)
  })

  it("allows a fresh ECDSA key while a different legacy key awaits migration", async () => {
    const data = nonWitnessSignSingleInputTx

    await bridge.setWallet(fraudWallet.pubKeyHash160, {
      ecdsaWalletID: fraudWallet.ecdsaWalletID,
      mainUtxoHash: ethers.constants.HashZero,
      pendingRedemptionsValue: 0,
      createdAt: 1_700_000_000,
      movingFundsRequestedAt: 0,
      closingStartedAt: 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state: walletState.Live,
      movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
    })
    await seedChallenge(
      ethers.constants.MaxUint256,
      ethers.utils.parseEther("0.1")
    )

    await ecdsaFraudRouter
      .connect(deployer)
      .submitFraudChallenge(
        fraudWallet.publicKey,
        data.preimageSha256,
        data.signature,
        { value: constants.fraudChallengeDepositAmount }
      )

    expect(
      (
        await ecdsaFraudRouter.fraudChallenges(
          ethers.BigNumber.from(
            ethers.utils.solidityKeccak256(
              ["bytes", "bytes32"],
              [fraudWallet.publicKey, data.sighash]
            )
          )
        )
      ).challenger
    ).to.equal(deployer.address)
    expect(
      (await bridge.legacyFraudChallengeForTest(ethers.constants.MaxUint256))
        .reportedAt
    ).to.equal(1_700_000_000)
  })

  it("keeps a resolved legacy ECDSA key reserved against replay", async () => {
    const data = nonWitnessSignSingleInputTx
    const key = ethers.BigNumber.from(
      ethers.utils.solidityKeccak256(
        ["bytes", "bytes32"],
        [fraudWallet.publicKey, data.sighash]
      )
    )

    await bridge.setWallet(fraudWallet.pubKeyHash160, {
      ecdsaWalletID: fraudWallet.ecdsaWalletID,
      mainUtxoHash: ethers.constants.HashZero,
      pendingRedemptionsValue: 0,
      createdAt: 1_700_000_000,
      movingFundsRequestedAt: 0,
      closingStartedAt: 0,
      pendingMovedFundsSweepRequestsCount: 0,
      state: walletState.Live,
      movingFundsTargetWalletsCommitmentHash: ethers.constants.HashZero,
    })
    await seedChallenge(key, constants.fraudChallengeDepositAmount, true)

    expect(await bridge.legacyFraudChallengeExists(key)).to.equal(true)
    await expect(
      ecdsaFraudRouter
        .connect(deployer)
        .submitFraudChallenge(
          fraudWallet.publicKey,
          data.preimageSha256,
          data.signature,
          { value: constants.fraudChallengeDepositAmount }
        )
    ).to.be.revertedWith("Legacy fraud challenge exists")
    expect(await ecdsaFraudRouter.openFraudChallengeCount()).to.equal(0)
  })

  it("rejects legacy P2TR records after COMPLETE_V2 activation", async () => {
    const key = 201
    const deposit = ethers.utils.parseEther("0.25")
    await seedChallenge(key, deposit)

    await expect(
      bridgeGovernance
        .connect(governance)
        .migrateLegacyFraudChallenges(1, [key])
    ).to.be.revertedWith("COMPLETE_V2 migration must be empty")

    expect((await p2trFraudRouter.fraudChallenges(key)).reportedAt).to.equal(0)
    expect((await ecdsaFraudRouter.fraudChallenges(key)).reportedAt).to.equal(0)
    expect(
      (await bridge.legacyFraudChallengeForTest(key)).depositAmount
    ).to.equal(deposit)
  })

  it("rejects calls through BridgeGovernance from a non-owner", async () => {
    await expect(
      bridgeGovernance.connect(thirdParty).migrateLegacyFraudChallenges(0, [])
    ).to.be.revertedWith("Ownable: caller is not the owner")
  })

  it("rejects direct calls to Bridge from a non-governance address", async () => {
    await expect(
      bridge
        .connect(thirdParty)
        .processEcdsaFraudRouterCutover(
          3,
          ethers.utils.defaultAbiCoder.encode(["uint8", "uint256[]"], [0, []])
        )
    ).to.be.revertedWith("Caller is not the governance")
  })

  it("rejects an unsupported router kind without consuming the record", async () => {
    const key = 301
    const deposit = ethers.utils.parseEther("0.1")
    await seedChallenge(key, deposit)

    await expect(
      bridgeGovernance
        .connect(governance)
        .migrateLegacyFraudChallenges(2, [key])
    ).to.be.reverted

    expect(
      (await bridge.legacyFraudChallengeForTest(key)).depositAmount
    ).to.equal(deposit)
  })

  it("rejects an unwired router without consuming the record", async () => {
    const key = 302
    const deposit = ethers.utils.parseEther("0.1")
    await seedChallenge(key, deposit)
    await bridge.resetEcdsaFraudRouterForTest(ethers.constants.AddressZero)

    await expect(
      bridgeGovernance
        .connect(governance)
        .migrateLegacyFraudChallenges(0, [key])
    ).to.be.reverted

    expect(
      (await bridge.legacyFraudChallengeForTest(key)).depositAmount
    ).to.equal(deposit)
  })

  it("rejects a nonexistent legacy challenge", async () => {
    await expect(
      bridgeGovernance
        .connect(governance)
        .migrateLegacyFraudChallenges(0, [401])
    ).to.be.reverted
  })

  it("rejects a resolved legacy challenge and leaves its escrow intact", async () => {
    const key = 402
    const deposit = ethers.utils.parseEther("0.15")
    await seedChallenge(key, deposit, true)
    const bridgeBalanceBefore = await ethers.provider.getBalance(bridge.address)

    await expect(
      bridgeGovernance
        .connect(governance)
        .migrateLegacyFraudChallenges(0, [key])
    ).to.be.reverted

    expect((await bridge.legacyFraudChallengeForTest(key)).resolved).to.equal(
      true
    )
    expect(await ethers.provider.getBalance(bridge.address)).to.equal(
      bridgeBalanceBefore
    )
  })

  it("rolls deletion and escrow transfer back when the router rejects", async () => {
    const key = 501
    const initialDeposit = ethers.utils.parseEther("0.1")
    await seedChallenge(key, initialDeposit)
    await bridgeGovernance
      .connect(governance)
      .migrateLegacyFraudChallenges(0, [key])

    const secondDeposit = ethers.utils.parseEther("0.2")
    await seedChallenge(key, secondDeposit)
    const bridgeBalanceBefore = await ethers.provider.getBalance(bridge.address)
    const routerBalanceBefore = await ethers.provider.getBalance(
      ecdsaFraudRouter.address
    )

    await expect(
      bridgeGovernance
        .connect(governance)
        .migrateLegacyFraudChallenges(0, [key])
    ).to.be.revertedWith("Challenge already migrated")

    expect(
      (await bridge.legacyFraudChallengeForTest(key)).depositAmount
    ).to.equal(secondDeposit)
    expect(await ethers.provider.getBalance(bridge.address)).to.equal(
      bridgeBalanceBefore
    )
    expect(await ethers.provider.getBalance(ecdsaFraudRouter.address)).to.equal(
      routerBalanceBefore
    )
  })

  for (const routerName of [
    "EcdsaFraudRouter",
    "HandshakeOnlyCompleteP2TRSignatureFraudRouterStub",
  ]) {
    it(`${routerName} rejects resolved migration records`, async () => {
      const factory = await ethers.getContractFactory(routerName, deployer)
      const router =
        routerName === "EcdsaFraudRouter"
          ? await factory.deploy(
              thirdParty.address,
              ethers.constants.AddressZero
            )
          : await factory.deploy(thirdParty.address)
      await router.deployed()
      const deposit = ethers.utils.parseEther("0.1")

      await expect(
        router.connect(thirdParty).acceptMigration(
          [601],
          [
            {
              challenger: thirdParty.address,
              depositAmount: deposit,
              reportedAt: 1_700_000_000,
              resolved: true,
            },
          ],
          { value: deposit }
        )
      ).to.be.revertedWith("Challenge already resolved")
    })
  }

  it("keeps production BOUNDED_V1 migration dormant", async () => {
    const factory = await ethers.getContractFactory(
      "P2TRSignatureFraudRouter",
      deployer
    )
    const router = await factory.deploy(thirdParty.address)
    await router.deployed()

    await expectCustomError(
      router.connect(thirdParty).acceptMigration([], []),
      "P2TRFraudEvidenceUnavailable"
    )
    expect(await router.openFraudChallengeCount()).to.equal(0)
    expect(await ethers.provider.getBalance(router.address)).to.equal(0)
  })
})
