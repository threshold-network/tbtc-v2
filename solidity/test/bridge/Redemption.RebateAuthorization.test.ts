import { ethers, helpers } from "hardhat"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { expect } from "chai"
import type { RebateStaking, TestERC20, TestRedemption } from "../../typechain"
import bridgeFixture from "../fixtures/bridge"
import { to1e18 } from "../helpers/contract-test-helpers"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

/**
 * Coverage for the statement that the reservations scope leaves uncovered in
 * `Redemption.sol`:
 *
 * - `isRebateAuthorizedForRedemption` (line 278): the `return false` taken
 *   when the Bridge has no rebate staking contract configured.
 *
 * The statement is unreachable through `Redemption.requestRedemption`, because
 * the caller guards `self.rebateStaking != address(0)` before it calls the
 * function. The `TestRedemption` harness holds the library's own
 * `BridgeState.Storage` and calls the function directly, so the guard can be
 * exercised with the rebate staking contract unset.
 */
describe("Redemption - isRebateAuthorizedForRedemption", () => {
  let deployer: HardhatEthersSigner
  let thirdParty: HardhatEthersSigner
  let balanceOwner: HardhatEthersSigner
  let t: TestERC20
  let rebateStaking: RebateStaking
  let testRedemption: TestRedemption

  const stakeAmount = to1e18(100000000)

  before(async () => {
    ;({ deployer, thirdParty, t, rebateStaking } = await bridgeFixture())

    balanceOwner = thirdParty

    const factory = await ethers.getContractFactory("TestRedemption", deployer)
    testRedemption = await factory.deploy()
    await testRedemption.waitForDeployment()
  })

  describe("when the Bridge has no rebate staking contract", () => {
    before(async () => {
      await createSnapshot()

      await testRedemption.setRebateStaking(ethers.ZeroAddress)
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when the balance owner is the redeemer", () => {
      it("should authorize the redemption", async () => {
        expect(
          await testRedemption.isRebateAuthorizedForRedemption(
            thirdParty.address,
            thirdParty.address
          )
        ).to.be.equal(true)
      })
    })

    context("when the balance owner is not the redeemer", () => {
      it("should not authorize the redemption", async () => {
        // A callback redemption with no rebate staking contract configured
        // cannot be credited with rebate accounting, so the check fails soft
        // and the redemption proceeds with the full treasury fee.
        expect(
          await testRedemption.isRebateAuthorizedForRedemption(
            balanceOwner.address,
            deployer.address
          )
        ).to.be.equal(false)
      })
    })
  })

  describe("when the Bridge has a rebate staking contract", () => {
    before(async () => {
      await createSnapshot()

      await t.connect(deployer).mint(thirdParty.address, stakeAmount)
      await t.connect(thirdParty).approve(rebateStaking.target, stakeAmount)
      await rebateStaking.connect(thirdParty).stake(stakeAmount)

      await testRedemption.setRebateStaking(rebateStaking.target)
    })

    after(async () => {
      await restoreSnapshot()
    })

    context("when the redeemer has authorized the balance owner", () => {
      before(async () => {
        await createSnapshot()

        await rebateStaking
          .connect(thirdParty)
          .setRebateAuthorization(balanceOwner.address, true)
      })

      after(async () => {
        await restoreSnapshot()
      })

      it("should authorize the redemption", async () => {
        expect(
          await testRedemption.isRebateAuthorizedForRedemption(
            balanceOwner.address,
            thirdParty.address
          )
        ).to.be.equal(true)
      })
    })

    context("when the redeemer has not authorized the balance owner", () => {
      it("should not authorize the redemption", async () => {
        expect(
          await testRedemption.isRebateAuthorizedForRedemption(
            balanceOwner.address,
            thirdParty.address
          )
        ).to.be.equal(false)
      })
    })
  })
})
