import { ethers, helpers } from "hardhat"
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { expect } from "chai"
import type { TestRedemptionWatchtower } from "../../typechain"

const { createSnapshot, restoreSnapshot } = helpers.snapshot

/**
 * Coverage for the statement that the reservations scope leaves uncovered in
 * `RedemptionWatchtower.sol`:
 *
 * - `_redemptionDelay` (line 441): the `revert("No delay for given objections
 *   count")` taken when the objections count is above the required count.
 *
 * The statement is unreachable through `raiseObjection` and
 * `getRedemptionDelay`: the production callers can only ever pass an
 * objections count of 0, 1 or 2, because the third objection finalizes the
 * veto and the veto deletes the pending redemption. The
 * `TestRedemptionWatchtower` harness exposes the internal function so the
 * unreachable arm can be exercised directly.
 */
describe("RedemptionWatchtower - _redemptionDelay", () => {
  let deployer: HardhatEthersSigner
  let testWatchtower: TestRedemptionWatchtower

  const defaultDelay = 2 * 60 * 60
  const levelOneDelay = 8 * 60 * 60
  const levelTwoDelay = 24 * 60 * 60
  const waivedAmountLimit = 0
  const requestedAmount = 10n

  before(async () => {
    // The signer comes from the provider's default account: the suite
    // deploys only the harness, so it needs no fixture and no named
    // signer.
    const [signer] = await ethers.getSigners()
    deployer = signer

    const factory = await ethers.getContractFactory(
      "TestRedemptionWatchtower",
      deployer
    )
    testWatchtower = await factory.deploy()
    await testWatchtower.waitForDeployment()
  })

  describe("when the objections count is at or below the required count", () => {
    before(async () => {
      await createSnapshot()

      await testWatchtower.setDelayParameters(
        defaultDelay,
        levelOneDelay,
        levelTwoDelay,
        waivedAmountLimit
      )
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should return the default delay for no objections", async () => {
      expect(
        await testWatchtower.redemptionDelay(0, requestedAmount)
      ).to.be.equal(defaultDelay)
    })

    it("should return the level-one delay for one objection", async () => {
      expect(
        await testWatchtower.redemptionDelay(1, requestedAmount)
      ).to.be.equal(levelOneDelay)
    })

    it("should return the level-two delay for two objections", async () => {
      expect(
        await testWatchtower.redemptionDelay(2, requestedAmount)
      ).to.be.equal(levelTwoDelay)
    })
  })

  describe("when the objections count is above the required count", () => {
    before(async () => {
      await createSnapshot()

      await testWatchtower.setDelayParameters(
        defaultDelay,
        levelOneDelay,
        levelTwoDelay,
        waivedAmountLimit
      )
    })

    after(async () => {
      await restoreSnapshot()
    })

    it("should revert", async () => {
      // Three objections finalize the veto, so the production paths never
      // reach the delay computation with this count.
      await expect(
        testWatchtower.redemptionDelay(3, requestedAmount)
      ).to.be.revertedWith("No delay for given objections count")
    })
  })
})
