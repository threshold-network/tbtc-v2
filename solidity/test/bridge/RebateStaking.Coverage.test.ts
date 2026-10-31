import { ethers, helpers } from "hardhat"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { expect } from "chai"
import type {
  Bridge,
  BridgeGovernance,
  BridgeStub,
  RebateStaking,
  TestERC20,
} from "../../typechain"
import bridgeFixture from "../fixtures/bridge"
import { to1e18 } from "../helpers/contract-test-helpers"

const { createSnapshot, restoreSnapshot } = helpers.snapshot
const { lastBlockTime, increaseTime } = helpers.time

/**
 * Coverage for the statements that the reservations scope leaves uncovered in
 * `RebateStaking.sol`:
 *
 * - `initialize` (line 147): the `ParametersCannotBeZero` guard.
 * - `getRebateCap` (line 286): the `rebatePerToken == 0` early return.
 * - `applyForRebate` (line 383): the `rebateCap <= currentRebate` early return.
 * - `cancelRebate` (line 463): the `rollingWindowStartIndex` advance.
 * - `forceStakeTransfer` (line 624): the rebate-array copy.
 *
 * Each case drives the statement through the public surface, so the assertion
 * is on the observable effect and not on a storage slot.
 */
describe("RebateStaking - uncovered statement coverage", () => {
  let deployer: HardhatEthersSigner
  let governance: HardhatEthersSigner
  let thirdParty: HardhatEthersSigner
  let bridge: Bridge & BridgeStub
  let bridgeGovernance: BridgeGovernance
  let t: TestERC20
  let rebateStaking: RebateStaking

  const stakeAmount = to1e18(100000000)
  const treasuryFee = BigInt(950)

  before(async () => {
    ;({
      deployer,
      governance,
      thirdParty,
      bridge,
      bridgeGovernance,
      t,
      rebateStaking,
    } = await bridgeFixture())

    // The Bridge is the only caller `RebateStaking.applyForRebate` and
    // `RebateStaking.cancelRebate` accept, so the fixture's Bridge has to
    // point at the rebate staking contract before either is reachable.
    await bridgeGovernance
      .connect(governance)
      .setRebateStaking(rebateStaking.target)
  })

  describe("initialize", () => {
    // Deploys a fresh `RebateStaking` proxy with the given initializer
    // arguments. A failing `require` in the initializer surfaces as a failed
    // deployment, which is how the guard is asserted.
    const deployProxy = async (
      bridgeAddress: string,
      tokenAddress: string,
      rollingWindow: number,
      unstakingPeriod: number,
      rebatePerToken: number
    ) => {
      const factory = await ethers.getContractFactory("RebateStaking", {
        signer: deployer,
      })
      const implementation = await factory.deploy()
      await implementation.waitForDeployment()

      const proxyFactory = await ethers.getContractFactory(
        "TransparentUpgradeableProxy",
        deployer
      )
      return proxyFactory.deploy(
        implementation.target,
        deployer.address,
        factory.interface.encodeFunctionData("initialize", [
          bridgeAddress,
          tokenAddress,
          rollingWindow,
          unstakingPeriod,
          rebatePerToken,
        ])
      )
    }

    context("when the bridge address is zero", () => {
      it("should revert", async () => {
        await expect(
          deployProxy(ethers.ZeroAddress, t.target as string, 100, 100, 100)
        ).to.be.revertedWithCustomError(
          await ethers.getContractFactory("RebateStaking"),
          "ParametersCannotBeZero"
        )
      })
    })

    context("when the token address is zero", () => {
      it("should revert", async () => {
        await expect(
          deployProxy(bridge.target as string, ethers.ZeroAddress, 100, 100, 100)
        ).to.be.revertedWithCustomError(
          await ethers.getContractFactory("RebateStaking"),
          "ParametersCannotBeZero"
        )
      })
    })

    context("when the rolling window is zero", () => {
      it("should revert", async () => {
        await expect(
          deployProxy(bridge.target as string, t.target as string, 0, 100, 100)
        ).to.be.revertedWithCustomError(
          await ethers.getContractFactory("RebateStaking"),
          "ParametersCannotBeZero"
        )
      })
    })

    context("when all parameters are non-zero", () => {
      it("should initialize the contract", async () => {
        const proxy = await deployProxy(
          bridge.target as string,
          t.target as string,
          100,
          200,
          300
        )
        const initialized = await ethers.getContractAt(
          "RebateStaking",
          proxy.target
        )

        expect(await initialized.bridge()).to.be.equal(bridge.target)
        expect(await initialized.token()).to.be.equal(t.target)
        expect(await initialized.rollingWindow()).to.be.equal(100)
        expect(await initialized.unstakingPeriod()).to.be.equal(200)
        expect(await initialized.rebatePerToken()).to.be.equal(300)
      })
    })
  })

  describe("getRebateCap", () => {
    before(async () => {
      await createSnapshot()

      await t.connect(deployer).mint(thirdParty.address, stakeAmount)
      await t.connect(thirdParty).approve(rebateStaking.target, stakeAmount)
      await rebateStaking.connect(thirdParty).stake(stakeAmount)
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when the rebate per token is zero", () => {
      before(async () => {
        await createSnapshot()

        await rebateStaking.connect(deployer).updateRebatePerToken(0)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should return a zero cap", async () => {
        expect(
          await rebateStaking.getRebateCap(thirdParty.address)
        ).to.be.equal(0)
      })

      it("should return a zero available rebate", async () => {
        expect(
          await rebateStaking.getAvailableRebate(thirdParty.address)
        ).to.be.equal(0)
      })

      it("should keep the stake intact", async () => {
        expect(await rebateStaking.getStake(thirdParty.address)).to.be.equal(
          stakeAmount
        )
      })
    })

    context("when the rebate per token is non-zero", () => {
      it("should return the cap computed from the stake", async () => {
        const rebatePerToken = await rebateStaking.rebatePerToken()
        expect(
          await rebateStaking.getRebateCap(thirdParty.address)
        ).to.be.equal(stakeAmount / rebatePerToken)
      })
    })
  })

  describe("applyForRebate", () => {
    before(async () => {
      await createSnapshot()

      await t.connect(deployer).mint(thirdParty.address, stakeAmount)
      await t.connect(thirdParty).approve(rebateStaking.target, stakeAmount)
      await rebateStaking.connect(thirdParty).stake(stakeAmount)
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when the rolling-window cap is already exhausted", () => {
      before(async () => {
        await createSnapshot()

        // Consume the whole rebate cap: the rebate per token divides the
        // stake into exactly one unit of cap, so a single rebate of that
        // size exhausts it.
        const rebateCap = await rebateStaking.getRebateCap(thirdParty.address)
        await bridge.applyForRebate(thirdParty.address, rebateCap)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should return the fee without change", async () => {
        await bridge.applyForRebate(thirdParty.address, treasuryFee)

        expect(await bridge.lastTreasuryFee()).to.be.equal(treasuryFee)
      })

      it("should not consume any further rebate", async () => {
        const rebateCap = await rebateStaking.getRebateCap(thirdParty.address)
        expect(
          await rebateStaking.getAvailableRebate(thirdParty.address)
        ).to.be.equal(0)
        expect(
          await rebateStaking.getRebateLength(thirdParty.address)
        ).to.be.equal(1)
        expect(rebateCap).to.be.greaterThan(0)
      })
    })
  })

  describe("cancelRebate", () => {
    before(async () => {
      await createSnapshot()

      await t.connect(deployer).mint(thirdParty.address, stakeAmount)
      await t.connect(thirdParty).approve(rebateStaking.target, stakeAmount)
      await rebateStaking.connect(thirdParty).stake(stakeAmount)
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when a rebate has aged out of the rolling window", () => {
      before(async () => {
        await createSnapshot()

        // A rebate recorded before the rolling window starts. The cancel
        // walks the rebate array and skips the entry instead of matching it,
        // which is what advances the rolling-window start index.
        const rollingWindow = Number(await rebateStaking.rollingWindow())
        await bridge.applyForRebate(thirdParty.address, treasuryFee)
        const requestedAt = await lastBlockTime()
        await increaseTime(rollingWindow + 1)
        await bridge.applyForRebate(thirdParty.address, treasuryFee)

        await bridge.cancelRebate(thirdParty.address, requestedAt)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should drop the aged-out rebate from the rolling window", async () => {
        // The aged-out rebate no longer counts against the cap, so the
        // available rebate is the cap minus the one rebate still in window.
        const rebateCap = await rebateStaking.getRebateCap(thirdParty.address)
        expect(
          await rebateStaking.getAvailableRebate(thirdParty.address)
        ).to.be.equal(rebateCap - treasuryFee)
      })

      it("should keep both rebate entries in the array", async () => {
        expect(
          await rebateStaking.getRebateLength(thirdParty.address)
        ).to.be.equal(2)
      })

      it("should not cancel the aged-out rebate", async () => {
        // The aged-out rebate keeps its value: the cancel skipped it rather
        // than zeroing it.
        const [, rebateAmount] = await rebateStaking.getRebate(
          thirdParty.address,
          0
        )
        expect(rebateAmount).to.be.equal(treasuryFee)
      })
    })
  })

  describe("forceStakeTransfer", () => {
    before(async () => {
      await createSnapshot()

      await t.connect(deployer).mint(thirdParty.address, stakeAmount)
      await t.connect(thirdParty).approve(rebateStaking.target, stakeAmount)
      await rebateStaking.connect(thirdParty).stake(stakeAmount)
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when the old staker has rebates", () => {
      let oldStakerRebateCap: bigint

      before(async () => {
        await createSnapshot()

        // Record two rebates on the old staker so the transfer has a
        // non-empty array to copy.
        await bridge.applyForRebate(thirdParty.address, treasuryFee)
        await increaseTime(1)
        await bridge.applyForRebate(thirdParty.address, treasuryFee)

        oldStakerRebateCap = await rebateStaking.getRebateCap(
          thirdParty.address
        )

        await rebateStaking
          .connect(deployer)
          .forceStakeTransfer(thirdParty.address, governance.address)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should copy the rebates to the new staker", async () => {
        expect(
          await rebateStaking.getRebateLength(governance.address)
        ).to.be.equal(2)
      })

      it("should copy the rebate amounts", async () => {
        const [, firstRebate] = await rebateStaking.getRebate(
          governance.address,
          0
        )
        const [, secondRebate] = await rebateStaking.getRebate(
          governance.address,
          1
        )
        expect(firstRebate).to.be.equal(treasuryFee)
        expect(secondRebate).to.be.equal(treasuryFee)
      })

      it("should move the stake to the new staker", async () => {
        expect(await rebateStaking.getStake(thirdParty.address)).to.be.equal(0)
        expect(await rebateStaking.getStake(governance.address)).to.be.equal(
          stakeAmount
        )
      })

      it("should move the rebate cap to the new staker", async () => {
        expect(oldStakerRebateCap).to.be.greaterThan(0)
        expect(
          await rebateStaking.getRebateCap(governance.address)
        ).to.be.equal(oldStakerRebateCap)
      })

      it("should leave the old staker without a rebate cap", async () => {
        // The old staker keeps no stake, so its cap is zero and the rebate
        // entries left behind on it cannot be spent.
        expect(
          await rebateStaking.getRebateCap(thirdParty.address)
        ).to.be.equal(0)
        expect(
          await rebateStaking.getAvailableRebate(thirdParty.address)
        ).to.be.equal(0)
      })

      it("should keep the copied rebates inside the new staker's cap", async () => {
        // The copied rebates still consume the new staker's rolling-window
        // budget, which is the point of copying them.
        const rebateCap = await rebateStaking.getRebateCap(governance.address)
        expect(
          await rebateStaking.getAvailableRebate(governance.address)
        ).to.be.equal(rebateCap - treasuryFee * 2n)
      })
    })
  })
})
