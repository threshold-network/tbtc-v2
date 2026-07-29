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
        await signerRegistry.setCommissionBps(provider1.address, 10000)
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

      it("should apply the commission rate effective at settlement time", async () => {
        // provider2 accrues another tranche, then its commission changes
        // before settlement: the new rate applies to the whole unsettled
        // accrual (commission timing across rate changes is enforced by the
        // signer registry's notice period, mirrored here by the mock).
        await notify(400)
        await signerRegistry.setCommissionBps(provider2.address, 2000)

        const tx = await rewardsDistributor
          .connect(thirdParty)
          .settleOperator(provider2.address)

        // provider2 was settled after the first tranche; since then two
        // more tranches of 400 landed at weight 300/400, so 600 is
        // unsettled, split at the new 20% rate.
        await expect(tx)
          .to.emit(rewardsDistributor, "OperatorSettled")
          .withArgs(provider2.address, to1e18(120), to1e18(480))
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
})
