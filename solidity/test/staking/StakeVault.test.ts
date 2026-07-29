/* eslint-disable no-await-in-loop */
import { randomBytes } from "crypto"
import { ethers, getUnnamedAccounts, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"
import { BigNumber, Contract } from "ethers"
import { to1e18 } from "../helpers/contract-test-helpers"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { increaseTime } = helpers.time

const ZERO_ADDRESS = ethers.constants.AddressZero

const GOVERNANCE_DELAY = 604800 // 7 days
const UNDELEGATION_DELAY = 45 * 24 * 3600 // default in the contract
const MOVEMENT_DELAY = 24 * 3600 // SlashingModule default
const DEFAULT_MIN_SELF_BOND = to1e18(40000)

const OperatorStatus = {
  None: 0,
  Active: 1,
  Deactivating: 2,
  Ejected: 3,
}

describe("StakeVault", () => {
  let deployer: SignerWithAddress
  let operator: SignerWithAddress
  let operator2: SignerWithAddress
  let delegator1: SignerWithAddress
  let delegator2: SignerWithAddress
  let thirdParty: SignerWithAddress
  let notifier: SignerWithAddress
  let beneficiary: SignerWithAddress

  let tToken: Contract
  let tbtcToken: Contract
  let signerRegistry: Contract
  let seatAllocator: Contract
  let ledger: Contract
  let distributor: Contract
  let vault: Contract
  let slashingModule: Contract

  // Reports a slash for `provider` through the mock seat allocator so the
  // real SlashingModule books it against the vault (atomic haircut).
  async function reportSlash(
    provider: string,
    amount: BigNumber,
    rewardMultiplier = 0
  ) {
    await seatAllocator.reportViaModule(
      slashingModule.address,
      [provider],
      amount,
      rewardMultiplier,
      notifier.address
    )
  }

  // Credits a TBTC reward to the provider's pool: transfers the TBTC to the
  // vault first (as the real distributor would) and then calls creditReward
  // through the mock distributor.
  async function creditReward(provider: string, amount: BigNumber) {
    await tbtcToken.mint(vault.address, amount)
    await distributor.creditRewardViaVault(vault.address, provider, amount)
  }

  const fixture = async () => {
    const { deployer: deployerSigner } = await helpers.signers.getNamedSigners()
    const accounts = await getUnnamedAccounts()

    const signers = await Promise.all(
      accounts.slice(0, 7).map((account) => ethers.getSigner(account))
    )
    const [
      operatorSigner,
      operator2Signer,
      delegator1Signer,
      delegator2Signer,
      thirdPartySigner,
      notifierSigner,
      beneficiarySigner,
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
    for (const account of [
      operatorSigner,
      operator2Signer,
      delegator1Signer,
      delegator2Signer,
    ]) {
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
      delegator2Signer,
      thirdPartySigner,
      notifierSigner,
      beneficiarySigner,
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
    delegator2 = contracts.delegator2Signer
    thirdParty = contracts.thirdPartySigner
    notifier = contracts.notifierSigner
    beneficiary = contracts.beneficiarySigner
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
    it("should set the token addresses", async () => {
      expect(await vault.tToken()).to.equal(tToken.address)
      expect(await vault.tbtcToken()).to.equal(tbtcToken.address)
    })

    it("should set default parameters", async () => {
      expect(await vault.undelegationDelay()).to.equal(UNDELEGATION_DELAY)
      expect(await vault.minSelfBond()).to.equal(DEFAULT_MIN_SELF_BOND)
      expect(await vault.governanceDelay()).to.equal(GOVERNANCE_DELAY)
    })

    it("should set the owner to the deployer", async () => {
      expect(await vault.owner()).to.equal(deployer.address)
    })

    it("should revert when initialized again", async () => {
      await expect(
        vault.initialize(tToken.address, tbtcToken.address, GOVERNANCE_DELAY)
      ).to.be.revertedWith("Initializable: contract is already initialized")
    })
  })

  describe("wiring", () => {
    it("should revert when called by a non-owner", async () => {
      await expect(
        vault.connect(thirdParty).setSignerRegistry(thirdParty.address)
      ).to.be.revertedWith("Ownable: caller is not the owner")
    })

    it("should revert for the zero address", async () => {
      await expect(
        vault.connect(deployer).setSignerRegistry(ZERO_ADDRESS)
      ).to.be.revertedWith("ZeroAddress")
    })

    it("should revert when already set", async () => {
      await expect(
        vault.connect(deployer).setSignerRegistry(thirdParty.address)
      ).to.be.revertedWith("AlreadySet")
      await expect(
        vault.connect(deployer).setSeatAllocator(thirdParty.address)
      ).to.be.revertedWith("AlreadySet")
      await expect(
        vault.connect(deployer).setSlashingModule(thirdParty.address)
      ).to.be.revertedWith("AlreadySet")
      await expect(
        vault.connect(deployer).setRewardsDistributor(thirdParty.address)
      ).to.be.revertedWith("AlreadySet")
      await expect(
        vault.connect(deployer).setWalletExposureLedger(thirdParty.address)
      ).to.be.revertedWith("AlreadySet")
    })
  })

  describe("governed parameters", () => {
    context("undelegation delay update", () => {
      before(async () => {
        await createSnapshot()
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert when begun by a non-owner", async () => {
        await expect(
          vault.connect(thirdParty).beginUndelegationDelayUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })

      it("should revert when finalized without being begun", async () => {
        await expect(
          vault.connect(deployer).finalizeUndelegationDelayUpdate()
        ).to.be.revertedWith("Change not initiated")
      })

      it("should not update the delay before the governance delay", async () => {
        await vault.connect(deployer).beginUndelegationDelayUpdate(3600)
        expect(await vault.undelegationDelay()).to.equal(UNDELEGATION_DELAY)
        await expect(
          vault.connect(deployer).finalizeUndelegationDelayUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
      })

      it("should update the delay after the governance delay", async () => {
        await increaseTime(GOVERNANCE_DELAY)
        const tx = await vault
          .connect(deployer)
          .finalizeUndelegationDelayUpdate()
        await expect(tx)
          .to.emit(vault, "UndelegationDelayUpdated")
          .withArgs(3600)
        expect(await vault.undelegationDelay()).to.equal(3600)
      })
    })

    context("minimum self-bond update", () => {
      before(async () => {
        await createSnapshot()
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert when begun by a non-owner", async () => {
        await expect(
          vault.connect(thirdParty).beginMinSelfBondUpdate(1)
        ).to.be.revertedWith("Ownable: caller is not the owner")
      })

      it("should apply the two-step delayed update", async () => {
        await vault.connect(deployer).beginMinSelfBondUpdate(to1e18(1000))
        await expect(
          vault.connect(deployer).finalizeMinSelfBondUpdate()
        ).to.be.revertedWith("Governance delay has not elapsed")
        await increaseTime(GOVERNANCE_DELAY)
        const tx = await vault.connect(deployer).finalizeMinSelfBondUpdate()
        await expect(tx)
          .to.emit(vault, "MinSelfBondUpdated")
          .withArgs(to1e18(1000))
        expect(await vault.minSelfBond()).to.equal(to1e18(1000))
      })
    })
  })

  describe("depositSelfBond", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should revert for a zero amount", async () => {
      await expect(
        vault.connect(operator).depositSelfBond(0)
      ).to.be.revertedWith("AmountCannotBeZero")
    })

    it("should revert for a non-registered provider", async () => {
      await expect(
        vault.connect(thirdParty).depositSelfBond(to1e18(1000))
      ).to.be.revertedWith("ProviderNotActive")
    })

    it("should revert for a deactivating provider", async () => {
      await signerRegistry.setOperatorStatus(
        operator2.address,
        OperatorStatus.Deactivating
      )
      await expect(
        vault.connect(operator2).depositSelfBond(to1e18(1000))
      ).to.be.revertedWith("ProviderNotActive")
      await signerRegistry.setOperatorStatus(
        operator2.address,
        OperatorStatus.Active
      )
    })

    it("should pull T, book the self-bond, and refresh the weight", async () => {
      const amount = to1e18(50000)
      const refreshesBefore = await seatAllocator.refreshCount(operator.address)
      const tx = await vault.connect(operator).depositSelfBond(amount)

      await expect(tx)
        .to.emit(vault, "SelfBondDeposited")
        .withArgs(operator.address, amount)
      expect(await vault.selfBondOf(operator.address)).to.equal(amount)
      expect(await tToken.balanceOf(vault.address)).to.equal(amount)
      expect(await seatAllocator.refreshCount(operator.address)).to.equal(
        refreshesBefore.add(1)
      )
    })
  })

  describe("delegate", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should revert for a zero amount", async () => {
      await expect(
        vault.connect(delegator1).delegate(operator.address, 0)
      ).to.be.revertedWith("AmountCannotBeZero")
    })

    it("should revert for an inactive provider", async () => {
      await expect(
        vault.connect(delegator1).delegate(thirdParty.address, to1e18(100))
      ).to.be.revertedWith("ProviderNotActive")
    })

    it("should mint 1 share per asset wei on the first deposit", async () => {
      const amount = to1e18(1000)
      const tx = await vault
        .connect(delegator1)
        .delegate(operator.address, amount)

      await expect(tx)
        .to.emit(vault, "Delegated")
        .withArgs(operator.address, delegator1.address, amount, amount)
      expect(
        await vault.sharesOf(operator.address, delegator1.address)
      ).to.equal(amount)
      expect(await vault.totalSharesOf(operator.address)).to.equal(amount)
      expect(await vault.delegatedAssetsOf(operator.address)).to.equal(amount)
      expect(await seatAllocator.lastRefreshedProvider()).to.equal(
        operator.address
      )
    })

    it("should mint proportional shares at an unchanged price", async () => {
      const amount = to1e18(500)
      await vault.connect(delegator2).delegate(operator.address, amount)
      expect(
        await vault.sharesOf(operator.address, delegator2.address)
      ).to.equal(amount)
      expect(await vault.delegatedAssetsOf(operator.address)).to.equal(
        to1e18(1500)
      )
    })

    it("should mint more shares per asset after a slash haircut", async () => {
      // No self-bond: the slash goes straight to delegated assets.
      // 1500 T backing 1500 shares; slash 750 => price halves.
      await reportSlash(operator.address, to1e18(750))
      expect(await vault.delegatedAssetsOf(operator.address)).to.equal(
        to1e18(750)
      )

      // 750 T at 0.5 T/share => 1500 shares.
      await vault.connect(delegator2).delegate(operator.address, to1e18(750))
      expect(
        await vault.sharesOf(operator.address, delegator2.address)
      ).to.equal(to1e18(2000)) // 500 + 1500
      expect(await vault.totalSharesOf(operator.address)).to.equal(to1e18(3000))
      expect(await vault.delegatedAssetsOf(operator.address)).to.equal(
        to1e18(1500)
      )
    })

    it("should revert when the pool was fully wiped by slashing", async () => {
      await reportSlash(operator.address, to1e18(1500))
      expect(await vault.delegatedAssetsOf(operator.address)).to.equal(0)
      expect(await vault.totalSharesOf(operator.address)).to.be.gt(0)
      await expect(
        vault.connect(delegator1).delegate(operator.address, to1e18(100))
      ).to.be.revertedWith("PoolWipedOut")
    })
  })

  describe("requestUndelegate", () => {
    before(async () => {
      await createSnapshot()
      await vault.connect(delegator1).delegate(operator.address, to1e18(1000))
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should revert for zero shares", async () => {
      await expect(
        vault.connect(delegator1).requestUndelegate(operator.address, 0)
      ).to.be.revertedWith("AmountCannotBeZero")
    })

    it("should revert for more shares than held", async () => {
      await expect(
        vault
          .connect(delegator1)
          .requestUndelegate(operator.address, to1e18(1001))
      ).to.be.revertedWith("InsufficientShares")
    })

    it("should queue shares and record the exposure epoch", async () => {
      await ledger.setCurrentEpoch(operator.address, 7)

      const tx = await vault
        .connect(delegator1)
        .requestUndelegate(operator.address, to1e18(400))

      await expect(tx)
        .to.emit(vault, "UndelegationRequested")
        .withArgs(0, operator.address, delegator1.address, to1e18(400), 7)

      // Shares stay in the pool...
      expect(
        await vault.sharesOf(operator.address, delegator1.address)
      ).to.equal(to1e18(1000))
      expect(await vault.totalSharesOf(operator.address)).to.equal(to1e18(1000))
      expect(await vault.delegatedAssetsOf(operator.address)).to.equal(
        to1e18(1000)
      )
      // ...but are excluded from weight via the pending views.
      expect(await vault.pendingSharesOf(operator.address)).to.equal(
        to1e18(400)
      )
      expect(
        await vault.queuedSharesOf(operator.address, delegator1.address)
      ).to.equal(to1e18(400))
      expect(
        await vault.pendingUndelegationAssetsOf(operator.address)
      ).to.equal(to1e18(400))
    })

    it("should not allow queueing the same shares twice", async () => {
      // 600 free shares remain; queueing 700 must fail.
      await expect(
        vault
          .connect(delegator1)
          .requestUndelegate(operator.address, to1e18(700))
      ).to.be.revertedWith("InsufficientShares")
    })

    it("should keep pending shares earning rewards", async () => {
      await creditReward(operator.address, to1e18(100))
      // delegator1 holds the entire pool, pending exit included.
      expect(
        await vault.claimableRewardsOf(operator.address, delegator1.address)
      ).to.equal(to1e18(100))
    })

    it("should keep pending shares slashable", async () => {
      await reportSlash(operator.address, to1e18(500))
      // Price halved: 400 pending shares now back 200 T.
      expect(
        await vault.pendingUndelegationAssetsOf(operator.address)
      ).to.equal(to1e18(200))
    })
  })

  describe("finalizeUndelegate", () => {
    beforeEach(async () => {
      await createSnapshot()
      await ledger.setCurrentEpoch(operator.address, 3)
      await vault.connect(delegator1).delegate(operator.address, to1e18(1000))
      await vault
        .connect(delegator1)
        .requestUndelegate(operator.address, to1e18(400))
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("should revert for an unknown request id", async () => {
      await expect(
        vault.connect(delegator1).finalizeUndelegate(99)
      ).to.be.revertedWith("InvalidRequestId")
    })

    it("should revert when called by someone else than the delegator", async () => {
      await increaseTime(UNDELEGATION_DELAY)
      await expect(
        vault.connect(thirdParty).finalizeUndelegate(0)
      ).to.be.revertedWith("CallerNotRequestOwner")
    })

    it("should revert before the undelegation delay elapsed", async () => {
      await expect(
        vault.connect(delegator1).finalizeUndelegate(0)
      ).to.be.revertedWith("UndelegationDelayNotElapsed")
    })

    it("should revert while a wallet registered at or before the request epoch is live", async () => {
      await increaseTime(UNDELEGATION_DELAY)
      await seatAllocator.setExposure(operator.address, true, 3)
      await expect(
        vault.connect(delegator1).finalizeUndelegate(0)
      ).to.be.revertedWith("LiveWalletExposure")
    })

    it("should not be blocked by wallets registered after the request epoch", async () => {
      await increaseTime(UNDELEGATION_DELAY)
      // Oldest live exposure is epoch 4 > request epoch 3: exit unblocked.
      await seatAllocator.setExposure(operator.address, true, 4)
      await vault.connect(delegator1).finalizeUndelegate(0)
    })

    it("should burn shares at the current price and return T", async () => {
      await increaseTime(UNDELEGATION_DELAY)
      const balanceBefore = await tToken.balanceOf(delegator1.address)

      const tx = await vault.connect(delegator1).finalizeUndelegate(0)

      await expect(tx)
        .to.emit(vault, "UndelegationFinalized")
        .withArgs(
          0,
          operator.address,
          delegator1.address,
          to1e18(400),
          to1e18(400)
        )
      expect(await tToken.balanceOf(delegator1.address)).to.equal(
        balanceBefore.add(to1e18(400))
      )
      expect(
        await vault.sharesOf(operator.address, delegator1.address)
      ).to.equal(to1e18(600))
      expect(await vault.totalSharesOf(operator.address)).to.equal(to1e18(600))
      expect(await vault.delegatedAssetsOf(operator.address)).to.equal(
        to1e18(600)
      )
      expect(await vault.pendingSharesOf(operator.address)).to.equal(0)
      expect(
        await vault.queuedSharesOf(operator.address, delegator1.address)
      ).to.equal(0)
    })

    it("should revert when finalized twice", async () => {
      await increaseTime(UNDELEGATION_DELAY)
      await vault.connect(delegator1).finalizeUndelegate(0)
      await expect(
        vault.connect(delegator1).finalizeUndelegate(0)
      ).to.be.revertedWith("RequestAlreadyFinalized")
    })

    it("should make a slash during the waiting period be borne by the exiting delegator", async () => {
      await increaseTime(UNDELEGATION_DELAY)
      // Slash 250 with no self-bond: haircut on delegated assets.
      await reportSlash(operator.address, to1e18(250))
      await increaseTime(MOVEMENT_DELAY)
      await slashingModule.connect(thirdParty).executeSlash(0)

      const balanceBefore = await tToken.balanceOf(delegator1.address)
      await vault.connect(delegator1).finalizeUndelegate(0)
      // 400 shares * 750 T / 1000 shares = 300 T.
      expect(await tToken.balanceOf(delegator1.address)).to.equal(
        balanceBefore.add(to1e18(300))
      )
    })

    context("delegator-escape race", () => {
      it("should block finalization while a slash is pending and only release the post-slash amount", async () => {
        await increaseTime(UNDELEGATION_DELAY)

        // The offense is reported: the haircut is booked atomically...
        await reportSlash(operator.address, to1e18(250))
        expect(await vault.delegatedAssetsOf(operator.address)).to.equal(
          to1e18(750)
        )
        expect(
          await slashingModule.pendingSlashCount(operator.address)
        ).to.equal(1)

        // ...and the exit is blocked while the slash is pending, so the
        // delegator cannot escape between report and execution.
        await expect(
          vault.connect(delegator1).finalizeUndelegate(0)
        ).to.be.revertedWith("PendingSlashExists")

        // Still blocked right up until execution.
        await increaseTime(MOVEMENT_DELAY)
        await expect(
          vault.connect(delegator1).finalizeUndelegate(0)
        ).to.be.revertedWith("PendingSlashExists")

        await slashingModule.connect(thirdParty).executeSlash(0)
        expect(
          await slashingModule.pendingSlashCount(operator.address)
        ).to.equal(0)

        // Exit releases only the post-slash value of the shares.
        const balanceBefore = await tToken.balanceOf(delegator1.address)
        await vault.connect(delegator1).finalizeUndelegate(0)
        expect(await tToken.balanceOf(delegator1.address)).to.equal(
          balanceBefore.add(to1e18(300))
        )
      })
    })
  })

  describe("self-bond withdrawal", () => {
    describe("requestSelfBondWithdrawal", () => {
      before(async () => {
        await createSnapshot()
        await vault.connect(operator).depositSelfBond(to1e18(50000))
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should revert for a zero amount", async () => {
        await expect(
          vault.connect(operator).requestSelfBondWithdrawal(0)
        ).to.be.revertedWith("AmountCannotBeZero")
      })

      it("should revert for more than the unqueued self-bond", async () => {
        await expect(
          vault.connect(operator).requestSelfBondWithdrawal(to1e18(50001))
        ).to.be.revertedWith("InsufficientSelfBond")
      })

      it("should keep an Active operator above the minimum self-bond", async () => {
        // 50000 - 20000 = 30000 < 40000 minimum.
        await expect(
          vault.connect(operator).requestSelfBondWithdrawal(to1e18(20000))
        ).to.be.revertedWith("SelfBondBelowMinimum")
      })

      it("should queue a withdrawal within the minimum for an Active operator", async () => {
        await ledger.setCurrentEpoch(operator.address, 5)
        const tx = await vault
          .connect(operator)
          .requestSelfBondWithdrawal(to1e18(10000))
        await expect(tx)
          .to.emit(vault, "SelfBondWithdrawalRequested")
          .withArgs(0, operator.address, to1e18(10000), 5)
        expect(
          await vault.pendingSelfBondWithdrawalOf(operator.address)
        ).to.equal(to1e18(10000))
        // Self-bond itself is untouched until finalization.
        expect(await vault.selfBondOf(operator.address)).to.equal(to1e18(50000))
      })

      it("should count already-queued amounts against the minimum", async () => {
        // 40000 unqueued; queueing 5000 more would leave 35000 < 40000.
        await expect(
          vault.connect(operator).requestSelfBondWithdrawal(to1e18(5000))
        ).to.be.revertedWith("SelfBondBelowMinimum")
      })

      it("should let a Deactivating operator exit fully", async () => {
        await signerRegistry.setOperatorStatus(
          operator.address,
          OperatorStatus.Deactivating
        )
        await vault.connect(operator).requestSelfBondWithdrawal(to1e18(40000))
        expect(
          await vault.pendingSelfBondWithdrawalOf(operator.address)
        ).to.equal(to1e18(50000))
      })
    })

    describe("finalizeSelfBondWithdrawal", () => {
      beforeEach(async () => {
        await createSnapshot()
        await vault.connect(operator).depositSelfBond(to1e18(50000))
        await signerRegistry.setOperatorStatus(
          operator.address,
          OperatorStatus.Deactivating
        )
        await vault.connect(operator).requestSelfBondWithdrawal(to1e18(50000))
      })

      afterEach(async () => {
        await restoreSnapshot()
      })

      it("should revert when called by someone else than the provider", async () => {
        await increaseTime(UNDELEGATION_DELAY)
        await expect(
          vault.connect(delegator1).finalizeSelfBondWithdrawal(0)
        ).to.be.revertedWith("CallerNotRequestOwner")
      })

      it("should revert before the undelegation delay elapsed", async () => {
        await expect(
          vault.connect(operator).finalizeSelfBondWithdrawal(0)
        ).to.be.revertedWith("UndelegationDelayNotElapsed")
      })

      it("should revert while a slash is pending", async () => {
        await increaseTime(UNDELEGATION_DELAY)
        await reportSlash(operator.address, to1e18(1000))
        await expect(
          vault.connect(operator).finalizeSelfBondWithdrawal(0)
        ).to.be.revertedWith("PendingSlashExists")
      })

      it("should revert while a wallet registered at or before the request epoch is live", async () => {
        await increaseTime(UNDELEGATION_DELAY)
        await seatAllocator.setExposure(operator.address, true, 0)
        await expect(
          vault.connect(operator).finalizeSelfBondWithdrawal(0)
        ).to.be.revertedWith("LiveWalletExposure")
      })

      it("should transfer the queued self-bond", async () => {
        await increaseTime(UNDELEGATION_DELAY)
        const balanceBefore = await tToken.balanceOf(operator.address)
        const tx = await vault.connect(operator).finalizeSelfBondWithdrawal(0)
        await expect(tx)
          .to.emit(vault, "SelfBondWithdrawalFinalized")
          .withArgs(0, operator.address, to1e18(50000))
        expect(await tToken.balanceOf(operator.address)).to.equal(
          balanceBefore.add(to1e18(50000))
        )
        expect(await vault.selfBondOf(operator.address)).to.equal(0)
        expect(
          await vault.pendingSelfBondWithdrawalOf(operator.address)
        ).to.equal(0)
      })

      it("should revert when finalized twice", async () => {
        await increaseTime(UNDELEGATION_DELAY)
        await vault.connect(operator).finalizeSelfBondWithdrawal(0)
        await expect(
          vault.connect(operator).finalizeSelfBondWithdrawal(0)
        ).to.be.revertedWith("RequestAlreadyFinalized")
      })

      it("should cap the payout when the queued self-bond was slashed during the wait", async () => {
        await increaseTime(UNDELEGATION_DELAY)
        // First-loss: the slash consumes the queued self-bond.
        await reportSlash(operator.address, to1e18(20000))
        expect(await vault.selfBondOf(operator.address)).to.equal(to1e18(30000))
        expect(
          await vault.pendingSelfBondWithdrawalOf(operator.address)
        ).to.equal(to1e18(30000))

        await increaseTime(MOVEMENT_DELAY)
        await slashingModule.connect(thirdParty).executeSlash(0)

        const balanceBefore = await tToken.balanceOf(operator.address)
        const tx = await vault.connect(operator).finalizeSelfBondWithdrawal(0)
        await expect(tx)
          .to.emit(vault, "SelfBondWithdrawalFinalized")
          .withArgs(0, operator.address, to1e18(30000))
        expect(await tToken.balanceOf(operator.address)).to.equal(
          balanceBefore.add(to1e18(30000))
        )
        expect(await vault.selfBondOf(operator.address)).to.equal(0)
      })

      it("should consume queued self-bond before delegated assets", async () => {
        await signerRegistry.setOperatorStatus(
          operator.address,
          OperatorStatus.Active
        )
        await vault
          .connect(delegator1)
          .delegate(operator.address, to1e18(10000))

        // Slash 60000: the full 50000 self-bond (all queued) goes first,
        // only then the delegated tranche.
        await reportSlash(operator.address, to1e18(60000))
        expect(await vault.selfBondOf(operator.address)).to.equal(0)
        expect(
          await vault.pendingSelfBondWithdrawalOf(operator.address)
        ).to.equal(0)
        expect(await vault.delegatedAssetsOf(operator.address)).to.equal(0)
        expect(await vault.seizedBalance()).to.equal(to1e18(60000))
      })
    })
  })

  describe("applySlash and payoutSeized access control", () => {
    before(async () => {
      await createSnapshot()
      await vault.connect(delegator1).delegate(operator.address, to1e18(1000))
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should revert applySlash for a caller other than the slashing module", async () => {
      await expect(
        vault.connect(thirdParty).applySlash(operator.address, to1e18(100))
      ).to.be.revertedWith("CallerNotSlashingModule")
    })

    it("should revert payoutSeized for a caller other than the slashing module", async () => {
      await expect(
        vault.connect(thirdParty).payoutSeized(thirdParty.address, 1)
      ).to.be.revertedWith("CallerNotSlashingModule")
    })

    it("should apply slashes without refreshing the allocator (never-revert path)", async () => {
      // If applySlash called refreshAuthorization, this report would revert.
      await seatAllocator.setRevertOnRefresh(true)
      await reportSlash(operator.address, to1e18(100))
      expect(await vault.delegatedAssetsOf(operator.address)).to.equal(
        to1e18(900)
      )
      await seatAllocator.setRevertOnRefresh(false)
    })
  })

  describe("rewards", () => {
    before(async () => {
      await createSnapshot()
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should revert creditReward for a caller other than the distributor", async () => {
      await expect(
        vault.connect(thirdParty).creditReward(operator.address, to1e18(1))
      ).to.be.revertedWith("CallerNotRewardsDistributor")
    })

    it("should route rewards to the beneficiary when the pool has no shares", async () => {
      await signerRegistry.setBeneficiary(
        operator2.address,
        beneficiary.address
      )
      await tbtcToken.mint(vault.address, to1e18(10))
      await expect(
        distributor.creditRewardViaVault(
          vault.address,
          operator2.address,
          to1e18(10)
        )
      )
        .to.emit(vault, "RewardRoutedToBeneficiary")
        .withArgs(operator2.address, beneficiary.address, to1e18(10))

      const balanceBefore = await tbtcToken.balanceOf(beneficiary.address)
      await vault.connect(beneficiary).claimRewards(operator2.address)
      expect(await tbtcToken.balanceOf(beneficiary.address)).to.equal(
        balanceBefore.add(to1e18(10))
      )
    })

    it("should distribute rewards pro-rata to shares across delegators", async () => {
      // delegator1: 100 shares alone; first credit is all theirs.
      await vault.connect(delegator1).delegate(operator.address, to1e18(100))
      await creditReward(operator.address, to1e18(30))
      expect(
        await vault.claimableRewardsOf(operator.address, delegator1.address)
      ).to.equal(to1e18(30))

      // delegator2 joins with 300 shares; second credit splits 1:3.
      await vault.connect(delegator2).delegate(operator.address, to1e18(300))
      await creditReward(operator.address, to1e18(40))
      expect(
        await vault.claimableRewardsOf(operator.address, delegator1.address)
      ).to.equal(to1e18(40))
      expect(
        await vault.claimableRewardsOf(operator.address, delegator2.address)
      ).to.equal(to1e18(30))
    })

    it("should transfer TBTC on claim", async () => {
      const balanceBefore = await tbtcToken.balanceOf(delegator1.address)
      const tx = await vault.connect(delegator1).claimRewards(operator.address)
      await expect(tx)
        .to.emit(vault, "RewardsClaimed")
        .withArgs(operator.address, delegator1.address, to1e18(40))
      expect(await tbtcToken.balanceOf(delegator1.address)).to.equal(
        balanceBefore.add(to1e18(40))
      )
      expect(
        await vault.claimableRewardsOf(operator.address, delegator1.address)
      ).to.equal(0)
    })

    it("should revert when there is nothing to claim", async () => {
      await expect(
        vault.connect(delegator1).claimRewards(operator.address)
      ).to.be.revertedWith("NothingToClaim")
    })

    it("should keep shares queued for undelegation earning", async () => {
      await vault
        .connect(delegator2)
        .requestUndelegate(operator.address, to1e18(300))
      await creditReward(operator.address, to1e18(40))
      // delegator2 still holds 300 of 400 shares.
      expect(
        await vault.claimableRewardsOf(operator.address, delegator2.address)
      ).to.equal(to1e18(60)) // 30 from before + 30 now
      expect(
        await vault.claimableRewardsOf(operator.address, delegator1.address)
      ).to.equal(to1e18(10))
    })
  })
})
