/* eslint-disable no-await-in-loop */
import { randomBytes } from "crypto"
import { ethers, getUnnamedAccounts, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"
import { BigNumber, Contract } from "ethers"
import { to1e18 } from "../helpers/contract-test-helpers"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { increaseTime, lastBlockTime } = helpers.time

const ZERO_ADDRESS = ethers.constants.AddressZero

const GOVERNANCE_DELAY = 604800 // 7 days
const MOVEMENT_DELAY = 24 * 3600 // default in the contract
const DEFAULT_EXECUTOR_REWARD_BPS = 100
const MAX_REPORT_SEATS = 112

const OperatorStatus = {
  None: 0,
  Active: 1,
  Deactivating: 2,
  Ejected: 3,
}

describe("SlashingModule", () => {
  let deployer: SignerWithAddress
  let operator: SignerWithAddress
  let operator2: SignerWithAddress
  let delegator1: SignerWithAddress
  let executor: SignerWithAddress
  let notifier: SignerWithAddress
  let guardian: SignerWithAddress
  let reserve: SignerWithAddress

  let tToken: Contract
  let tbtcToken: Contract
  let signerRegistry: Contract
  let seatAllocator: Contract
  let ledger: Contract
  let distributor: Contract
  let vault: Contract
  let slashingModule: Contract

  // Reports a slash through the mock seat allocator (the module accepts
  // reports only from its wired seat allocator).
  async function report(
    providers: string[],
    perSeatAmount: BigNumber | number,
    rewardMultiplier = 0,
    notifierAddress?: string
  ) {
    return seatAllocator.reportViaModule(
      slashingModule.address,
      providers,
      perSeatAmount,
      rewardMultiplier,
      notifierAddress ?? notifier.address
    )
  }

  const fixture = async () => {
    const { deployer: deployerSigner } = await helpers.signers.getNamedSigners()
    const accounts = await getUnnamedAccounts()

    const signers = await Promise.all(
      accounts.slice(0, 8).map((account) => ethers.getSigner(account))
    )
    const [
      operatorSigner,
      operator2Signer,
      delegator1Signer,
      executorSigner,
      notifierSigner,
      guardianSigner,
      reserveSigner,
    ] = signers

    const tTokenContract = await (await ethers.getContractFactory("TestERC20"))
      .connect(deployerSigner)
      .deploy()
    const tbtcTokenContract = await (
      await ethers.getContractFactory("MockTBTCToken")
    )
      .connect(deployerSigner)
      .deploy()
    const signerRegistryContract = await (
      await ethers.getContractFactory("MockSignerRegistry")
    )
      .connect(deployerSigner)
      .deploy()
    const seatAllocatorContract = await (
      await ethers.getContractFactory("MockSeatAllocator")
    )
      .connect(deployerSigner)
      .deploy()
    const ledgerContract = await (await ethers.getContractFactory("MockLedger"))
      .connect(deployerSigner)
      .deploy()
    const distributorContract = await (
      await ethers.getContractFactory("MockRewardsDistributor")
    )
      .connect(deployerSigner)
      .deploy()

    const vaultDeployment = await helpers.upgrades.deployProxy(
      `StakeVault_${randomBytes(8).toString("hex")}`,
      {
        contractName: "StakeVault",
        initializerArgs: [
          tTokenContract.address,
          tbtcTokenContract.address,
          GOVERNANCE_DELAY,
        ],
        factoryOpts: { signer: deployerSigner },
        proxyOpts: { kind: "transparent" },
      }
    )
    const vaultContract = vaultDeployment[0]

    const slashingModuleDeployment = await helpers.upgrades.deployProxy(
      `SlashingModule_${randomBytes(8).toString("hex")}`,
      {
        contractName: "SlashingModule",
        initializerArgs: [vaultContract.address, GOVERNANCE_DELAY],
        factoryOpts: { signer: deployerSigner },
        proxyOpts: { kind: "transparent" },
      }
    )
    const slashingModuleContract = slashingModuleDeployment[0]

    await vaultContract
      .connect(deployerSigner)
      .setSignerRegistry(signerRegistryContract.address)
    await vaultContract
      .connect(deployerSigner)
      .setSeatAllocator(seatAllocatorContract.address)
    await vaultContract
      .connect(deployerSigner)
      .setSlashingModule(slashingModuleContract.address)
    await vaultContract
      .connect(deployerSigner)
      .setRewardsDistributor(distributorContract.address)
    await vaultContract
      .connect(deployerSigner)
      .setWalletExposureLedger(ledgerContract.address)
    await slashingModuleContract
      .connect(deployerSigner)
      .setSeatAllocator(seatAllocatorContract.address)

    await signerRegistryContract.setOperatorStatus(
      operatorSigner.address,
      OperatorStatus.Active
    )
    await signerRegistryContract.setOperatorStatus(
      operator2Signer.address,
      OperatorStatus.Active
    )

    const initialBalance = to1e18(10000000)
    for (const account of [operatorSigner, operator2Signer, delegator1Signer]) {
      await tTokenContract
        .connect(deployerSigner)
        .mint(account.address, initialBalance)
      await tTokenContract
        .connect(account)
        .approve(vaultContract.address, initialBalance)
    }

    return {
      deployerSigner,
      operatorSigner,
      operator2Signer,
      delegator1Signer,
      executorSigner,
      notifierSigner,
      guardianSigner,
      reserveSigner,
      tTokenContract,
      tbtcTokenContract,
      signerRegistryContract,
      seatAllocatorContract,
      ledgerContract,
      distributorContract,
      vaultContract,
      slashingModuleContract,
    }
  }

  before(async () => {
    const contracts = await waffle.loadFixture(fixture)
    deployer = contracts.deployerSigner
    operator = contracts.operatorSigner
    operator2 = contracts.operator2Signer
    delegator1 = contracts.delegator1Signer
    executor = contracts.executorSigner
    notifier = contracts.notifierSigner
    guardian = contracts.guardianSigner
    reserve = contracts.reserveSigner
    tToken = contracts.tTokenContract
    tbtcToken = contracts.tbtcTokenContract
    signerRegistry = contracts.signerRegistryContract
    seatAllocator = contracts.seatAllocatorContract
    ledger = contracts.ledgerContract
    distributor = contracts.distributorContract
    vault = contracts.vaultContract
    slashingModule = contracts.slashingModuleContract
  })

  describe("initialize", () => {
    it("should set the stake vault", async () => {
      expect(await slashingModule.stakeVault()).to.equal(vault.address)
    })

    it("should set default parameters", async () => {
      expect(await slashingModule.movementDelay()).to.equal(MOVEMENT_DELAY)
      expect(await slashingModule.executorRewardBps()).to.equal(
        DEFAULT_EXECUTOR_REWARD_BPS
      )
      expect(await slashingModule.governanceDelay()).to.equal(GOVERNANCE_DELAY)
      expect(await slashingModule.movementPaused()).to.be.false
    })

    it("should default the guardian and restitution reserve to the owner", async () => {
      expect(await slashingModule.owner()).to.equal(deployer.address)
      expect(await slashingModule.guardian()).to.equal(deployer.address)
      expect(await slashingModule.restitutionReserve()).to.equal(
        deployer.address
      )
    })

    it("should revert when initialized again", async () => {
      await expect(
        slashingModule.initialize(vault.address, GOVERNANCE_DELAY)
      ).to.be.revertedWith("Initializable: contract is already initialized")
    })
  })

  describe("wiring and roles", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should revert setSeatAllocator for a non-owner", async () => {
      await expect(
        slashingModule.connect(executor).setSeatAllocator(executor.address)
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })

    it("should revert setSeatAllocator for the zero address", async () => {
      await expect(
        slashingModule.connect(deployer).setSeatAllocator(ZERO_ADDRESS)
      ).to.be.revertedWith("ZeroAddress")
    })

    it("should revert setSeatAllocator when already set", async () => {
      await expect(
        slashingModule.connect(deployer).setSeatAllocator(executor.address)
      ).to.be.revertedWith("AlreadySet")
    })

    it("should revert setGuardian for a non-owner", async () => {
      await expect(
        slashingModule.connect(executor).setGuardian(executor.address)
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })

    it("should update the guardian", async () => {
      const tx = await slashingModule
        .connect(deployer)
        .setGuardian(guardian.address)
      await expect(tx)
        .to.emit(slashingModule, "GuardianUpdated")
        .withArgs(guardian.address)
      expect(await slashingModule.guardian()).to.equal(guardian.address)
    })

    it("should update the restitution reserve", async () => {
      const tx = await slashingModule
        .connect(deployer)
        .setRestitutionReserve(reserve.address)
      await expect(tx)
        .to.emit(slashingModule, "RestitutionReserveUpdated")
        .withArgs(reserve.address)
      expect(await slashingModule.restitutionReserve()).to.equal(
        reserve.address
      )
    })
  })

  describe("governed parameters", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should revert begin for a non-owner", async () => {
      await expect(
        slashingModule.connect(executor).beginMovementDelayUpdate(1)
      ).to.be.revertedWith("Ownable: caller is not the owner")
      await expect(
        slashingModule.connect(executor).beginExecutorRewardBpsUpdate(1)
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })

    it("should revert for an executor reward above 100%", async () => {
      await expect(
        slashingModule.connect(deployer).beginExecutorRewardBpsUpdate(10001)
      ).to.be.revertedWith("ExecutorRewardBpsTooHigh")
    })

    it("should revert for a movement delay above 30 days", async () => {
      await expect(
        slashingModule
          .connect(deployer)
          .beginMovementDelayUpdate(30 * 24 * 3600 + 1)
      ).to.be.revertedWith("MovementDelayTooLong")
    })

    it("should apply the movement delay update after the governance delay", async () => {
      await slashingModule.connect(deployer).beginMovementDelayUpdate(3600)
      await expect(
        slashingModule.connect(deployer).finalizeMovementDelayUpdate()
      ).to.be.revertedWith("Governance delay has not elapsed")
      expect(await slashingModule.movementDelay()).to.equal(MOVEMENT_DELAY)

      await increaseTime(GOVERNANCE_DELAY)
      const tx = await slashingModule
        .connect(deployer)
        .finalizeMovementDelayUpdate()
      await expect(tx)
        .to.emit(slashingModule, "MovementDelayUpdated")
        .withArgs(3600)
      expect(await slashingModule.movementDelay()).to.equal(3600)
    })

    it("should apply the executor reward update after the governance delay", async () => {
      await slashingModule.connect(deployer).beginExecutorRewardBpsUpdate(250)
      await expect(
        slashingModule.connect(deployer).finalizeExecutorRewardBpsUpdate()
      ).to.be.revertedWith("Governance delay has not elapsed")

      await increaseTime(GOVERNANCE_DELAY)
      const tx = await slashingModule
        .connect(deployer)
        .finalizeExecutorRewardBpsUpdate()
      await expect(tx)
        .to.emit(slashingModule, "ExecutorRewardBpsUpdated")
        .withArgs(250)
      expect(await slashingModule.executorRewardBps()).to.equal(250)
    })
  })

  describe("report", () => {
    it("should revert for a caller other than the seat allocator", async () => {
      await expect(
        slashingModule
          .connect(executor)
          .report([operator.address], to1e18(100), 0, notifier.address)
      ).to.be.revertedWith("CallerNotSeatAllocator")
    })

    it("should be a no-op for an empty provider list", async () => {
      await createSnapshot()
      await report([], to1e18(100), 0)
      expect(await slashingModule.pendingSlashesLength()).to.equal(0)
      await restoreSnapshot()
    })

    context("first-loss ordering and cap", () => {
      before(async () => {
        await createSnapshot()
        await vault.connect(operator).depositSelfBond(to1e18(50000))
        await vault
          .connect(delegator1)
          .delegate(operator.address, to1e18(20000))
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should consume the self-bond to zero before touching delegated assets", async () => {
        const tx = await report([operator.address], to1e18(60000), 5)

        expect(await vault.selfBondOf(operator.address)).to.equal(0)
        expect(await vault.delegatedAssetsOf(operator.address)).to.equal(
          to1e18(10000)
        )
        expect(await vault.seizedBalance()).to.equal(to1e18(60000))
        expect(
          await slashingModule.pendingSlashCount(operator.address)
        ).to.equal(1)

        const executableAt = (await lastBlockTime()) + MOVEMENT_DELAY
        await expect(tx)
          .to.emit(slashingModule, "SlashReported")
          .withArgs(
            0,
            operator.address,
            1,
            to1e18(60000),
            to1e18(60000),
            notifier.address,
            5,
            executableAt
          )
      })

      it("should book the haircut atomically at report time, before any execution", async () => {
        // No executeSlash has happened yet the vault pools are already
        // reduced (checked above) and the seized T is segregated.
        const slash = await slashingModule.pendingSlashes(0)
        expect(slash.executed).to.be.false
        expect(slash.seizedAmount).to.equal(to1e18(60000))
      })

      it("should cap at the available balance instead of reverting", async () => {
        // Only 10000 of delegated assets remain.
        await report([operator.address], to1e18(60000), 5)

        const slash = await slashingModule.pendingSlashes(1)
        expect(slash.seizedAmount).to.equal(to1e18(10000))
        expect(await vault.selfBondOf(operator.address)).to.equal(0)
        expect(await vault.delegatedAssetsOf(operator.address)).to.equal(0)
        expect(
          await slashingModule.pendingSlashCount(operator.address)
        ).to.equal(2)
      })

      it("should not revert for a provider with no stake at all", async () => {
        await report([executor.address], to1e18(1000), 0)
        const slash = await slashingModule.pendingSlashes(2)
        expect(slash.stakingProvider).to.equal(executor.address)
        expect(slash.seizedAmount).to.equal(0)
        expect(
          await slashingModule.pendingSlashCount(executor.address)
        ).to.equal(1)
      })
    })

    context("aggregation and clamping", () => {
      before(async () => {
        await createSnapshot()
        await vault.connect(operator).depositSelfBond(to1e18(50000))
        await vault.connect(operator2).depositSelfBond(to1e18(50000))
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should aggregate duplicate providers with per-seat semantics", async () => {
        const tx = await report(
          [operator.address, operator2.address, operator.address],
          to1e18(1000),
          0
        )

        // Two unique providers => two pending slashes.
        expect(await slashingModule.pendingSlashesLength()).to.equal(2)

        const first = await slashingModule.pendingSlashes(0)
        expect(first.stakingProvider).to.equal(operator.address)
        expect(first.seizedAmount).to.equal(to1e18(2000)) // 2 seats

        const second = await slashingModule.pendingSlashes(1)
        expect(second.stakingProvider).to.equal(operator2.address)
        expect(second.seizedAmount).to.equal(to1e18(1000)) // 1 seat

        expect(await vault.selfBondOf(operator.address)).to.equal(to1e18(48000))
        expect(await vault.selfBondOf(operator2.address)).to.equal(
          to1e18(49000)
        )

        const executableAt = (await lastBlockTime()) + MOVEMENT_DELAY
        await expect(tx)
          .to.emit(slashingModule, "SlashReported")
          .withArgs(
            0,
            operator.address,
            2,
            to1e18(2000),
            to1e18(2000),
            notifier.address,
            0,
            executableAt
          )
      })

      it("should skip zero-address entries", async () => {
        await report([ZERO_ADDRESS, operator.address], to1e18(1000), 0)
        expect(await slashingModule.pendingSlashesLength()).to.equal(3)
        const slash = await slashingModule.pendingSlashes(2)
        expect(slash.stakingProvider).to.equal(operator.address)
        expect(slash.seizedAmount).to.equal(to1e18(1000))
      })

      it("should clamp the reward multiplier to 100", async () => {
        await report([operator.address], to1e18(1), 250)
        const slash = await slashingModule.pendingSlashes(3)
        expect(slash.rewardMultiplier).to.equal(100)
      })

      it("should truncate oversized reports instead of reverting", async () => {
        const providers = new Array(120).fill(operator.address)
        const tx = await report(providers, to1e18(100), 0)

        const slash = await slashingModule.pendingSlashes(4)
        // Only MAX_REPORT_SEATS entries are processed.
        expect(slash.seizedAmount).to.equal(to1e18(100 * MAX_REPORT_SEATS))

        const executableAt = (await lastBlockTime()) + MOVEMENT_DELAY
        await expect(tx)
          .to.emit(slashingModule, "SlashReported")
          .withArgs(
            4,
            operator.address,
            MAX_REPORT_SEATS,
            to1e18(100 * MAX_REPORT_SEATS),
            to1e18(100 * MAX_REPORT_SEATS),
            notifier.address,
            0,
            executableAt
          )
      })
    })
  })

  describe("executeSlash", () => {
    beforeEach(async () => {
      await createSnapshot()
      await slashingModule
        .connect(deployer)
        .setRestitutionReserve(reserve.address)
      await vault.connect(operator).depositSelfBond(to1e18(50000))
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("should revert for an unknown slash id", async () => {
      await expect(
        slashingModule.connect(executor).executeSlash(99)
      ).to.be.revertedWith("InvalidSlashId")
    })

    it("should revert before the movement delay elapsed", async () => {
      await report([operator.address], to1e18(10000), 5)
      await expect(
        slashingModule.connect(executor).executeSlash(0)
      ).to.be.revertedWith("MovementDelayNotElapsed")
    })

    it("should split the seized amount between notifier, executor, and reserve", async () => {
      await report([operator.address], to1e18(10000), 5)
      await increaseTime(MOVEMENT_DELAY)

      const notifierBefore = await tToken.balanceOf(notifier.address)
      const executorBefore = await tToken.balanceOf(executor.address)
      const reserveBefore = await tToken.balanceOf(reserve.address)

      const tx = await slashingModule.connect(executor).executeSlash(0)

      // notifierReward = 10000 * 5% = 500
      // executorReward = (10000 - 500) * 1% = 95
      // restitution   = 10000 - 500 - 95 = 9405
      await expect(tx)
        .to.emit(slashingModule, "SlashExecuted")
        .withArgs(
          0,
          operator.address,
          executor.address,
          to1e18(500),
          to1e18(95),
          to1e18(9405)
        )

      expect(await tToken.balanceOf(notifier.address)).to.equal(
        notifierBefore.add(to1e18(500))
      )
      expect(await tToken.balanceOf(executor.address)).to.equal(
        executorBefore.add(to1e18(95))
      )
      expect(await tToken.balanceOf(reserve.address)).to.equal(
        reserveBefore.add(to1e18(9405))
      )
      expect(await vault.seizedBalance()).to.equal(0)
      expect(await slashingModule.pendingSlashCount(operator.address)).to.equal(
        0
      )
    })

    it("should skip the notifier leg for a zero notifier address", async () => {
      await report([operator.address], to1e18(10000), 5, ZERO_ADDRESS)
      await increaseTime(MOVEMENT_DELAY)

      const executorBefore = await tToken.balanceOf(executor.address)
      const reserveBefore = await tToken.balanceOf(reserve.address)

      const tx = await slashingModule.connect(executor).executeSlash(0)

      // executorReward = 10000 * 1% = 100; restitution = 9900.
      await expect(tx)
        .to.emit(slashingModule, "SlashExecuted")
        .withArgs(
          0,
          operator.address,
          executor.address,
          0,
          to1e18(100),
          to1e18(9900)
        )
      expect(await tToken.balanceOf(executor.address)).to.equal(
        executorBefore.add(to1e18(100))
      )
      expect(await tToken.balanceOf(reserve.address)).to.equal(
        reserveBefore.add(to1e18(9900))
      )
    })

    it("should send everything to the notifier for a 100% multiplier", async () => {
      await report([operator.address], to1e18(10000), 100)
      await increaseTime(MOVEMENT_DELAY)

      const notifierBefore = await tToken.balanceOf(notifier.address)
      await slashingModule.connect(executor).executeSlash(0)

      expect(await tToken.balanceOf(notifier.address)).to.equal(
        notifierBefore.add(to1e18(10000))
      )
      expect(await vault.seizedBalance()).to.equal(0)
    })

    it("should execute a zero-seized slash without transfers", async () => {
      // Provider with no stake: booked with zero seized amount.
      await report([executor.address], to1e18(1000), 5)
      await increaseTime(MOVEMENT_DELAY)
      await slashingModule.connect(executor).executeSlash(0)
      expect(await slashingModule.pendingSlashCount(executor.address)).to.equal(
        0
      )
    })

    it("should revert when executed twice", async () => {
      await report([operator.address], to1e18(1000), 0)
      await increaseTime(MOVEMENT_DELAY)
      await slashingModule.connect(executor).executeSlash(0)
      await expect(
        slashingModule.connect(executor).executeSlash(0)
      ).to.be.revertedWith("SlashAlreadyExecuted")
    })
  })

  describe("movement pause", () => {
    beforeEach(async () => {
      await createSnapshot()
      await vault.connect(operator).depositSelfBond(to1e18(50000))
      await report([operator.address], to1e18(1000), 0)
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("should revert pause for a non-guardian", async () => {
      await expect(
        slashingModule.connect(executor).pauseMovement()
      ).to.be.revertedWith("CallerNotGuardian")
    })

    it("should pause only the movement of seized funds", async () => {
      const tx = await slashingModule.connect(deployer).pauseMovement()
      await expect(tx)
        .to.emit(slashingModule, "SlashMovementPaused")
        .withArgs(deployer.address)

      await increaseTime(MOVEMENT_DELAY)
      await expect(
        slashingModule.connect(executor).executeSlash(0)
      ).to.be.revertedWith("MovementIsPaused")

      // Reporting — i.e. slash accounting — is NOT paused.
      await report([operator.address], to1e18(1000), 0)
      expect(await slashingModule.pendingSlashesLength()).to.equal(2)
      expect(await vault.selfBondOf(operator.address)).to.equal(to1e18(48000))
    })

    it("should revert pausing twice", async () => {
      await slashingModule.connect(deployer).pauseMovement()
      await expect(
        slashingModule.connect(deployer).pauseMovement()
      ).to.be.revertedWith("MovementIsPaused")
    })

    it("should revert unpausing when not paused", async () => {
      await expect(
        slashingModule.connect(deployer).unpauseMovement()
      ).to.be.revertedWith("MovementNotPaused")
    })

    it("should allow execution again after unpause", async () => {
      await slashingModule.connect(deployer).pauseMovement()
      await increaseTime(MOVEMENT_DELAY)
      await expect(
        slashingModule.connect(executor).executeSlash(0)
      ).to.be.revertedWith("MovementIsPaused")

      const tx = await slashingModule.connect(deployer).unpauseMovement()
      await expect(tx)
        .to.emit(slashingModule, "SlashMovementUnpaused")
        .withArgs(deployer.address)

      await slashingModule.connect(executor).executeSlash(0)
      expect(await slashingModule.pendingSlashCount(operator.address)).to.equal(
        0
      )
    })

    it("should honor a guardian handover", async () => {
      await slashingModule.connect(deployer).setGuardian(guardian.address)
      await expect(
        slashingModule.connect(deployer).pauseMovement()
      ).to.be.revertedWith("CallerNotGuardian")
      await slashingModule.connect(guardian).pauseMovement()
      expect(await slashingModule.movementPaused()).to.be.true
    })
  })

  describe("pending slash lifecycle (vault exit gate)", () => {
    before(async () => {
      await createSnapshot()
      await vault.connect(operator).depositSelfBond(to1e18(50000))
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should track the pending slash count through report and execute", async () => {
      expect(await slashingModule.pendingSlashCount(operator.address)).to.equal(
        0
      )

      await report([operator.address], to1e18(1000), 0)
      await report([operator.address], to1e18(1000), 0)
      expect(await slashingModule.pendingSlashCount(operator.address)).to.equal(
        2
      )

      await increaseTime(MOVEMENT_DELAY)
      await slashingModule.connect(executor).executeSlash(0)
      expect(await slashingModule.pendingSlashCount(operator.address)).to.equal(
        1
      )
      await slashingModule.connect(executor).executeSlash(1)
      expect(await slashingModule.pendingSlashCount(operator.address)).to.equal(
        0
      )
    })
  })
})
