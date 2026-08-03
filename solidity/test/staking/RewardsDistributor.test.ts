import { randomBytes } from "crypto"
import { ethers, helpers, waffle } from "hardhat"
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers"
import { expect } from "chai"
import { to1e18 } from "../helpers/contract-test-helpers"
import type {
  RewardsDistributor,
  StakingMockSignerRegistryLite,
  StakingFeeMockStakeVault,
  StakingTestToken,
} from "../../typechain"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { increaseTime } = helpers.time

describe("RewardsDistributor", () => {
  let deployer: SignerWithAddress
  let seatAllocator: SignerWithAddress
  let feeRouter: SignerWithAddress
  let beneficiary: SignerWithAddress
  let thirdParty: SignerWithAddress
  let provider1: SignerWithAddress
  let provider2: SignerWithAddress

  let tbtc: StakingTestToken
  let stakeVault: StakingFeeMockStakeVault
  let signerRegistry: StakingMockSignerRegistryLite
  let rewardsDistributor: RewardsDistributor

  // Notifies a reward the way the fee router does: transfer first, then
  // account.
  async function notify(amount: number) {
    const value = to1e18(amount)
    await tbtc.mint(rewardsDistributor.address, value)
    await rewardsDistributor.connect(feeRouter).notifyReward(value)
  }

  const fixture = async () => {
    const signers = await ethers.getSigners()
    ;[
      deployer,
      seatAllocator,
      feeRouter,
      beneficiary,
      thirdParty,
      provider1,
      provider2,
    ] = signers

    // Fully qualified names: other staking test suites define mocks with
    // overlapping contract names.
    const TokenFactory = await ethers.getContractFactory(
      "contracts/test/staking/StakingFeeMocks.sol:StakingTestToken"
    )
    tbtc = (await TokenFactory.connect(deployer).deploy()) as StakingTestToken

    const VaultFactory = await ethers.getContractFactory(
      "contracts/test/staking/StakingFeeMocks.sol:StakingFeeMockStakeVault"
    )
    stakeVault = (await VaultFactory.connect(
      deployer
    ).deploy()) as StakingFeeMockStakeVault

    const RegistryFactory = await ethers.getContractFactory(
      "contracts/test/staking/StakingFeeMocks.sol:StakingMockSignerRegistryLite"
    )
    signerRegistry = (await RegistryFactory.connect(
      deployer
    ).deploy()) as StakingMockSignerRegistryLite

    const deployment = await helpers.upgrades.deployProxy(
      // Hacky workaround allowing to deploy proxy contract any number of times
      // without clearing `deployments/hardhat` directory.
      // See: https://github.com/keep-network/hardhat-helpers/issues/38
      `RewardsDistributor_${randomBytes(8).toString("hex")}`,
      {
        contractName: "RewardsDistributor",
        initializerArgs: [
          tbtc.address,
          stakeVault.address,
          signerRegistry.address,
          seatAllocator.address,
          feeRouter.address,
        ],
        factoryOpts: { signer: deployer },
        proxyOpts: {
          kind: "transparent",
        },
      }
    )
    rewardsDistributor = deployment[0] as RewardsDistributor

    return { tbtc, stakeVault, signerRegistry, rewardsDistributor }
  }

  before(async () => {
    // eslint-disable-next-line @typescript-eslint/no-extra-semi
    ;({ tbtc, stakeVault, signerRegistry, rewardsDistributor } =
      await waffle.loadFixture(fixture))
  })

  describe("initialize", () => {
    it("should wire all addresses", async () => {
      expect(await rewardsDistributor.tbtcToken()).to.equal(tbtc.address)
      expect(await rewardsDistributor.stakeVault()).to.equal(stakeVault.address)
      expect(await rewardsDistributor.signerRegistry()).to.equal(
        signerRegistry.address
      )
      expect(await rewardsDistributor.seatAllocator()).to.equal(
        seatAllocator.address
      )
      expect(await rewardsDistributor.feeRouter()).to.equal(feeRouter.address)
      expect(await rewardsDistributor.totalWeight()).to.equal(0)
      expect(await rewardsDistributor.accRewardPerWeight()).to.equal(0)
    })

    it("should revert when initialized again", async () => {
      await expect(
        rewardsDistributor.initialize(
          tbtc.address,
          stakeVault.address,
          signerRegistry.address,
          seatAllocator.address,
          feeRouter.address
        )
      ).to.be.revertedWith("Initializable: contract is already initialized")
    })

    it("should allow deferred set-once cycle wiring", async () => {
      const [instance] = await helpers.upgrades.deployProxy(
        `RewardsDistributorDeferred_${randomBytes(8).toString("hex")}`,
        {
          contractName: "RewardsDistributor",
          initializerArgs: [
            tbtc.address,
            stakeVault.address,
            signerRegistry.address,
            ethers.constants.AddressZero,
            ethers.constants.AddressZero,
          ],
          factoryOpts: { signer: deployer },
          proxyOpts: { kind: "transparent" },
        }
      )

      await instance.connect(deployer).setSeatAllocator(seatAllocator.address)
      await instance.connect(deployer).setFeeRouter(feeRouter.address)
      expect(await instance.seatAllocator()).to.equal(seatAllocator.address)
      expect(await instance.feeRouter()).to.equal(feeRouter.address)
      await expect(
        instance.connect(deployer).setSeatAllocator(seatAllocator.address)
      ).to.be.revertedWith("AlreadySet")
      await expect(
        instance.connect(deployer).setFeeRouter(feeRouter.address)
      ).to.be.revertedWith("AlreadySet")
    })
  })

  describe("access control", () => {
    it("should revert notifyReward from a caller other than the fee router", async () => {
      await expect(
        rewardsDistributor.connect(thirdParty).notifyReward(to1e18(1))
      ).to.be.revertedWith("CallerNotFeeRouter")
      await expect(
        rewardsDistributor.connect(seatAllocator).notifyReward(to1e18(1))
      ).to.be.revertedWith("CallerNotFeeRouter")
    })

    it("should revert carry recovery from a caller other than the fee router", async () => {
      await expect(
        rewardsDistributor
          .connect(thirdParty)
          .recoverUndistributedRewards(thirdParty.address)
      ).to.be.revertedWith("CallerNotFeeRouterOrOwner")
    })

    it("should revert onWeightChanged from a caller other than the seat allocator", async () => {
      await expect(
        rewardsDistributor
          .connect(thirdParty)
          .onWeightChanged(provider1.address, to1e18(100))
      ).to.be.revertedWith("CallerNotSeatAllocator")
      await expect(
        rewardsDistributor
          .connect(feeRouter)
          .onWeightChanged(provider1.address, to1e18(100))
      ).to.be.revertedWith("CallerNotSeatAllocator")
    })
  })

  describe("notifyReward", () => {
    context("when the total weight is zero", () => {
      before(async () => {
        await createSnapshot()
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should carry the amount as undistributed", async () => {
        const tx = await rewardsDistributor
          .connect(feeRouter)
          .notifyReward(to1e18(100))

        expect(await rewardsDistributor.undistributedRewards()).to.equal(
          to1e18(100)
        )
        expect(await rewardsDistributor.accRewardPerWeight()).to.equal(0)
        await expect(tx)
          .to.emit(rewardsDistributor, "RewardNotified")
          .withArgs(to1e18(100), 0)
      })

      it("should fold the undistributed carry into the next tranche at non-zero weight", async () => {
        await rewardsDistributor
          .connect(seatAllocator)
          .onWeightChanged(provider1.address, to1e18(100))

        const tx = await rewardsDistributor
          .connect(feeRouter)
          .notifyReward(to1e18(100))

        // (100 + 100 carried) over weight 100 -> 2e18 per weight unit.
        expect(await rewardsDistributor.undistributedRewards()).to.equal(0)
        expect(await rewardsDistributor.accRewardPerWeight()).to.equal(
          to1e18(2)
        )
        expect(
          await rewardsDistributor.pendingRewardOf(provider1.address)
        ).to.equal(to1e18(200))
        await expect(tx)
          .to.emit(rewardsDistributor, "RewardNotified")
          .withArgs(to1e18(100), to1e18(100))
      })
    })

    context("when the total weight is non-zero", () => {
      before(async () => {
        await createSnapshot()
        await rewardsDistributor
          .connect(seatAllocator)
          .onWeightChanged(provider1.address, to1e18(100))
        await rewardsDistributor
          .connect(seatAllocator)
          .onWeightChanged(provider2.address, to1e18(300))
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should split the tranche pro rata to weight", async () => {
        await notify(400)

        expect(
          await rewardsDistributor.pendingRewardOf(provider1.address)
        ).to.equal(to1e18(100))
        expect(
          await rewardsDistributor.pendingRewardOf(provider2.address)
        ).to.equal(to1e18(300))
      })
    })
  })

  describe("recoverUndistributedRewards", () => {
    before(async () => {
      await createSnapshot()
      await tbtc.mint(rewardsDistributor.address, to1e18(100))
      await rewardsDistributor.connect(feeRouter).notifyReward(to1e18(100))
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("returns a zero-weight carry to the fee router's recipient", async () => {
      const recipientBalanceBefore = await tbtc.balanceOf(thirdParty.address)
      const tx = await rewardsDistributor
        .connect(feeRouter)
        .recoverUndistributedRewards(thirdParty.address)

      await expect(tx)
        .to.emit(rewardsDistributor, "UndistributedRewardsRecovered")
        .withArgs(thirdParty.address, to1e18(100))
      expect(await rewardsDistributor.undistributedRewards()).to.equal(0)
      expect(await tbtc.balanceOf(thirdParty.address)).to.equal(
        recipientBalanceBefore.add(to1e18(100))
      )
    })
  })

  describe("onWeightChanged", () => {
    before(async () => {
      await createSnapshot()
      await rewardsDistributor
        .connect(seatAllocator)
        .onWeightChanged(provider1.address, to1e18(100))
      await rewardsDistributor
        .connect(seatAllocator)
        .onWeightChanged(provider2.address, to1e18(300))
      await notify(400)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should settle rewards accrued before the change at the old weight", async () => {
      // provider1: 100 accrued at weight 100. Raise to 300.
      const tx = await rewardsDistributor
        .connect(seatAllocator)
        .onWeightChanged(provider1.address, to1e18(300))

      await expect(tx)
        .to.emit(rewardsDistributor, "WeightChanged")
        .withArgs(provider1.address, to1e18(100), to1e18(300))
      expect(await rewardsDistributor.totalWeight()).to.equal(to1e18(600))
      expect(
        await rewardsDistributor.accruedRewards(provider1.address)
      ).to.equal(to1e18(100))

      // The next tranche lands at the new weights: 600 over weight 600.
      await notify(600)

      expect(
        await rewardsDistributor.pendingRewardOf(provider1.address)
      ).to.equal(to1e18(400)) // 100 at old weight + 300 at new weight
      expect(
        await rewardsDistributor.pendingRewardOf(provider2.address)
      ).to.equal(to1e18(600)) // 300 + 300
    })

    it("should exclude a provider whose weight drops to zero from future tranches", async () => {
      await rewardsDistributor
        .connect(seatAllocator)
        .onWeightChanged(provider1.address, 0)

      const pendingBefore = await rewardsDistributor.pendingRewardOf(
        provider1.address
      )

      await notify(300)

      // provider1's pending did not grow; provider2 got the full tranche.
      expect(
        await rewardsDistributor.pendingRewardOf(provider1.address)
      ).to.equal(pendingBefore)
      expect(
        await rewardsDistributor.pendingRewardOf(provider2.address)
      ).to.equal(to1e18(900))
      expect(await rewardsDistributor.totalWeight()).to.equal(to1e18(300))
    })
  })

  describe("settleOperator", () => {
    context("when nothing has accrued", () => {
      before(async () => {
        await createSnapshot()
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should be a no-op, not a revert", async () => {
        const tx = await rewardsDistributor
          .connect(thirdParty)
          .settleOperator(provider1.address)

        await expect(tx).to.not.emit(rewardsDistributor, "OperatorSettled")
        expect(await stakeVault.creditCount()).to.equal(0)
        expect(await tbtc.balanceOf(stakeVault.address)).to.equal(0)
      })
    })

    context("when rewards have accrued", () => {
      before(async () => {
        await createSnapshot()
        await signerRegistry.setCommissionBps(provider1.address, 1000) // 10%
        await rewardsDistributor
          .connect(seatAllocator)
          .onWeightChanged(provider1.address, to1e18(100))
        await rewardsDistributor
          .connect(seatAllocator)
          .onWeightChanged(provider2.address, to1e18(300))
        await notify(400)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should split the accrual between commission and the vault", async () => {
        // provider1: 100 accrued, 10% commission.
        const tx = await rewardsDistributor
          .connect(thirdParty)
          .settleOperator(provider1.address)

        await expect(tx)
          .to.emit(rewardsDistributor, "OperatorSettled")
          .withArgs(provider1.address, to1e18(10), to1e18(90))

        // Commission stays claimable in the distributor; the delegator
        // share was transferred to the vault and credited.
        expect(
          await rewardsDistributor.operatorCommission(provider1.address)
        ).to.equal(to1e18(10))
        expect(await tbtc.balanceOf(stakeVault.address)).to.equal(to1e18(90))
        expect(await stakeVault.creditCount()).to.equal(1)
        expect(await stakeVault.lastCreditProvider()).to.equal(
          provider1.address
        )
        expect(await stakeVault.lastCreditAmount()).to.equal(to1e18(90))
        expect(
          await rewardsDistributor.accruedRewards(provider1.address)
        ).to.equal(0)
        expect(
          await rewardsDistributor.pendingRewardOf(provider1.address)
        ).to.equal(0)
      })

      it("should send the full accrual to the vault at zero commission", async () => {
        // provider2 has no commission configured (0 bps).
        await rewardsDistributor
          .connect(thirdParty)
          .settleOperator(provider2.address)

        expect(
          await rewardsDistributor.operatorCommission(provider2.address)
        ).to.equal(0)
        expect(await stakeVault.creditedTo(provider2.address)).to.equal(
          to1e18(300)
        )
        expect(await tbtc.balanceOf(stakeVault.address)).to.equal(
          to1e18(90).add(to1e18(300))
        )
      })

      it("should keep everything as commission at 100% commission", async () => {
        const effectiveAt =
          (await ethers.provider.getBlock("latest")).timestamp + 100
        await signerRegistry.setCommissionSchedule(
          provider1.address,
          1000,
          10000,
          effectiveAt
        )
        await increaseTime(100)
        await notify(400)

        // provider1 weight 100 of total 400: accrues 100.
        const vaultBalanceBefore = await tbtc.balanceOf(stakeVault.address)
        const creditCountBefore = await stakeVault.creditCount()

        await rewardsDistributor
          .connect(thirdParty)
          .settleOperator(provider1.address)

        expect(
          await rewardsDistributor.operatorCommission(provider1.address)
        ).to.equal(to1e18(10).add(to1e18(100)))
        expect(await tbtc.balanceOf(stakeVault.address)).to.equal(
          vaultBalanceBefore
        )
        expect(await stakeVault.creditCount()).to.equal(creditCountBefore)
      })

      it("should not retroactively apply an uncheckpointed mock rate change", async () => {
        // provider2 accrues another tranche, then this deliberately simplistic
        // mock changes its base rate without a notice boundary. The distributor
        // keeps using the checkpointed rate instead of repricing history.
        await notify(400)
        await signerRegistry.setCommissionBps(provider2.address, 2000)

        const tx = await rewardsDistributor
          .connect(thirdParty)
          .settleOperator(provider2.address)

        // provider2 was settled after the first tranche; since then two more
        // tranches landed at weight 300/400, all under its checkpointed 0%.
        await expect(tx)
          .to.emit(rewardsDistributor, "OperatorSettled")
          .withArgs(provider2.address, 0, to1e18(600))
      })
    })

    context("when amounts do not divide evenly", () => {
      before(async () => {
        await createSnapshot()
        // Weight of 3 wei against a 10 wei tranche.
        await rewardsDistributor
          .connect(seatAllocator)
          .onWeightChanged(provider1.address, 3)
        await tbtc.mint(rewardsDistributor.address, 10)
        await rewardsDistributor.connect(feeRouter).notifyReward(10)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should round down and leave the dust in the distributor", async () => {
        // acc = floor(10e18 / 3); pending = floor(3 * acc / 1e18) = 9.
        expect(
          await rewardsDistributor.pendingRewardOf(provider1.address)
        ).to.equal(9)

        await rewardsDistributor
          .connect(thirdParty)
          .settleOperator(provider1.address)

        expect(await tbtc.balanceOf(stakeVault.address)).to.equal(9)
        expect(await tbtc.balanceOf(rewardsDistributor.address)).to.equal(1)
      })
    })
  })

  describe("commission notice boundary", () => {
    beforeEach(async () => {
      await createSnapshot()
      await signerRegistry.setCommissionBps(provider1.address, 1000)
      await rewardsDistributor
        .connect(seatAllocator)
        .onWeightChanged(provider1.address, to1e18(100))
    })

    afterEach(async () => {
      await restoreSnapshot()
    })

    it("should charge the old and new rates only on their respective tranches", async () => {
      const latestBlock = await ethers.provider.getBlock("latest")
      const effectiveAt = latestBlock.timestamp + 100
      await signerRegistry.setCommissionSchedule(
        provider1.address,
        1000,
        2000,
        effectiveAt
      )

      await notify(100)
      await increaseTime(100)
      await notify(100)

      await expect(
        rewardsDistributor.connect(thirdParty).settleOperator(provider1.address)
      )
        .to.emit(rewardsDistributor, "OperatorSettled")
        .withArgs(provider1.address, to1e18(30), to1e18(170))
    })

    it("should preserve a matured rate when a new schedule replaces it", async () => {
      let latestBlock = await ethers.provider.getBlock("latest")
      await signerRegistry.setCommissionSchedule(
        provider1.address,
        1000,
        2000,
        latestBlock.timestamp + 100
      )
      await increaseTime(100)

      // Mirrors SignerRegistry declaring again: checkpoint the matured rate
      // even though no reward landed under the first schedule, then overwrite.
      await rewardsDistributor
        .connect(seatAllocator)
        .onWeightChanged(provider1.address, to1e18(100))
      latestBlock = await ethers.provider.getBlock("latest")
      await signerRegistry.setCommissionSchedule(
        provider1.address,
        2000,
        3000,
        latestBlock.timestamp + 100
      )

      await notify(100)
      await increaseTime(100)
      await notify(100)
      await expect(
        rewardsDistributor.connect(thirdParty).settleOperator(provider1.address)
      )
        .to.emit(rewardsDistributor, "OperatorSettled")
        .withArgs(provider1.address, to1e18(50), to1e18(150))
    })
  })

  describe("claimCommission", () => {
    before(async () => {
      await createSnapshot()
      await signerRegistry.setCommissionBps(provider1.address, 1000)
      await signerRegistry.setBeneficiary(
        provider1.address,
        beneficiary.address
      )
      await rewardsDistributor
        .connect(seatAllocator)
        .onWeightChanged(provider1.address, to1e18(100))
      await notify(100)
      await rewardsDistributor
        .connect(thirdParty)
        .settleOperator(provider1.address)
      // 10 TBTC of commission is now claimable by the beneficiary.
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should revert for a caller other than the beneficiary", async () => {
      await expect(
        rewardsDistributor
          .connect(thirdParty)
          .claimCommission(provider1.address)
      ).to.be.revertedWith("CallerNotBeneficiary")
      await expect(
        rewardsDistributor.connect(provider1).claimCommission(provider1.address)
      ).to.be.revertedWith("CallerNotBeneficiary")
    })

    it("should transfer the commission to the beneficiary", async () => {
      const tx = await rewardsDistributor
        .connect(beneficiary)
        .claimCommission(provider1.address)

      await expect(tx)
        .to.emit(rewardsDistributor, "CommissionClaimed")
        .withArgs(provider1.address, beneficiary.address, to1e18(10))
      expect(await tbtc.balanceOf(beneficiary.address)).to.equal(to1e18(10))
      expect(
        await rewardsDistributor.operatorCommission(provider1.address)
      ).to.equal(0)
    })

    it("should revert when there is nothing left to claim", async () => {
      await expect(
        rewardsDistributor
          .connect(beneficiary)
          .claimCommission(provider1.address)
      ).to.be.revertedWith("NothingToClaim")
    })
  })

  // Model B: the seat allocator feeds the distributor each operator's UNCAPPED
  // reward weight (its delegated capital), so revenue tracks capital and
  // over-cap delegation no longer dilutes a pool's existing delegators. The
  // allocator's uncapped-vs-capped computation is proven in the SeatAllocator
  // suite; here we exercise the distributor's response to those weights.
  describe("Model B reward weighting", () => {
    before(async () => {
      await createSnapshot()
      // Two operators start with equal capital (equal uncapped weight).
      await rewardsDistributor
        .connect(seatAllocator)
        .onWeightChanged(provider1.address, to1e18(100))
      await rewardsDistributor
        .connect(seatAllocator)
        .onWeightChanged(provider2.address, to1e18(100))
      // First tranche at parity: each accrues 100.
      await notify(200)
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("earns strictly more with more uncapped capital, without diluting existing delegators", async () => {
      // provider1 attracts +100 of (over-cap) capital; under Model B its
      // reward weight grows one-for-one to 200. Its seat/registry weight would
      // stay capped (SeatAllocator suite), but the reward leg is uncapped.
      await rewardsDistributor
        .connect(seatAllocator)
        .onWeightChanged(provider1.address, to1e18(200))

      // The first-tranche accrual settled at the old weight 100.
      expect(
        await rewardsDistributor.accruedRewards(provider1.address)
      ).to.equal(to1e18(100))
      expect(await rewardsDistributor.totalWeight()).to.equal(to1e18(300))

      const p1Before = await rewardsDistributor.pendingRewardOf(
        provider1.address
      )
      const p2Before = await rewardsDistributor.pendingRewardOf(
        provider2.address
      )

      // Second tranche of 300 lands across weights 200 / 100.
      await notify(300)

      const p1Incremental = (
        await rewardsDistributor.pendingRewardOf(provider1.address)
      ).sub(p1Before)
      const p2Incremental = (
        await rewardsDistributor.pendingRewardOf(provider2.address)
      ).sub(p2Before)

      // provider1 (weight 200) earns strictly more than provider2 (100),
      // exactly 2:1 — proportional to uncapped capital.
      expect(p1Incremental).to.equal(to1e18(200))
      expect(p2Incremental).to.equal(to1e18(100))
      expect(p1Incremental.gt(p2Incremental)).to.be.true
      expect(p1Incremental).to.equal(p2Incremental.mul(2))

      // No dilution: per-unit-capital yield is equal across the pool that grew
      // (200 reward / 200 capital = 1.0) and the pool that did not
      // (100 reward / 100 capital = 1.0).
      expect(p1Incremental.mul(100)).to.equal(p2Incremental.mul(200))

      // Contrast Model A (capped): provider1's weight would have stayed 100,
      // so of the 300 tranche it earns 300 * 100 / 200 = 150 on 200 capital
      // → yield 0.75 < provider2's 1.5. The over-cap capital would have
      // diluted provider1's own delegators for zero extra pool reward.
      const modelACounterfactual = to1e18(300).mul(100).div(200) // 150
      expect(p1Incremental.gt(modelACounterfactual)).to.be.true
    })
  })
})
