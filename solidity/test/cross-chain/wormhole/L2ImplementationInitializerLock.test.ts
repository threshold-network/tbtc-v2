import { ethers } from "hardhat"
import chai, { expect } from "chai"
import { smock } from "@defi-wonderland/smock"

chai.use(smock.matchers)

// Regression coverage for the audit fix that adds a
// `_disableInitializers()` constructor to the upgradeable L2 logic
// contracts. Without it, anyone could call `initialize` on the raw
// implementation and take ownership of the (otherwise unused) logic
// instance. The constructor only affects implementations deployed
// after the fix lands; this test instantiates the contract directly
// (not behind a proxy) so the lock must fire on every `initialize`
// attempt.
describe("L2 implementation initializer lock (regression)", () => {
  describe("L2WormholeGateway", () => {
    it("should revert initialize on the raw implementation", async () => {
      const factory = await ethers.getContractFactory("L2WormholeGateway")
      const impl = await factory.deploy()
      await impl.deployed()

      const bridge = ethers.Wallet.createRandom().address
      const bridgeToken = ethers.Wallet.createRandom().address
      const tbtc = ethers.Wallet.createRandom().address

      await expect(impl.initialize(bridge, bridgeToken, tbtc)).to.be
        .revertedWith("Initializable: contract is already initialized")
    })
  })

  describe("L2TBTC", () => {
    it("should revert initialize on the raw implementation", async () => {
      const factory = await ethers.getContractFactory("L2TBTC")
      const impl = await factory.deploy()
      await impl.deployed()

      await expect(impl.initialize("L2 TBTC", "L2TBTC")).to.be.revertedWith(
        "Initializable: contract is already initialized"
      )
    })
  })

  describe("L2BTCRedeemerWormhole", () => {
    it("should revert initialize on the raw implementation", async () => {
      const factory = await ethers.getContractFactory("L2BTCRedeemerWormhole")
      const impl = await factory.deploy()
      await impl.deployed()

      const tbtc = ethers.Wallet.createRandom().address
      const gateway = ethers.Wallet.createRandom().address
      const l1Redeemer = ethers.utils.hexZeroPad("0x1234", 32)

      await expect(impl.initialize(tbtc, gateway, l1Redeemer)).to.be
        .revertedWith("Initializable: contract is already initialized")
    })
  })
})
